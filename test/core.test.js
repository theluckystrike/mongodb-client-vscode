'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const files = require('../src/core/files');
const order = require('../src/core/order');
const connstr = require('../src/core/connstr');
const errors = require('../src/core/errors');
const { summarizeExplain, explainHtml } = require('../src/explain');
const { buildHtml } = require('../src/html');
const { cutWire } = require('../src/docs');
const { GRID_LIMITS } = require('../src/core/wire');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zovo-mongo-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const put = (name, text) => { const p = path.join(tmp, name); fs.writeFileSync(p, text); return p; };
const collect = async (it) => { const out = []; for await (const x of it) out.push(x); return out; };

test('jsonValues reads arrays, concatenated documents and reports lines', async () => {
  const a = await collect(files.jsonValues(put('a.json', '[\n {"a": 1},\n {"b": "x]}"}, {"c": [1, {"d": 2}]}\n]\n')));
  assert.deepStrictEqual(a.map((x) => JSON.parse(x.text)), [{ a: 1 }, { b: 'x]}' }, { c: [1, { d: 2 }] }]);
  assert.deepStrictEqual(a.map((x) => x.line), [2, 3, 3]);
  const b = await collect(files.jsonValues(put('b.json', '{"a":1}\n{"a":2}\n\n{"a":3}')));
  assert.strictEqual(b.length, 3);
  const c = await collect(files.jsonValues(put('c.json', '[1, "two", {"x": 3}]')));
  assert.deepStrictEqual(c.map((x) => x.text), ['1', '"two"', '{"x": 3}']);
  await assert.rejects(collect(files.jsonValues(put('d.json', '[{"a": 1}, {"b": 2'))), /ends inside a value/);
  await assert.rejects(collect(files.jsonValues(put('e.json', 'hello'))), /must start with \[ or \{/);
  await assert.rejects(collect(files.jsonValues(put('f.json', '[{"a":1}] trailing'))), /after the end/);
});

test('jsonValues streams a large array in chunks with a value split across chunks', async () => {
  const docs = Array.from({ length: 30000 }, (_, i) => ({ i, s: 'x'.repeat(i % 97), n: { deep: [i, String(i)] } }));
  const p = put('big.json', JSON.stringify(docs));
  let bytes = 0;
  const out = await collect(files.jsonValues(p, (n) => { bytes += n; }));
  assert.strictEqual(out.length, 30000);
  assert.deepStrictEqual(JSON.parse(out[29999].text), docs[29999]);
  assert.strictEqual(bytes, fs.statSync(p).size);
});

test('jsonLines skips empty lines and keeps line numbers', async () => {
  const out = await collect(files.jsonLines(put('a.jsonl', '﻿{"a":1}\n\n{"a":2}\r\n')));
  assert.deepStrictEqual(out.map((x) => [x.line, x.text]), [[1, '{"a":1}'], [3, '{"a":2}']]);
});

test('CSV records, typed values and dotted headers', async () => {
  const out = await collect(files.csvRecords(put('a.csv', 'name,address.city,age,ok,note\nAda,Berlin,36,true,"multi\nline, with ""quotes"""\nBob,,4.5,false,\n')));
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[1].fields[4], 'multi\nline, with "quotes"');
  const doc = files.csvDoc(out[0].fields, out[1].fields);
  assert.deepStrictEqual(doc, { name: 'Ada', address: { city: 'Berlin' }, age: { $numberInt: '36' }, ok: true, note: 'multi\nline, with "quotes"' });
  const doc2 = files.csvDoc(out[0].fields, out[2].fields);
  assert.deepStrictEqual(doc2, { name: 'Bob', age: { $numberDouble: '4.5' }, ok: false });
  assert.deepStrictEqual(files.csvValue('9007199254740993'), { $numberLong: '9007199254740993' });
  assert.strictEqual(files.csvValue('007'), '007', 'leading zeros stay text');
  assert.strictEqual(files.csvCell('a,b'), '"a,b"');
  assert.strictEqual(files.csvCell('say "hi"'), '"say ""hi"""');
  await assert.rejects(collect(files.csvRecords(put('b.csv', 'a,b\n"open,2\n'))), /not closed/);
});

test('BSON order for _id merges', () => {
  const ids = [{ $minKey: 1 }, null, { $numberInt: '-1' }, { $numberDouble: '1.5' }, { $numberLong: '9007199254740992' }, { $numberLong: '9007199254740993' }, 'A', 'a', 'é', '😀', { x: 1 }, [1], { $binary: { base64: 'AQ==', subType: '00' } }, { $oid: '000000000000000000000001' }, { $oid: '00000000000000000000000a' }, false, true, { $date: { $numberLong: '-5' } }, { $date: { $numberLong: '5' } }, { $maxKey: 1 }];
  for (let i = 1; i < ids.length; i++) assert.strictEqual(order.compare(ids[i - 1], ids[i]), -1, `${JSON.stringify(ids[i - 1])} < ${JSON.stringify(ids[i])}`);
  assert.strictEqual(order.compare({ $numberInt: '2' }, { $numberDouble: '2.0' }), 0);
  assert.strictEqual(order.compare({ $numberDecimal: '0.10' }, { $numberDouble: '0.1' }), 0);
  assert.strictEqual(order.cmpStr('￿', '😀'), -1, 'code point order, not UTF-16 units');
  assert.strictEqual(order.stable({ b: 1, a: { d: 2, c: 3 } }), order.stable({ a: { c: 3, d: 2 }, b: 1 }));
  assert.deepStrictEqual(order.diffPaths({ a: 1, b: { c: 1, d: 2 }, e: [1] }, { a: 1, b: { c: 1, d: 3 }, e: [2], f: 0 }).sort(), ['b.d', 'e', 'f']);
});

test('connection strings: parse, take the password out, validate', () => {
  const p = connstr.parseUri('mongodb://ada:p%40ss@h1:27017,h2:27018/app?replicaSet=rs0&tls=true');
  assert.strictEqual(p.user, 'ada');
  assert.strictEqual(p.password, 'p@ss');
  assert.strictEqual(p.hosts, 'h1:27017,h2:27018');
  assert.strictEqual(p.params.replicaSet, 'rs0');
  const s = connstr.splitUri('mongodb://ada:p%40ss@h1:27017,h2:27018/app?replicaSet=rs0&tls=true');
  assert.strictEqual(s.uri, 'mongodb://h1:27017,h2:27018/app?replicaSet=rs0&tls=true');
  assert.strictEqual(s.password, 'p@ss');
  assert.ok(!s.uri.includes('ss@'));
  assert.strictEqual(connstr.splitUri('mongodb+srv://u:pw@cluster0.example.net/?retryWrites=true').uri, 'mongodb+srv://cluster0.example.net/?retryWrites=true');
  assert.deepStrictEqual(connstr.validate({ uri: 'mongodb://localhost' }), []);
  assert.match(connstr.validate({ uri: 'postgres://x' })[0], /starts with mongodb/);
  assert.match(connstr.validate({ uri: 'mongodb+srv://a,b' })[0], /one host/);
  assert.match(connstr.validate({ uri: 'mongodb+srv://a:27017' })[0], /does not take a port/);
  assert.match(connstr.validate({ uri: 'mongodb://a,b', directConnection: 'yes' })[0], /exactly one host/);
  assert.strictEqual(connstr.displayHosts('mongodb+srv://u:p@c.example.net/db'), 'srv:c.example.net');
});

test('friendly errors', () => {
  const cfg = { uri: 'mongodb://db.example:27017/', authSource: 'admin' };
  assert.match(errors.friendly(Object.assign(new Error('Authentication failed.'), { code: 18 }), cfg).message, /user name or password is wrong/);
  assert.match(errors.friendly(new Error('connect ECONNREFUSED 127.0.0.1:27017'), cfg, 'connect').message, /Nothing answers at db.example:27017/);
  assert.match(errors.friendly(new Error('querySrv ENOTFOUND _mongodb._tcp.x'), { uri: 'mongodb+srv://x/' }).message, /could not be found/);
  assert.match(errors.friendly(Object.assign(new Error('operation exceeded time limit'), { code: 50 }), cfg).message, /time limit/);
  const lost = Object.assign(new Error('connection 3 to 127.0.0.1:27047 closed'), { name: 'MongoNetworkError' });
  assert.ok(errors.isConnectionLost(lost));
  assert.ok(errors.friendly(lost, cfg).lost);
  assert.ok(errors.friendly(Object.assign(new Error('operation was interrupted'), { code: 11601 }), cfg).cancelled);
});

test('explain summary finds a collection scan and an in-memory sort', () => {
  const ex = { explainVersion: '1', queryPlanner: { winningPlan: { stage: 'SORT', sortPattern: { a: 1 }, inputStage: { stage: 'COLLSCAN', filter: { b: { $eq: 1 } }, direction: 'forward' } } }, executionStats: { executionTimeMillis: { $numberInt: '420' }, nReturned: { $numberInt: '10' }, totalKeysExamined: { $numberInt: '0' }, totalDocsExamined: { $numberInt: '1000000' }, executionStages: { stage: 'SORT', nReturned: 10, inputStage: { stage: 'COLLSCAN', docsExamined: 1000000, nReturned: 10 } } } };
  const s = summarizeExplain(ex, { filter: { b: 1 } });
  assert.strictEqual(s.ms, 420);
  assert.strictEqual(s.docs, 1000000);
  assert.ok(s.hints.some((h) => /Full collection scan/.test(h) && /\{ b: 1 \}/.test(h)));
  assert.ok(s.hints.some((h) => /in memory/.test(h)));
  const html = explainHtml({ explain: ex, query: { filter: { b: { $numberInt: '1' } } }, ns: 'db.c' });
  assert.match(html, /default-src 'none'/);
  assert.ok(!/<script/i.test(html));
  assert.match(html, /COLLSCAN/);
  const ix = summarizeExplain({ queryPlanner: { winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'year_1' } } }, executionStats: { nReturned: 5, totalDocsExamined: 5, totalKeysExamined: 5 } }, { filter: { year: 1 } });
  assert.deepStrictEqual(ix.indexes, ['year_1']);
});

