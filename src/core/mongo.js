'use strict';
// One MongoDB connection (a MongoClient) and everything the extension does with it.
// Built as its own bundle (dist/mongo.js) and loaded on the first connect, so activation stays small.
//
// Network: only to the server in the connection string. The client opens on the first action, closes after
// zovoMongo.idleCloseMinutes without an action, and opens again on the next one. While open, the driver's
// server monitor sends one "hello" a minute (heartbeatFrequencyMS 60000, polling mode); nothing else runs.
//
// Precision: reads use promoteValues: false, promoteLongs: false and bsonRegExp: true, so Int64, Decimal128,
// Int32 and Double stay BSON objects. Writes take canonical Extended JSON and turn it into BSON with
// EJSON.deserialize({ relaxed: false }); a value never passes through a JavaScript number. Update filters are
// { _id: <the _id exactly as read> }.

const fs = require('fs');
const crypto = require('crypto');
const { MongoClient, BSON } = require('mongodb');
const { toWire, wireSize, hasMarkers, relax, GRID_LIMITS, NO_LIMITS } = require('./wire');
const { friendly, isConnectionLost } = require('./errors');
const { samplePaths, plain, format, typeOf } = require('./shell');
const { jsonValues, jsonLines, csvRecords, csvDoc, csvCell, writer } = require('./files');

const { EJSON } = BSON;
const READ = { promoteValues: false, promoteLongs: false, bsonRegExp: true, promoteBuffers: false };

function toBson(w, what = 'value') {
  if (hasMarkers(w)) throw Object.assign(new Error(`This ${what} was shortened for display and cannot be written back. Open the full document first.`), { friendly: true });
  return EJSON.deserialize(w, { relaxed: false });
}

/** Write stages: $out and $merge. A pipeline with one writes to a collection. */
function writeStage(pipeline) {
  const s = pipeline.find((st) => st && (st.$out !== undefined || st.$merge !== undefined));
  if (!s) return null;
  const v = s.$out !== undefined ? s.$out : s.$merge;
  const target = typeof v === 'string' ? v : (v && (v.into || v.coll)) ? (typeof (v.into || v.coll) === 'string' ? (v.into || v.coll) : JSON.stringify(v.into || v.coll)) : '?';
  return { stage: s.$out !== undefined ? '$out' : '$merge', target };
}

/** Field-path text for $set: a.b.0.c. Null when a key cannot be written with dots ($ prefix, dot inside). */
function dotted(path) {
  for (const p of path) if (typeof p === 'string' && (p.includes('.') || p.startsWith('$') || p === '')) return null;
  return path.join('.');
}

class MongoSession {
  /**
   * cfg: { uri, user, authSource, tls ('', 'on', 'off'), caText, tlsInsecure, replicaSet, directConnection ('', 'yes', 'no'),
   *        readPreference, timeoutMs, idleMs, queryTimeoutMs, name }
   */
  constructor(cfg, password) {
    this.cfg = cfg;
    this.password = password || '';
    this.client = null;
    this.opening = null;
    this.idleTimer = null;
    this.active = 0;
    this.onDrop = null; // (reason: 'idle' | 'lost', err) => void
    this.onState = null; // (open: boolean) => void
    this.info = null;
  }

  options() {
    const c = this.cfg;
    const o = {
      serverSelectionTimeoutMS: c.timeoutMs || 10000,
      connectTimeoutMS: c.timeoutMs || 10000,
      heartbeatFrequencyMS: 60000,
      serverMonitoringMode: 'poll',
      maxPoolSize: 4,
      minPoolSize: 0,
      maxIdleTimeMS: 120000,
      appName: 'zovo-mongodb-client',
      retryWrites: undefined,
    };
    delete o.retryWrites;
    if (c.user) o.auth = { username: c.user, password: this.password };
    if (c.authSource) o.authSource = c.authSource;
    if (c.tls === 'on') o.tls = true;
    if (c.tls === 'off') o.tls = false;
    if (c.caText) { o.tls = true; o.ca = c.caText; }
    if (c.tlsInsecure) { o.tls = true; o.tlsAllowInvalidCertificates = true; o.tlsAllowInvalidHostnames = true; }
    if (c.replicaSet) o.replicaSet = c.replicaSet;
    if (c.directConnection === 'yes') o.directConnection = true;
    if (c.directConnection === 'no') o.directConnection = false;
    if (c.readPreference) o.readPreference = c.readPreference;
    return o;
  }

