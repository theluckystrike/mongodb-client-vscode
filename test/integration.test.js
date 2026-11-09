'use strict';
// Runs against a real server when ZOVO_MONGO_URI is set (with ZOVO_MONGO_USER / ZOVO_MONGO_PASS), for example the
// NB1 gate container: ZOVO_MONGO_URI=mongodb://127.0.0.1:27047/ ZOVO_MONGO_USER=<user> ZOVO_MONGO_PASS=<password>.
// Expects the seeded databases (NB1-scripts/seed.js). Writes only to the database zovo_it, and drops it at the end.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MongoSession, writeStage } = require('../src/core/mongo');
const shell = require('../src/core/shell');

const URI = process.env.ZOVO_MONGO_URI;
const skip = !URI && 'set ZOVO_MONGO_URI to run the integration tests';
const DB = 'zovo_it';
const WORK = process.env.ZOVO_WORK || path.join(os.homedir(), 'zovo-mongodb-client-work', 'it');
const cfg = (extra = {}) => ({ uri: URI, user: process.env.ZOVO_MONGO_USER || '', authSource: 'admin', name: 'it', timeoutMs: 5000, idleMs: 0, queryTimeoutMs: 60000, ...extra });
let s;

test.before(async () => {
  if (skip) return;
  fs.mkdirSync(WORK, { recursive: true });
  s = new MongoSession(cfg(), process.env.ZOVO_MONGO_PASS || '');
  await s.open();
  await s.dropDatabase(DB).catch(() => {});
});
test.after(async () => {
  if (skip) return;
  await s.dropDatabase(DB).catch(() => {});
  await s.close();
  fs.rmSync(WORK, { recursive: true, force: true });
});

test('precision gate: edit the second of two Long _ids next to 2^53, only it changes', { skip }, async () => {
  await s.insert(DB, 'longids', [shell.parse('{ _id: NumberLong("9007199254740992"), note: "unchanged" }'), shell.parse('{ _id: NumberLong("9007199254740993"), note: "unchanged" }')]);
  const p = s.pager(DB, 'longids', { filter: {}, sort: shell.parse('{ _id: 1 }') });
  const { docs } = await p.next(10);
  assert.strictEqual(docs.length, 2);
  assert.deepStrictEqual(docs[1].w._id, { $numberLong: '9007199254740993' });
  const r = await s.setField(DB, 'longids', docs[1].w._id, ['note'], shell.fromText('edited', 'String'));
  assert.deepStrictEqual(r, { matched: 1, modified: 1 });
  const after = (await s.pager(DB, 'longids', { filter: {}, sort: shell.parse('{ _id: 1 }') }).next(10)).docs.map((d) => [d.w._id.$numberLong, d.w.note]);
  assert.deepStrictEqual(after, [['9007199254740992', 'unchanged'], ['9007199254740993', 'edited']]);
});

test('nested and array edits keep types; dotted top-level names use $setField', { skip }, async () => {
  await s.insert(DB, 'nested', [shell.parse('{ _id: 1, a: { b: [ { c: NumberDecimal("1.10") }, 2 ] }, "x.y": "dotted", big: NumberLong("123") }')]);
  await s.setField(DB, 'nested', { $numberInt: '1' }, ['a', 'b', 0, 'c'], shell.fromText('2.20', 'Decimal128'));
  await s.setField(DB, 'nested', { $numberInt: '1' }, ['x.y'], shell.fromText('still dotted', 'String'));
  await s.setField(DB, 'nested', { $numberInt: '1' }, ['big'], shell.fromText('9223372036854775807', 'Int64'));
  await s.setField(DB, 'nested', { $numberInt: '1' }, ['added'], shell.fromText('{ when: ISODate("2024-01-01"), n: 5.0 }', 'Object'));
  const d = await s.fullDoc(DB, 'nested', { $numberInt: '1' });
  assert.deepStrictEqual(d.a.b[0].c, { $numberDecimal: '2.20' });
  assert.deepStrictEqual(d.a.b[1], { $numberInt: '2' });
  assert.strictEqual(d['x.y'], 'still dotted');
  assert.deepStrictEqual(d.big, { $numberLong: '9223372036854775807' });
  assert.deepStrictEqual(d.added.n, { $numberDouble: '5.0' });
  await s.unsetField(DB, 'nested', { $numberInt: '1' }, ['added']);
  assert.strictEqual((await s.fullDoc(DB, 'nested', { $numberInt: '1' })).added, undefined);
  // replace keeps the _id and refuses a changed one
  await s.replaceDoc(DB, 'nested', { $numberInt: '1' }, shell.parse('{ _id: 1, only: true }'));
  assert.deepStrictEqual(await s.fullDoc(DB, 'nested', { $numberInt: '1' }), { _id: { $numberInt: '1' }, only: true });
  await assert.rejects(s.replaceDoc(DB, 'nested', { $numberInt: '1' }, shell.parse('{ _id: 2 }')), /_id cannot change/);
  // a value cut for display is never written back
  await assert.rejects(s.setField(DB, 'nested', { $numberInt: '1' }, ['t'], { $zovoTrunc: { s: 'x', n: 9 } }), /shortened for display/);
});

