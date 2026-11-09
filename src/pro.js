'use strict';
// Zovo Pro tools: Schema analysis and Collection compare. Everything else (connections, browsing, queries,
// editing, aggregation with stage preview, explain, indexes, import, export, read-only mode) is free and stays
// free. Each Pro tool can be tried 3 times; after that one explanation offers the unlock (GitHub Sponsors,
// PayPal or a license key; checked without a server of ours). PRO_ENABLED = false makes both tools free.

const { createLicense } = require('./license');
const shell = require('./core/shell');
const { compare, stable, diffPaths } = require('./core/order');

const PRO_ENABLED = true;
const FREE_TRIES = 3;
const SKU = 'mongodb-client-pro';
const TRIES_KEY = 'zovoMongo.proTries';

const SCHEMA_DETAIL = 'Schema analysis samples 1,000 documents and shows every field with its types, how often it appears, number and date ranges and the most common values, and writes a $jsonSchema validator from it.';
const COMPARE_DETAIL = 'Collection compare reads two collections (on any two connections) in _id order and lists the documents that are only on one side or different, field by field, with a mongosh script that makes the second match the first.';

function createPro(vscode, context) {
  // name 'Zovo' makes the label "Zovo Pro": one purchase for every Zovo extension.
  const license = createLicense({ vscode, context, sku: SKU, name: 'Zovo', commandPrefix: 'zovoMongo', product: 'MongoDB Client' });

  /**
   * For a Pro tool the user started, after its prompts. Returns false (locked, the user closed the explanation) or a gate
   * { done() }. VERP3 (10 Nov): a free try is used only when the tool showed its result: call done() after the schema or
   * the compare report is on screen. Escape, Cancel or an error before that costs nothing (as in the other Zovo Pro tools).
   */
  async function allow(feature, detail) {
    const free = { async done() {} };
    if (!PRO_ENABLED) return free;
    await license.ready;
    if (license.isPro(SKU)) { license.refresh().catch(() => {}); return free; }
    const used = Number(context.globalState.get(TRIES_KEY, {})[feature] || 0);
    if (used < FREE_TRIES) {
      let spent = false;
      return {
        async done() {
          if (spent) return;
          spent = true;
          const tries = Object.assign({}, context.globalState.get(TRIES_KEY, {}));
          const n = Number(tries[feature] || 0) + 1;
          tries[feature] = n;
          await context.globalState.update(TRIES_KEY, tries);
          const left = Math.max(0, FREE_TRIES - n);
          vscode.window.setStatusBarMessage(`MongoDB Client: ${feature} is a Zovo Pro tool. Free try ${n} of ${FREE_TRIES}${left ? ` (${left} left)` : ', the last one'}.`, 8000);
        },
      };
    }
    const ok = await license.requirePro(feature, `${detail} You used your ${FREE_TRIES} free tries. It is USD 19 once and unlocks Pro in every Zovo extension. Browsing, queries, editing, aggregation, indexes, import and export stay free.`);
    return ok ? free : false;
  }

  return { license, allow, enabled: PRO_ENABLED };
}

// ---------- schema analysis ----------

const BSON_TYPE = { String: 'string', Int32: 'int', Int64: 'long', Double: 'double', Decimal128: 'decimal', Boolean: 'bool', Date: 'date', ObjectId: 'objectId', Null: 'null', Object: 'object', Array: 'array', Binary: 'binData', UUID: 'binData', Timestamp: 'timestamp', RegExp: 'regex', MinKey: 'minKey', MaxKey: 'maxKey', Code: 'javascript', Symbol: 'symbol', Undefined: 'undefined' };

function numberOf(v) {
  const t = shell.typeOf(v);
  if (t === 'Int32') return Number(v.$numberInt);
  if (t === 'Int64') return Number(v.$numberLong);
  if (t === 'Double') return Number(v.$numberDouble);
  if (t === 'Decimal128') return Number(v.$numberDecimal);
  return null;
}