  /** Connect (once) and return { version, topology, setName }. */
  async open() {
    if (this.client) { this.touch(); return this.info; }
    if (this.opening) return this.opening;
    this.opening = (async () => {
      let client;
      try {
        client = new MongoClient(this.cfg.uri, this.options());
        await client.connect();
        const admin = client.db('admin');
        let version = '';
        let hello = {};
        try { hello = await admin.command({ hello: 1 }); } catch { hello = {}; }
        try { version = (await admin.command({ buildInfo: 1 })).version || ''; } catch { version = ''; }
        this.client = client;
        this.info = { version, setName: hello.setName || '', primary: hello.isWritablePrimary !== false, msg: hello.msg || '' };
        client.on('topologyClosed', () => { if (this.client === client) this.client = null; });
        this.touch();
        if (this.onState) this.onState(true);
        return this.info;
      } catch (e) {
        if (client) client.close(true).catch(() => {});
        throw friendly(e, this.cfg, 'connect');
      } finally {
        this.opening = null;
      }
    })();
    return this.opening;
  }

  touch() {
    clearTimeout(this.idleTimer);
    const ms = this.cfg.idleMs === undefined ? 10 * 60 * 1000 : this.cfg.idleMs;
    if (!ms) return;
    this.idleTimer = setTimeout(() => {
      if (this.active > 0) { this.touch(); return; }
      this.close().then(() => { if (this.onDrop) this.onDrop('idle'); });
    }, ms);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  async close() {
    clearTimeout(this.idleTimer);
    const c = this.client;
    this.client = null;
    this.info = null;
    if (c) {
      await c.close(true).catch(() => {});
      if (this.onState) this.onState(false);
    }
  }

  isOpen() { return !!this.client; }

  /** Run fn(client) with the idle timer held, mapping errors and dropping the client when the connection is lost. */
  async use(fn) {
    await this.open();
    this.active++;
    try {
      return await fn(this.client);
    } catch (e) {
      if (isConnectionLost(e)) {
        await this.close();
        const f = friendly(e, this.cfg);
        const out = new Error(`The connection to ${this.cfg.name || 'the server'} was lost (${f.message.replace(/\.$/, '')}). It reconnects on your next action.`);
        out.friendly = true;
        out.lost = true;
        if (this.onDrop) this.onDrop('lost', out);
        throw out;
      }
      throw friendly(e, this.cfg);
    } finally {
      this.active--;
      this.touch();
    }
  }

  // ---------- browse ----------

  async databases() {
    return this.use(async (c) => {
      const r = await c.db('admin').admin().listDatabases({ nameOnly: false, authorizedDatabases: true });
      return r.databases.map((d) => ({ name: d.name, size: Number(d.sizeOnDisk || 0), empty: !!d.empty })).sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  async collections(db) {
    return this.use(async (c) => {
      const list = await c.db(db).listCollections({}, { nameOnly: false, authorizedCollections: true }).toArray();
      return list.map((x) => ({ name: x.name, type: x.type || 'collection', readOnly: !!(x.info && x.info.readOnly), viewOn: x.options && x.options.viewOn, timeseries: !!(x.options && x.options.timeseries) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  async estimatedCount(db, coll) {
    return this.use((c) => c.db(db).collection(coll).estimatedDocumentCount({ maxTimeMS: 5000 }));
  }

  async indexes(db, coll) {
    return this.use(async (c) => {
      const list = await c.db(db).collection(coll).listIndexes().toArray();
      return list.map((i) => ({ name: i.name, key: toWire(i.key), unique: !!i.unique, sparse: !!i.sparse, ttl: i.expireAfterSeconds !== undefined ? Number(i.expireAfterSeconds) : null, partial: i.partialFilterExpression ? toWire(i.partialFilterExpression) : null, hidden: !!i.hidden }));
    });
  }

  // ---------- read ----------

  /**
   * A pager over find() or aggregate(): next(n) returns the next documents (wire, cut for the grid) without
   * ever reading the whole result. If the connection closed in between (idle close), it reopens with $skip.
   */
  pager(db, coll, q) {
    const session = this;
    const comment = `zovo:${crypto.randomUUID()}`;
    let cursor = null;
    let fetched = 0;
    let done = false;
    let cancelled = false;
    const make = (c, n) => {
      const col = c.db(db).collection(coll);
      const batchSize = Math.min(Math.max(n || 50, 1), 1000);
      const maxTimeMS = q.maxTimeMS === undefined ? session.cfg.queryTimeoutMs : q.maxTimeMS;
      if (q.pipeline) {
        const p = q.pipeline.map((s) => toBson(s, 'pipeline'));
        if (fetched) p.push({ $skip: fetched });
        return col.aggregate(p, { ...READ, maxTimeMS: maxTimeMS || undefined, comment, allowDiskUse: true, batchSize });
      }
      const opts = { ...READ, comment, maxTimeMS: maxTimeMS || undefined, batchSize };
      if (q.projection && Object.keys(q.projection).length) opts.projection = toBson(q.projection, 'projection');
      if (q.sort && Object.keys(q.sort).length) opts.sort = toBson(q.sort, 'sort');
      const skip = (q.skip || 0) + fetched;
      if (skip) opts.skip = skip;
      if (q.limit) opts.limit = Math.max(0, q.limit - fetched) || -1;
      return col.find(toBson(q.filter || {}, 'filter'), opts);
    };
    return {
      comment,
      get fetched() { return fetched; },
      get done() { return done; },
      async next(n, budget = 6 * 1024 * 1024) {
        if (done) return { docs: [], done: true, cut: 0 };
        return session.use(async (c) => {
          if (!cursor || cursor.closed || cursor.client !== c) cursor = make(c, n);
          const docs = [];
          let bytes = 0;
          let cut = 0;
          try {
            while (docs.length < n && bytes < budget) {
              if (cancelled) break;
              const d = await cursor.next();
              if (!d) { done = true; break; }
              const stats = {};
              const w = toWire(d, GRID_LIMITS, stats);
              if (stats.cut) cut++;
              bytes += wireSize(w);
              docs.push({ w, cut: !!stats.cut });
              fetched++;
              if (q.limit && fetched >= q.limit) { done = true; break; }
            }
          } catch (e) {
            cursor = null;
            if (cancelled) { const x = new Error('The query was cancelled.'); x.friendly = true; x.cancelled = true; throw x; }
            throw e;
          }
          if (done) { await cursor.close().catch(() => {}); cursor = null; }
          return { docs, done, cut, bytes };
        });
      },
      async cancel() {
        cancelled = true;
        await session.killByComment(comment);
        if (cursor) await cursor.close().catch(() => {});
        cursor = null;
      },
      async close() {
        done = true;
        if (cursor) await cursor.close().catch(() => {});
        cursor = null;
      },
    };
  }

  /** Stop a running command by its comment: $currentOp + killOp. Falls back to closing the client. */
  async killByComment(comment) {
    if (!this.client) return 'closed';
    try {
      const admin = this.client.db('admin');
      const ops = await admin.aggregate([{ $currentOp: { allUsers: false, idleConnections: false, localOps: false } }, { $match: { $or: [{ 'command.comment': comment }, { 'cursor.originatingCommand.comment': comment }] } }], { maxTimeMS: 5000 }).toArray();
      for (const op of ops) {
        if (op.opid !== undefined) await admin.command({ killOp: 1, op: op.opid }).catch(() => {});
      }
      if (ops.length) return 'killed';
    } catch { /* $currentOp not allowed: fall through */ }
    return 'none';
  }

  /** One document, whole (no cut), by its _id. */
  async fullDoc(db, coll, idWire) {
    return this.use(async (c) => {
      const d = await c.db(db).collection(coll).findOne({ _id: toBson(idWire, '_id') }, READ);
      return d ? toWire(d, NO_LIMITS) : null;
    });
  }

  /** Field paths and how often they appear in a sample of up to n documents ($sample, else the first n). */
  async samplePaths(db, coll, n = 100) {
    return this.use(async (c) => {
      const col = c.db(db).collection(coll);
      let docs;
      try { docs = await col.aggregate([{ $sample: { size: n } }], { ...READ, maxTimeMS: 10000 }).toArray(); } catch { docs = await col.find({}, { ...READ, limit: n, maxTimeMS: 10000 }).toArray(); }
      const w = docs.map((d) => toWire(d, GRID_LIMITS));
      return { n: w.length, paths: samplePaths(w) };
    });
  }

  async sampleDocs(db, coll, n) {
    return this.use(async (c) => {
      const col = c.db(db).collection(coll);
      let docs;
      try { docs = await col.aggregate([{ $sample: { size: n } }], { ...READ, maxTimeMS: 30000, allowDiskUse: true }).toArray(); } catch { docs = await col.find({}, { ...READ, limit: n, maxTimeMS: 30000 }).toArray(); }
      return docs.map((d) => toWire(d, { str: 200, arr: 50, keys: 500, bin: 64 }));
    });
  }

  /** The first n documents after each stage of a pipeline (write stages are not run). */
  async stagePreview(db, coll, pipeline, n = 20, onStage) {
    return this.use(async (c) => {
      const col = c.db(db).collection(coll);
      const out = [];
      for (let i = 0; i < pipeline.length; i++) {
        const st = pipeline[i];
        const name = Object.keys(st)[0];
        if (name === '$out' || name === '$merge') { out.push({ stage: i, name, skipped: true, docs: [], note: `${name} writes to a collection, so the preview does not run it.` }); continue; }
        const comment = `zovo:${crypto.randomUUID()}`;
        if (onStage) onStage(i, comment);
        const t0 = Date.now();
        try {
          const p = pipeline.slice(0, i + 1).map((s) => toBson(s, 'pipeline'));
          p.push({ $limit: n });
          const docs = await col.aggregate(p, { ...READ, maxTimeMS: this.cfg.queryTimeoutMs || undefined, comment, allowDiskUse: true }).toArray();
          out.push({ stage: i, name, docs: docs.map((d) => toWire(d, GRID_LIMITS)), ms: Date.now() - t0 });
        } catch (e) {
          out.push({ stage: i, name, error: friendly(e, this.cfg).message, docs: [] });
          if (isConnectionLost(e)) throw e;
          break;
        }
      }
      return out;
    });
  }

  async explain(db, coll, q) {
    return this.use(async (c) => {
      const col = c.db(db).collection(coll);
      const comment = `zovo:${crypto.randomUUID()}`;
      const maxTimeMS = this.cfg.queryTimeoutMs || undefined;
      let r;
      if (q.pipeline) {
        r = await col.aggregate(q.pipeline.filter((s) => !('$out' in s) && !('$merge' in s)).map((s) => toBson(s, 'pipeline')), { maxTimeMS, comment, allowDiskUse: true }).explain('executionStats');
      } else {
        const opts = { maxTimeMS, comment };
        if (q.projection && Object.keys(q.projection).length) opts.projection = toBson(q.projection, 'projection');
        if (q.sort && Object.keys(q.sort).length) opts.sort = toBson(q.sort, 'sort');
        if (q.skip) opts.skip = q.skip;
        if (q.limit) opts.limit = q.limit;
        r = await col.find(toBson(q.filter || {}, 'filter'), opts).explain('executionStats');
      }
      return toWire(r, { str: 20000, arr: 500, keys: 2000, bin: 64 });
    });
  }

  /** Every document of a query, whole (no cut), as wire values: for the collection compare. */
  async* iterate(db, coll, q = {}) {
    await this.open();
    this.active++;
    const opts = { ...READ, batchSize: 1000 };
    if (q.sort) opts.sort = toBson(q.sort, 'sort');
    const cur = this.client.db(db).collection(coll).find(toBson(q.filter || {}, 'filter'), opts);
    try {
      for await (const d of cur) yield toWire(d, NO_LIMITS);
    } catch (e) {
      throw friendly(e, this.cfg);
    } finally {
      this.active--;
      this.touch();
      await cur.close().catch(() => {});
    }
  }

  // ---------- write ----------

  /** Set one field (path = keys and array indexes) of the document with this _id. */
  async setField(db, coll, idWire, path, valueWire) {
    return this.use(async (c) => {
      const col = c.db(db).collection(coll);
      const filter = { _id: toBson(idWire, '_id') };
      const value = toBson({ v: valueWire }, 'value').v;
      const p = dotted(path);
      let r;
      if (p !== null) r = await col.updateOne(filter, { $set: { [p]: value } });
      else if (path.length === 1) {
        // A top-level name with a dot or a $ prefix: $setField in a pipeline update (MongoDB 5.0+).
        r = await col.updateOne(filter, [{ $replaceWith: { $setField: { field: path[0], input: '$$ROOT', value: { $literal: value } } } }]);
      } else throw Object.assign(new Error('This field name has a dot or starts with $, so it cannot be edited inside a nested document. Edit the whole document as JSON instead.'), { friendly: true });
      return { matched: r.matchedCount, modified: r.modifiedCount };
    });
  }

  async unsetField(db, coll, idWire, path) {
    return this.use(async (c) => {
      const p = dotted(path);
      if (p === null) throw Object.assign(new Error('This field name has a dot or starts with $. Edit the whole document as JSON instead.'), { friendly: true });
      const r = await c.db(db).collection(coll).updateOne({ _id: toBson(idWire, '_id') }, { $unset: { [p]: '' } });
      return { matched: r.matchedCount, modified: r.modifiedCount };
    });
  }

  async replaceDoc(db, coll, idWire, docWire) {
    return this.use(async (c) => {
      const doc = toBson(docWire, 'document');
      const id = toBson(idWire, '_id');
      if (doc._id !== undefined && EJSON.stringify(doc._id, { relaxed: false }) !== EJSON.stringify(id, { relaxed: false })) throw Object.assign(new Error('The _id cannot change. Insert a new document instead.'), { friendly: true });
      const r = await c.db(db).collection(coll).replaceOne({ _id: id }, doc);
      return { matched: r.matchedCount, modified: r.modifiedCount };
    });
  }

  async insert(db, coll, docsWire) {
    return this.use(async (c) => {
      const docs = docsWire.map((d) => toBson(d, 'document'));
      const r = await c.db(db).collection(coll).insertMany(docs, { ordered: true });
      return { inserted: r.insertedCount, ids: Object.values(r.insertedIds).map((x) => toWire(x)) };
    });
  }

  async deleteIds(db, coll, idsWire) {
    return this.use(async (c) => {
      const ids = idsWire.map((x) => toBson(x, '_id'));
      const r = await c.db(db).collection(coll).deleteMany({ _id: { $in: ids } });
      return { deleted: r.deletedCount };
    });
  }

  async deleteMatching(db, coll, filterWire) {
    return this.use(async (c) => ({ deleted: (await c.db(db).collection(coll).deleteMany(toBson(filterWire, 'filter'))).deletedCount }));
  }

  async updateMatching(db, coll, filterWire, updateWire) {
    return this.use(async (c) => {
      const u = toBson(updateWire, 'update');
      const r = await c.db(db).collection(coll).updateMany(toBson(filterWire, 'filter'), u);
      return { matched: r.matchedCount, modified: r.modifiedCount };
    });
  }

  async countMatching(db, coll, filterWire) {
    return this.use((c) => c.db(db).collection(coll).countDocuments(toBson(filterWire, 'filter'), { maxTimeMS: 15000 }));
  }

  async createIndex(db, coll, keysWire, options) {
    return this.use((c) => c.db(db).collection(coll).createIndex(toBson(keysWire, 'index keys'), options));
  }

  async dropIndex(db, coll, name) {
    return this.use((c) => c.db(db).collection(coll).dropIndex(name));
  }

  async createCollection(db, name) {
    return this.use((c) => c.db(db).createCollection(name));
  }

  async dropCollection(db, coll) {
    return this.use((c) => c.db(db).collection(coll).drop());
  }

  async dropDatabase(db) {
    return this.use((c) => c.db(db).dropDatabase());
  }

  // ---------- export and import ----------

  /**
   * Stream a query to a file. format: 'json' (array of relaxed Extended JSON), 'jsonl', 'csv'.
   * opts: { onProgress(n), shouldStop() }. Returns { count, stopped }.
   */
  async exportTo(db, coll, q, format, file, opts = {}) {
    return this.use(async (c) => {
      const col = c.db(db).collection(coll);
      const comment = `zovo:${crypto.randomUUID()}`;
      const mk = () => {
        if (q.pipeline) return col.aggregate(q.pipeline.map((s) => toBson(s, 'pipeline')), { ...READ, comment, allowDiskUse: true, batchSize: 1000 });
        const o = { ...READ, comment, batchSize: 1000 };
        if (q.projection && Object.keys(q.projection).length) o.projection = toBson(q.projection, 'projection');
        if (q.sort && Object.keys(q.sort).length) o.sort = toBson(q.sort, 'sort');
        if (q.skip) o.skip = q.skip;
        if (q.limit) o.limit = q.limit;
        return col.find(toBson(q.filter || {}, 'filter'), o);
      };
      let columns = null;
      if (format === 'csv') {
        const seen = new Map();
        const head = mk();
        let k = 0;
        for await (const d of head) {
          collectLeafPaths(toWire(d, { str: 64, arr: 0, keys: 1000, bin: 0 }), '', 0, seen);
          if (++k >= 1000) break;
        }
        await head.close().catch(() => {});
        columns = [...seen.keys()].slice(0, 1000);
      }
      const out = fs.createWriteStream(file, { encoding: 'utf8' });
      const write = writer(out);
      const done = new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); });
      const cur = mk();
      let count = 0;
      let stopped = false;
      try {
        if (format === 'json') await write('[');
        if (format === 'csv') await write(columns.map(csvCell).join(',') + '\n');
        for await (const d of cur) {
          if (opts.shouldStop && opts.shouldStop()) { stopped = true; break; }
          const w = toWire(d, NO_LIMITS);
          if (format === 'csv') await write(columns.map((p) => csvCell(csvText(getDotted(w, p)))).join(',') + '\n');
          else if (format === 'jsonl') await write(JSON.stringify(relax(w)) + '\n');
          else await write((count ? ',\n' : '\n') + JSON.stringify(relax(w)));
          count++;
          if (opts.onProgress && count % 1000 === 0) opts.onProgress(count);
        }
        if (format === 'json') await write(count ? '\n]\n' : ']\n');
      } finally {
        await cur.close().catch(() => {});
        out.end();
      }
      await done;
      if (opts.onProgress) opts.onProgress(count);
      return { count, stopped, columns: columns ? columns.length : undefined };
    });
  }

  /**
   * Import a file in batches of 1,000 (ordered inserts). format: 'json', 'jsonl', 'csv'.
   * opts: { onProgress(docs, bytes), shouldStop() }. A bad value stops the import with its line number;
   * documents before it stay inserted (the message says how many).
   */
  async importFrom(db, coll, file, format, opts = {}) {
    let bytes = 0;
    const onBytes = (n) => { bytes += n; };
    let inserted = 0;
    let batch = [];
    let lastLine = 0;
    const flush = async () => {
      if (!batch.length) return;
      const docs = batch;
      batch = [];
      await this.use((c) => c.db(db).collection(coll).insertMany(docs, { ordered: true }));
      inserted += docs.length;
      if (opts.onProgress) opts.onProgress(inserted, bytes);
    };
    const bad = (line, m) => Object.assign(new Error(`Line ${line}: ${m}. ${inserted.toLocaleString('en-US')} documents were imported before it; nothing after it.`), { friendly: true, line, inserted });
    try {
      if (format === 'csv') {
        let header = null;
        for await (const r of csvRecords(file, onBytes)) {
          lastLine = r.line;
          if (!header) { header = r.fields.map((h) => h.trim()); continue; }
          if (r.fields.length === 1 && r.fields[0] === '') continue;
          batch.push(toBson(csvDoc(header, r.fields)));
          if (batch.length >= 1000) await flush();
          if (opts.shouldStop && opts.shouldStop()) break;
        }
      } else {
        const it = format === 'jsonl' ? jsonLines(file, onBytes) : jsonValues(file, onBytes);
        for await (const v of it) {
          lastLine = v.line;
          let doc;
          try { doc = EJSON.parse(v.text, { relaxed: false }); } catch (e) { throw bad(v.line, `not valid Extended JSON (${String(e.message).replace(/\s+/g, ' ').slice(0, 160)})`); }
          if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc._bsontype) throw bad(v.line, 'each value must be a document in braces');
          const badDate = findInvalidDate(doc);
          if (badDate) throw bad(v.line, `the field ${badDate} has a $date that is not a date`);
          batch.push(doc);
          if (batch.length >= 1000) await flush();
          if (opts.shouldStop && opts.shouldStop()) break;
        }
      }
      await flush();
    } catch (e) {
      if (e.line !== undefined && e.inserted !== undefined) throw e;
      if (e.line !== undefined) throw bad(e.line, e.message.replace(/^Line \d+: /, ''));
      if (e.friendly || e.lost) { const x = new Error(`${e.message} ${inserted.toLocaleString('en-US')} documents were imported before the error (near line ${lastLine}).`); x.friendly = true; throw x; }
      throw friendly(e, this.cfg);
    }
    return { inserted, bytes };
  }
}

function findInvalidDate(v, pre = '') {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? (pre || '(value)') : null;
  if (!v || typeof v !== 'object' || v._bsontype) return null;
  for (const k of Object.keys(v)) { const r = findInvalidDate(v[k], pre ? `${pre}.${k}` : k); if (r) return r; }
  return null;
}

function collectLeafPaths(w, pre, depth, seen) {
  if (w === null || typeof w !== 'object' || Array.isArray(w) || typeOf(w) !== 'Object' || depth > 3) { if (pre) seen.set(pre, true); return; }
  const keys = Object.keys(w);
  if (!keys.length && pre) { seen.set(pre, true); return; }
  for (const k of keys) collectLeafPaths(w[k], pre ? `${pre}.${k}` : k, depth + 1, seen);
}

function getDotted(w, p) {
  let cur = w;
  for (const k of p.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function csvText(v) {
  if (v === undefined || v === null) return '';
  const t = typeOf(v);
  if (t === 'Object' || t === 'Array') return format(v, { indent: 0 });
  return plain(v);
}

module.exports = { MongoSession, writeStage, toBson, dotted, EJSON };