test('Unicode, deep and mixed-type data read and print', { skip }, async () => {
  const u = (await s.pager('edge', 'unicode', { filter: {} }).next(10)).docs;
  assert.strictEqual(u[0].w['名前'], '山田 太郎');
  assert.strictEqual(u[0].w['emoji 😀'], '🎉');
  assert.strictEqual(u[0].w['a.b'], 'dotted name');
  const deep = (await s.pager('edge', 'deep', { filter: { _id: 'depth-20' } }).next(1)).docs[0].w;
  let depth = 0;
  let cur = deep.arr;
  while (Array.isArray(cur)) { depth++; cur = cur[0]; }
  assert.strictEqual(depth, 20);
  const mixed = (await s.pager('edge', 'mixed', { filter: {}, sort: shell.parse('{ _id: 1 }') }).next(20)).docs.map((d) => shell.typeOf(d.w.v));
  assert.deepStrictEqual(mixed.slice(0, 11), ['String', 'Int32', 'Double', 'Int64', 'Decimal128', 'Date', 'Null', 'Object', 'Array', 'Boolean', 'ObjectId']);
  const types = (await s.pager('edge', 'types', { filter: {} }).next(1)).docs[0].w;
  assert.strictEqual(shell.format(types.re), '/^ab+c$/i');
  assert.match(shell.format(types.uuid), /^UUID\("0e4c3c4a-/);
  assert.strictEqual(shell.format(types.ts), 'Timestamp({ t: 1700000000, i: 7 })');
  assert.strictEqual(shell.format(types.dbl), '5.0');
  assert.strictEqual(shell.format(types.int), '5');
  assert.strictEqual(shell.format(types.long), 'NumberLong("5")');
});

test('10 MB documents arrive cut for the grid; a page stays under its byte budget', { skip }, async () => {
  const t0 = Date.now();
  const p = s.pager('big', 'blobs', { filter: {} });
  const r = await p.next(50);
  assert.strictEqual(r.docs.length, 5);
  assert.ok(r.docs.every((d) => d.cut));
  assert.ok(r.bytes < 2 * 1024 * 1024, `page bytes ${r.bytes}`);
  assert.strictEqual(r.docs[0].w.text.$zovoTrunc.n, 8 * 1024 * 1024);
  assert.strictEqual(r.docs[0].w.raw.$zovoBin.n, 2 * 1024 * 1024);
  assert.ok(Date.now() - t0 < 5000);
  const full = await s.fullDoc('big', 'blobs', { $numberInt: '0' });
  assert.strictEqual(full.text.length, 8 * 1024 * 1024);
});

test('1M documents: pages with load more, then a streamed JSONL and CSV export with flat memory', { skip, timeout: 300000 }, async () => {
  const p = s.pager('big', 'events', { filter: {} });
  const a = await p.next(50);
  const b = await p.next(50);
  assert.strictEqual(a.docs.length + b.docs.length, 100);
  assert.notDeepStrictEqual(a.docs[0].w._id, b.docs[0].w._id);
  await p.close();
  const rss0 = process.memoryUsage().rss;
  let peak = rss0;
  const tick = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 200);
  const f = path.join(WORK, 'events.jsonl');
  const t0 = Date.now();
  const r = await s.exportTo('big', 'events', { filter: {} }, 'jsonl', f);
  clearInterval(tick);
  assert.strictEqual(r.count, 1000000);
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1000000);
  assert.ok(JSON.parse(lines[0]).ts.$date);
  console.log(`export 1M JSONL: ${Date.now() - t0} ms, ${(fs.statSync(f).size / 1048576).toFixed(0)} MB, RSS +${((peak - rss0) / 1048576).toFixed(0)} MB`);
  assert.ok(peak - rss0 < 400 * 1048576, 'memory stays flat while streaming');
  fs.rmSync(f);
  const c = path.join(WORK, 'orders.csv');
  const rc = await s.exportTo('shop', 'orders', { filter: shell.parse('{ status: "paid" }') }, 'csv', c);
  const head = fs.readFileSync(c, 'utf8').split('\n')[0];
  assert.match(head, /customer\.email/);
  assert.ok(rc.count > 1000);
  fs.rmSync(c);
});