/**
 * Field statistics of a sample of wire documents. Arrays count their elements under "path[]".
 * Returns { n, fields: [{ path, count, types: {T: n}, min, max, minLen, maxLen, top: [[value, n]], distinct }] }
 */
function analyze(docs, maxDepth = 6) {
  const fields = new Map();
  const get = (p) => {
    if (!fields.has(p)) fields.set(p, { path: p, count: 0, types: {}, min: null, max: null, minLen: null, maxLen: null, values: new Map(), overflow: false, docs: new Set() });
    return fields.get(p);
  };
  const add = (p, v, docIdx, depth) => {
    const f = get(p);
    if (!f.docs.has(docIdx)) { f.docs.add(docIdx); f.count++; }
    const t = shell.typeOf(v);
    f.types[t] = (f.types[t] || 0) + 1;
    const n = numberOf(v);
    if (n !== null && Number.isFinite(n)) { f.min = f.min === null ? n : Math.min(f.min, n); f.max = f.max === null ? n : Math.max(f.max, n); }
    if (t === 'Date') { const ms = Number(v.$date.$numberLong); f.dmin = f.dmin === undefined ? ms : Math.min(f.dmin, ms); f.dmax = f.dmax === undefined ? ms : Math.max(f.dmax, ms); }
    if (t === 'String') { const s = typeof v === 'string' ? v : v.$zovoTrunc.s; const len = typeof v === 'string' ? v.length : v.$zovoTrunc.n; f.minLen = f.minLen === null ? len : Math.min(f.minLen, len); f.maxLen = f.maxLen === null ? len : Math.max(f.maxLen, len); if (!f.overflow && s.length <= 80) { f.values.set(s, (f.values.get(s) || 0) + 1); if (f.values.size > 200) f.overflow = true; } }
    if (t === 'Boolean') f.values.set(String(v), (f.values.get(String(v)) || 0) + 1);
    if (depth >= maxDepth) return;
    if (t === 'Object') for (const k of Object.keys(v)) add(`${p}.${k}`, v[k], docIdx, depth + 1);
    if (t === 'Array') for (const el of v) { if (el && typeof el === 'object' && '$zovoMore' in el) continue; add(`${p}[]`, el, docIdx, depth + 1); }
  };
  docs.forEach((d, i) => { for (const k of Object.keys(d)) add(k, d[k], i, 1); });
  const out = [...fields.values()].map((f) => ({
    path: f.path, count: f.count, types: f.types, min: f.min, max: f.max, minLen: f.minLen, maxLen: f.maxLen, dmin: f.dmin, dmax: f.dmax,
    top: f.overflow ? [] : [...f.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5), distinct: f.overflow ? null : f.values.size,
  }));
  return { n: docs.length, fields: out };
}

/** A $jsonSchema validator draft from the analysis: bsonType per field, required = present in every sampled document. */
function jsonSchema(an) {
  const root = { bsonType: 'object', required: [], properties: {} };
  const nodeFor = (path) => {
    const parts = path.replace(/\[\]/g, '.[]').split('.');
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p === '[]') { cur.items = cur.items || { }; cur = cur.items; continue; }
      cur.properties = cur.properties || {};
      cur.properties[p] = cur.properties[p] || {};
      if (i < parts.length - 1) cur = cur.properties[p];
      else return { parent: cur, key: p, node: cur.properties[p] };
    }
    return { parent: null, key: null, node: cur };
  };
  const byPath = new Map(an.fields.map((f) => [f.path, f]));
  for (const f of an.fields) {
    const { parent, key, node } = nodeFor(f.path);
    const types = [...new Set(Object.keys(f.types).map((t) => BSON_TYPE[t] || 'object'))];
    node.bsonType = types.length === 1 ? types[0] : types;
    if (parent && key) {
      const parentPath = f.path.includes('.') ? f.path.slice(0, f.path.lastIndexOf('.')) : null;
      const parentCount = parentPath ? (byPath.get(parentPath) || {}).count : an.n;
      if (!f.path.includes('[]') && parentCount && f.count === parentCount && !(parent.required || []).includes(key)) (parent.required = parent.required || []).push(key);
    }
  }
  const clean = (n) => { if (n.required && !n.required.length) delete n.required; for (const v of Object.values(n.properties || {})) clean(v); if (n.items) clean(n.items); return n; };
  return { $jsonSchema: clean(root) };
}