test('webview HTML has a strict CSP and a nonce on every script', () => {
  const html = buildHtml({ cspSource: 'vscode-resource:', scriptUri: 'x.js', styleUri: 'x.css', title: 't', page: 'docs', data: { a: '</script><script>alert(1)</script>' } });
  assert.match(html, /default-src 'none'/);
  assert.match(html, /img-src vscode-resource: blob: data:/);
  const scripts = html.match(/<script[^>]*>/g);
  assert.ok(scripts.every((s) => /nonce="/.test(s)));
  assert.ok(!html.includes('</script><script>alert'));
});

test('cutWire re-cuts a full document for the grid', () => {
  const stats = {};
  const w = cutWire({ t: 'x'.repeat(3000), b: { $binary: { base64: Buffer.alloc(10000).toString('base64'), subType: '00' } }, a: Array.from({ length: 300 }, () => 1), o: { $oid: 'ab'.repeat(12) } }, GRID_LIMITS, stats);
  assert.ok(stats.cut);
  assert.strictEqual(w.t.$zovoTrunc.n, 3000);
  assert.strictEqual(w.b.$zovoBin.n, 10000);
  assert.strictEqual(w.a.length, 201);
  assert.deepStrictEqual(w.o, { $oid: 'ab'.repeat(12) });
});

test('explorer: a repaint never queries the server; refresh does (idle connections stay closed)', async () => {
  const { ExplorerProvider } = require('../src/tree');
  class EE { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(x) { this.l.forEach((f) => f(x)); } }
  const fakeVs = { EventEmitter: EE };
  const store = { onDidChange: () => ({}), list: () => [{ id: 'c1', name: 'C', uri: 'mongodb://h' }], get: () => ({ id: 'c1', name: 'C', uri: 'mongodb://h' }) };
  let calls = 0;
  const session = { databases: async () => { calls++; return [{ name: 'app', size: 1 }]; } };
  const sessions = { openIds: () => new Set(), get: async () => session };
  const t = new ExplorerProvider(fakeVs, store, sessions);
  const [conn] = await t.getChildren();
  await t.getChildren(conn);
  assert.strictEqual(calls, 1);
  t.repaint();
  await t.getChildren(conn);
  assert.strictEqual(calls, 1, 'repaint used the cache');
  t.refresh();
  await t.getChildren(conn);
  assert.strictEqual(calls, 2, 'refresh asked again');
});