test('JSON export keeps Int64 and Decimal128 exact, and imports back', { skip }, async () => {
  const f = path.join(WORK, 'longids.json');
  await s.exportTo(DB, 'longids', { filter: {} }, 'json', f);
  const text = fs.readFileSync(f, 'utf8');
  assert.match(text, /"\$numberLong":"9007199254740993"/);
  const r = await s.importFrom(DB, 'longids_copy', f, 'json');
  assert.strictEqual(r.inserted, 2);
  const ids = (await s.pager(DB, 'longids_copy', { filter: {}, sort: shell.parse('{ _id: 1 }') }).next(5)).docs.map((d) => d.w._id);
  assert.deepStrictEqual(ids, [{ $numberLong: '9007199254740992' }, { $numberLong: '9007199254740993' }]);
});

test('imports: JSONL and CSV in batches; a malformed Extended JSON file stops with its line', { skip }, async () => {
  const jl = path.join(WORK, 'a.jsonl');
  fs.writeFileSync(jl, Array.from({ length: 2500 }, (_, i) => JSON.stringify({ i, d: { $date: '2024-01-01T00:00:00Z' }, n: { $numberLong: '9007199254740993' } })).join('\n'));
  let progressCalls = 0;
  const r = await s.importFrom(DB, 'imp', jl, 'jsonl', { onProgress: () => { progressCalls++; } });
  assert.strictEqual(r.inserted, 2500);
  assert.strictEqual(progressCalls, 3, 'batches of 1,000');
  const one = (await s.pager(DB, 'imp', { filter: shell.parse('{ i: 7 }') }).next(1)).docs[0].w;
  assert.deepStrictEqual(one.n, { $numberLong: '9007199254740993' });
  assert.strictEqual(shell.typeOf(one.d), 'Date');
  const csv = path.join(WORK, 'a.csv');
  fs.writeFileSync(csv, 'name,addr.city,n\nAda,Berlin,1\n"Bob, Jr.",Oslo,2.5\n');
  assert.strictEqual((await s.importFrom(DB, 'csv', csv, 'csv')).inserted, 2);
  const bob = (await s.pager(DB, 'csv', { filter: shell.parse('{ n: 2.5 }') }).next(1)).docs[0].w;
  assert.deepStrictEqual(bob.addr, { city: 'Oslo' });
  const bad = path.join(WORK, 'bad.json');
  fs.writeFileSync(bad, '[\n{"ok": 1},\n{"ok": 2},\n{"ok": 3,, "x": 1},\n{"ok": 4}\n]');
  await assert.rejects(s.importFrom(DB, 'bad', bad, 'json'), (e) => /Line 4/.test(e.message) && /not valid Extended JSON/.test(e.message) && /0 documents were imported before it/.test(e.message));
  const badDate = path.join(WORK, 'baddate.jsonl');
  fs.writeFileSync(badDate, '{"ok": 1}\n{"when": {"$date": "not a date"}}\n');
  await assert.rejects(s.importFrom(DB, 'bad', badDate, 'jsonl'), (e) => /Line 2/.test(e.message) && /when has a \$date that is not a date/.test(e.message));
  const bad2 = path.join(WORK, 'bad2.json');
  fs.writeFileSync(bad2, '[{"a": 1}, {"b": 2');
  await assert.rejects(s.importFrom(DB, 'bad2', bad2, 'json'), /ends inside a value/);
});

test('a 60 s aggregation is cancelled on the server (killOp by comment)', { skip, timeout: 60000 }, async () => {
  const slow = shell.parsePipeline('[{ $match: { $expr: { $function: { body: "function() { const t = Date.now(); while (Date.now() - t < 1) {} return true; }", args: [], lang: "js" } } } }, { $count: "n" }]');
  const p = s.pager('big', 'events', { pipeline: slow, maxTimeMS: 120000 });
  const t0 = Date.now();
  const run = p.next(20);
  await new Promise((r) => setTimeout(r, 2500));
  await p.cancel();
  await assert.rejects(run, (e) => /cancel|interrupted/i.test(e.message));
  const took = Date.now() - t0;
  assert.ok(took < 15000, `stopped after ${took} ms`);
  // the server has no operation left with that comment
  const left = await s.use((c) => c.db('admin').aggregate([{ $currentOp: { allUsers: true } }, { $match: { 'command.comment': p.comment } }]).toArray());
  assert.strictEqual(left.length, 0);
});

test('maxTimeMS stops a query that runs too long', { skip }, async () => {
  const p = s.pager('big', 'events', { filter: shell.parse('{ $where: "sleep(1) || false" }'), maxTimeMS: 300 });
  await assert.rejects(p.next(10), /time limit/);
});