let lastSchema = null;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function schemaHtml(an, ns) {
  const pct = (x) => `${Math.round((x / Math.max(1, an.n)) * 100)}%`;
  const rows = an.fields.slice(0, 2000).map((f) => {
    const total = Object.values(f.types).reduce((a, b) => a + b, 0);
    const types = Object.entries(f.types).sort((a, b) => b[1] - a[1]).map(([t, c]) => `<span class="t">${esc(t)} ${Math.round((c / total) * 100)}%</span>`).join(' ');
    const extra = [];
    if (f.min !== null) extra.push(`range ${esc(f.min)} … ${esc(f.max)}`);
    if (f.dmin !== undefined) extra.push(`${esc(new Date(f.dmin).toISOString().slice(0, 10))} … ${esc(new Date(f.dmax).toISOString().slice(0, 10))}`);
    if (f.minLen !== null) extra.push(`length ${f.minLen}…${f.maxLen}`);
    if (f.top.length && f.distinct !== null && f.distinct <= 50) extra.push(`${f.distinct} distinct: ${f.top.map(([v, c]) => `${esc(JSON.stringify(v).slice(0, 40))} (${c})`).join(', ')}`);
    const depth = (f.path.match(/\.|\[\]/g) || []).length;
    const mixed = Object.keys(f.types).filter((t) => t !== 'Null').length > 1;
    return `<tr${mixed ? ' class="mixed"' : ''}><td style="padding-left:${8 + depth * 14}px"><code>${esc(f.path)}</code></td><td><div class="bar"><i style="width:${pct(f.count)}"></i></div>${pct(f.count)}</td><td>${types}${mixed ? ' <b title="More than one type">mixed</b>' : ''}</td><td class="x">${extra.join(' · ')}</td></tr>`;
  }).join('');
  const csp = "default-src 'none'; style-src 'unsafe-inline'";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Schema</title><style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:12px 18px}
h1{font-size:15px;margin:0 0 4px}.muted{color:var(--vscode-descriptionForeground)}table{border-collapse:collapse;width:100%;margin-top:10px}
td,th{border-bottom:1px solid var(--vscode-editorGroup-border,#8883);padding:3px 8px;text-align:left;vertical-align:top}th{font-weight:600;color:var(--vscode-descriptionForeground)}
code{font-family:var(--vscode-editor-font-family)}.t{display:inline-block;padding:0 6px;margin:1px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px}
.bar{display:inline-block;width:60px;height:7px;background:var(--vscode-editorWidget-background,#8882);margin-right:6px;vertical-align:middle}.bar i{display:block;height:100%;background:var(--vscode-charts-blue,#3794ff)}
tr.mixed td:first-child{border-left:3px solid var(--vscode-charts-orange,#d18616)}.x{font-size:12px;color:var(--vscode-descriptionForeground);word-break:break-word}a{color:var(--vscode-textLink-foreground)}
</style></head><body><h1>Schema · ${esc(ns)}</h1><div class="muted">${an.n.toLocaleString('en-US')} sampled documents · ${an.fields.length.toLocaleString('en-US')} fields · orange = more than one type in the field · <a href="command:zovoMongo.openJsonSchema">Open as a $jsonSchema validator</a></div>
<table><thead><tr><th>Field</th><th>Present</th><th>Types</th><th>Values</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

async function showSchema(vscode, context, t, docs) {
  void context;
  const an = analyze(docs);
  lastSchema = { ns: `${t.database}.${t.collection}`, schema: jsonSchema(an) };
  const panel = vscode.window.createWebviewPanel('zovoMongo.schema', `Schema: ${t.collection}`, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: false, enableCommandUris: true, localResourceRoots: [] });
  panel.webview.html = schemaHtml(an, `${t.database}.${t.collection}`);
  return { panel, analysis: an };
}

async function openJsonSchema(vscode) {
  if (!lastSchema) { vscode.window.showInformationMessage('Run Schema analysis on a collection first.'); return null; }
  const text = `// $jsonSchema draft for ${lastSchema.ns}, from the sampled documents. Review it before you use it, for example:\n// db.runCommand({ collMod: "${lastSchema.ns.split('.').slice(1).join('.')}", validator: <this>, validationLevel: "moderate" })\nconst validator = ${JSON.stringify(lastSchema.schema, null, 2)};\n`;
  const doc = await vscode.workspace.openTextDocument({ language: 'javascript', content: text });
  await vscode.window.showTextDocument(doc, { preview: false });
  return doc;
}

// ---------- collection compare ----------

/**
 * Merge two _id-ordered streams of wire documents. a and b are async iterators. Returns counts and the
 * first `keep` differences of each kind. Stops (outOfOrder) if a stream is not in BSON _id order.
 */
async function compareStreams(a, b, opts = {}) {
  const keep = opts.keep || 1000;
  const res = { same: 0, changed: 0, onlyA: 0, onlyB: 0, read: 0, outOfOrder: false, stopped: false, changedList: [], onlyAList: [], onlyBList: [], sameOrderOnly: 0 };
  let x = await a.next();
  let y = await b.next();
  let prevA = null;
  let prevB = null;
  const checkOrder = (prev, cur, side) => {
    if (prev !== null && compare(prev, cur) >= 0) { res.outOfOrder = side; return false; }
    return true;
  };
  while (!x.done || !y.done) {
    if (opts.shouldStop && opts.shouldStop()) { res.stopped = true; break; }
    if (!x.done && !checkOrder(prevA, x.value._id, 'A')) break;
    if (!y.done && !checkOrder(prevB, y.value._id, 'B')) break;
    const c = x.done ? 1 : y.done ? -1 : compare(x.value._id, y.value._id);
    if (c === 0) {
      const sa = stable(x.value);
      if (sa === stable(y.value)) { res.same++; if (JSON.stringify(x.value) !== JSON.stringify(y.value)) res.sameOrderOnly++; } else { res.changed++; if (res.changedList.length < keep) res.changedList.push({ id: x.value._id, paths: diffPaths(x.value, y.value), doc: x.value }); }
      prevA = x.value._id; prevB = y.value._id;
      x = await a.next(); y = await b.next();
      res.read += 2;
    } else if (c < 0) {
      res.onlyA++; if (res.onlyAList.length < keep) res.onlyAList.push({ id: x.value._id, doc: x.value });
      prevA = x.value._id; x = await a.next(); res.read++;
    } else {
      res.onlyB++; if (res.onlyBList.length < keep) res.onlyBList.push({ id: y.value._id });
      prevB = y.value._id; y = await b.next(); res.read++;
    }
    if (opts.onProgress && res.read % 2000 < 2) opts.onProgress(res);
  }
  return res;
}

function compareReport(res, labelA, labelB, keep) {
  const L = [`# Collection compare`, '', `- A: ${labelA}`, `- B: ${labelB}`, '', '| | Documents |', '|---|---:|', `| Equal | ${res.same.toLocaleString('en-US')} |`, `| Different | ${res.changed.toLocaleString('en-US')} |`, `| Only in A | ${res.onlyA.toLocaleString('en-US')} |`, `| Only in B | ${res.onlyB.toLocaleString('en-US')} |`, ''];
  if (res.sameOrderOnly) L.push(`${res.sameOrderOnly.toLocaleString('en-US')} of the equal documents have the same fields and values in a different field order.`, '');
  if (res.outOfOrder) L.push(`**Stopped:** collection ${res.outOfOrder} did not come back in _id order, so a merge would be wrong. This happens with mixed _id types on some MongoDB-compatible servers.`, '');
  if (res.stopped) L.push('**Stopped by you.** The counts cover the documents read so far.', '');
  const list = (title, arr, f) => { if (!arr.length) return; L.push(`## ${title}${arr.length >= keep ? ` (first ${keep})` : ''}`, ''); for (const x of arr) L.push(f(x)); L.push(''); };
  list('Different', res.changedList, (x) => `- \`${shell.inline(x.id, 80)}\`: ${x.paths.slice(0, 12).join(', ')}${x.paths.length > 12 ? ', …' : ''}`);
  list('Only in A', res.onlyAList, (x) => `- \`${shell.inline(x.id, 80)}\``);
  list('Only in B', res.onlyBList, (x) => `- \`${shell.inline(x.id, 80)}\``);
  return L.join('\n');
}

function syncScript(res, b, labelA, labelB) {
  const coll = `db.getSiblingDB(${JSON.stringify(b.database)}).getCollection(${JSON.stringify(b.collection)})`;
  const L = [`// mongosh script: makes ${labelB} match ${labelA} for the differences listed in the report.`, '// Nothing has run. Read it, then run it in mongosh against the B server.', `const c = ${coll};`, ''];
  let budget = 20 * 1024 * 1024;
  let skipped = 0;
  const put = (s) => { if (budget - s.length < 0) { skipped++; return; } budget -= s.length; L.push(s); };
  for (const x of res.onlyAList) put(`c.insertOne(${shell.format(x.doc, { indent: 0 })});`);
  for (const x of res.changedList) put(`c.replaceOne({ _id: ${shell.format(x.id, { indent: 0 })} }, ${shell.format(x.doc, { indent: 0 })});`);
  for (const x of res.onlyBList) put(`c.deleteOne({ _id: ${shell.format(x.id, { indent: 0 })} });`);
  if (skipped) L.push(`// ${skipped} more statements were left out (the script stops at 20 MB).`);
  if (res.changed + res.onlyA + res.onlyB > res.changedList.length + res.onlyAList.length + res.onlyBList.length) L.push('// The report lists the first differences only; run the compare again after this script for the rest.');
  return L.join('\n') + '\n';
}

async function compareCollections(vscode, { a, b, sa, sb, labelA, labelB }) {
  let stop = false;
  const keep = 1000;
  const itA = sa.iterate(a.database, a.collection, { sort: { _id: { $numberInt: '1' } } });
  const itB = sb.iterate(b.database, b.collection, { sort: { _id: { $numberInt: '1' } } });
  let res;
  try {
    res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Comparing ${a.collection} with ${b.collection}`, cancellable: true }, (progress, token) => {
      token.onCancellationRequested(() => { stop = true; });
      return compareStreams(itA, itB, { keep, shouldStop: () => stop, onProgress: (r) => progress.report({ message: `${r.read.toLocaleString('en-US')} documents read, ${(r.changed + r.onlyA + r.onlyB).toLocaleString('en-US')} differences` }) });
    });
  } finally {
    await Promise.all([itA.return(), itB.return()]).catch(() => {});
  }
  const report = await vscode.workspace.openTextDocument({ language: 'markdown', content: compareReport(res, labelA, labelB, keep) });
  await vscode.window.showTextDocument(report, { preview: false });
  const diffs = res.changed + res.onlyA + res.onlyB;
  let script = null;
  if (diffs && !res.outOfOrder) {
    script = await vscode.workspace.openTextDocument({ language: 'javascript', content: syncScript(res, b, labelA, labelB) });
    await vscode.window.showTextDocument(script, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }
  vscode.window.showInformationMessage(diffs ? `${res.changed.toLocaleString('en-US')} different, ${res.onlyA.toLocaleString('en-US')} only in A, ${res.onlyB.toLocaleString('en-US')} only in B. The mongosh script (not run) makes B match A.` : (res.outOfOrder ? 'The compare stopped: see the report.' : `All ${res.same.toLocaleString('en-US')} documents are equal.`));
  return { res, report, script };
}

module.exports = { createPro, analyze, jsonSchema, schemaHtml, showSchema, openJsonSchema, compareStreams, compareReport, syncScript, compareCollections, PRO_ENABLED, FREE_TRIES, SKU, SCHEMA_DETAIL, COMPARE_DETAIL };