test('stage preview, explain and write-stage detection', { skip }, async () => {
  const pipe = shell.parsePipeline('[{ $match: { year: { $gte: 2000 } } }, { $group: { _id: { $arrayElemAt: ["$genres", 0] }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $out: "nope" }]');
  const st = await s.stagePreview('media', 'movies', pipe, 20);
  assert.strictEqual(st.length, 4);
  assert.strictEqual(st[0].docs.length, 20);
  assert.ok(st[2].docs.length > 3 && st[2].docs.length <= 9);
  assert.ok(st[3].skipped);
  assert.deepStrictEqual(writeStage(pipe), { stage: '$out', target: 'nope' });
  const names = (await s.collections('media')).map((c) => c.name);
  assert.ok(!names.includes('nope'), 'the preview never runs $out');
  const ex = await s.explain('media', 'movies', { filter: shell.parse('{ year: 2001 }') });
  const { summarizeExplain } = require('../src/explain');
  const sum = summarizeExplain(ex, { filter: { year: 2001 } });
  assert.deepStrictEqual(sum.indexes, ['year_1']);
  const ex2 = summarizeExplain(await s.explain('media', 'movies', { filter: shell.parse('{ runtime: 100 }') }), { filter: { runtime: 100 } });
  assert.ok(ex2.hints.some((h) => /Full collection scan/.test(h)));
  const ex3 = summarizeExplain(await s.explain('media', 'movies', { pipeline: pipe }), { pipeline: pipe });
  assert.ok(ex3.stages.length > 0);
});

test('indexes: create single, compound, unique and TTL, then drop', { skip }, async () => {
  await s.insert(DB, 'idx', [shell.parse('{ a: 1, b: 2, at: ISODate("2024-01-01") }')]);
  assert.strictEqual(await s.createIndex(DB, 'idx', shell.parse('{ a: 1 }'), { unique: true }), 'a_1');
  assert.strictEqual(await s.createIndex(DB, 'idx', shell.parse('{ a: 1, b: -1 }'), {}), 'a_1_b_-1');
  assert.strictEqual(await s.createIndex(DB, 'idx', shell.parse('{ at: 1 }'), { expireAfterSeconds: 3600, name: 'ttl_at' }), 'ttl_at');
  const list = await s.indexes(DB, 'idx');
  const by = Object.fromEntries(list.map((i) => [i.name, i]));
  assert.ok(by.a_1.unique);
  assert.strictEqual(by.ttl_at.ttl, 3600);
  await assert.rejects(s.insert(DB, 'idx', [shell.parse('{ a: 1 }')]), /duplicate key/);
  await s.dropIndex(DB, 'idx', 'a_1');
  assert.ok(!(await s.indexes(DB, 'idx')).some((i) => i.name === 'a_1'));
});

test('bulk update and delete with a filter; counts', { skip }, async () => {
  await s.insert(DB, 'bulk', Array.from({ length: 10 }, (_, i) => ({ i: { $numberInt: String(i) }, s: 'a' })));
  assert.strictEqual(await s.countMatching(DB, 'bulk', shell.parse('{ i: { $lt: 5 } }')), 5);
  assert.deepStrictEqual(await s.updateMatching(DB, 'bulk', shell.parse('{ i: { $lt: 5 } }'), shell.parse('{ $set: { s: "b" } }')), { matched: 5, modified: 5 });
  assert.deepStrictEqual(await s.deleteMatching(DB, 'bulk', shell.parse('{ s: "b" }')), { deleted: 5 });
  const left = (await s.pager(DB, 'bulk', { filter: {} }).next(50)).docs;
  assert.strictEqual(left.length, 5);
  assert.deepStrictEqual(await s.deleteIds(DB, 'bulk', left.slice(0, 2).map((d) => d.w._id)), { deleted: 2 });
});

test('wrong password and nothing listening give clear messages', { skip }, async () => {
  const bad = new MongoSession(cfg(), 'wrong-password');
  await assert.rejects(bad.open(), /user name or password is wrong/);
  const none = new MongoSession(cfg({ uri: 'mongodb://127.0.0.1:1/', timeoutMs: 2000 }), '');
  const t0 = Date.now();
  await assert.rejects(none.open(), /Nothing answers at 127\.0\.0\.1:1/);
  assert.ok(Date.now() - t0 < 6000);
});

test('the idle timer closes the client and the next action opens it again', { skip }, async () => {
  const x = new MongoSession(cfg({ idleMs: 400 }), process.env.ZOVO_MONGO_PASS || '');
  let dropped = null;
  x.onDrop = (reason) => { dropped = reason; };
  await x.databases();
  assert.ok(x.isOpen());
  await new Promise((r) => setTimeout(r, 900));
  assert.strictEqual(dropped, 'idle');
  assert.ok(!x.isOpen());
  assert.ok((await x.databases()).length > 0);
  assert.ok(x.isOpen());
  await x.close();
});
