'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// A tiny vscode stand-in for the Pro gate (the license facade only needs these parts at creation).
const shown = [];
const fakeVscode = {
  window: { setStatusBarMessage: (m) => { shown.push(m); }, showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, onDidChangeWindowState: () => ({ dispose() {} }) },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
  env: { openExternal: async () => true, uriScheme: 'vscode', appName: 'Visual Studio Code' },
  Uri: { parse: (s) => ({ toString: () => s }) },
  authentication: { getSession: async () => undefined },
  EventEmitter: class { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(x) { this.l.forEach((f) => f(x)); } dispose() {} },
};
const origLoad = Module._load;
Module._load = function load(request, ...rest) { if (request === 'vscode') return fakeVscode; return origLoad.call(this, request, ...rest); };
const pro = require('../src/pro');
const shell = require('../src/core/shell');

function memento() {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); }, keys: () => [...m.keys()], setKeysForSync() {} };
}
function context() {
  const secrets = new Map();
  return { globalState: memento(), workspaceState: memento(), subscriptions: [], secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); }, onDidChange: () => ({ dispose() {} }) }, extension: { id: 'zovo.zovo-mongodb-client', packageJSON: { version: '0.1.0' } } };
}

test('Pro is on, with 3 free tries per tool, then the unlock question', async () => {
  assert.strictEqual(pro.PRO_ENABLED, true);
  assert.strictEqual(pro.FREE_TRIES, 3);
  const ctx = context();
  const p = pro.createPro(fakeVscode, ctx);
  p.license.requirePro = async () => false; // the user closes the explanation
  for (let i = 1; i <= 3; i++) { const g = await p.allow('Schema analysis', 'x'); assert.ok(g, `try ${i}`); await g.done(); }
  assert.match(shown[shown.length - 1], /Free try 3 of 3/);
  assert.strictEqual(await p.allow('Schema analysis', 'x'), false, 'the 4th start asks to unlock');
  assert.ok(await p.allow('Collection compare', 'x'), 'tries are counted per tool');
});

test('VERP3: a free try counts only when done() runs (Escape, Cancel or an error after the gate costs nothing)', async () => {
  const ctx = context();
  const p = pro.createPro(fakeVscode, ctx);
  p.license.requirePro = async () => false;
  for (let i = 0; i < 5; i++) assert.ok(await p.allow('Schema analysis', 'x'), 'a start without a result never uses a try');
  assert.deepStrictEqual(ctx.globalState.get('zovoMongo.proTries', {}), {});
  const g = await p.allow('Schema analysis', 'x');
  await g.done(); await g.done();
  assert.deepStrictEqual(ctx.globalState.get('zovoMongo.proTries', {}), { 'Schema analysis': 1 }, 'done() counts once');
  p.license.requirePro = async () => true; // unlocked in the explanation
  ctx.globalState.update('zovoMongo.proTries', { 'Schema analysis': 3 });
  const g2 = await p.allow('Schema analysis', 'x');
  assert.ok(g2); await g2.done();
  assert.deepStrictEqual(ctx.globalState.get('zovoMongo.proTries', {}), { 'Schema analysis': 3 }, 'no count after an unlock');
});

test('schema analysis: presence, types, ranges, mixed fields', () => {
  const docs = [
    shell.parse('{ _id: 1, name: "a", age: 30, tags: ["x", "y"], addr: { city: "Berlin" }, v: "s", when: ISODate("2024-01-01") }'),
    shell.parse('{ _id: 2, name: "b", age: 40.5, tags: [], addr: { city: "Oslo", zip: "0150" }, v: 5 }'),
    shell.parse('{ _id: 3, name: "a", addr: { city: "Berlin" }, v: null, when: ISODate("2025-06-01") }'),
  ];
  const an = pro.analyze(docs);
  const f = Object.fromEntries(an.fields.map((x) => [x.path, x]));
  assert.strictEqual(an.n, 3);
  assert.strictEqual(f.name.count, 3);
  assert.strictEqual(f.age.count, 2);
  assert.deepStrictEqual(f.age.types, { Int32: 1, Double: 1 });
  assert.strictEqual(f.age.min, 30);
  assert.strictEqual(f.age.max, 40.5);
  assert.strictEqual(f['addr.zip'].count, 1);
  assert.strictEqual(f['tags[]'].types.String, 2);
  assert.deepStrictEqual(f.name.top[0], ['a', 2]);
  assert.ok(f.when.dmin < f.when.dmax);
  const js = pro.jsonSchema(an).$jsonSchema;
  assert.deepStrictEqual(js.required.sort(), ['_id', 'addr', 'name', 'v']);
  assert.deepStrictEqual(js.properties.age.bsonType.sort(), ['double', 'int']);
  assert.strictEqual(js.properties.addr.properties.city.bsonType, 'string');
  assert.deepStrictEqual(js.properties.addr.required, ['city']);
  assert.strictEqual(js.properties.tags.items.bsonType, 'string');
  const html = pro.schemaHtml(an, 'db.c');
  assert.match(html, /default-src 'none'/);
  assert.ok(!/<script/i.test(html));
});

async function* gen(arr) { for (const x of arr) yield x; }

test('collection compare merges two _id-ordered streams', async () => {
  const A = ['{ _id: 1, a: 1 }', '{ _id: 2, a: 2 }', '{ _id: 3, a: 3, b: { c: 1 } }', '{ _id: NumberLong("9007199254740993"), x: 1 }'].map(shell.parse);
  const B = ['{ _id: 2, a: 2 }', '{ _id: 3, a: 3, b: { c: 2 } }', '{ _id: 4, a: 4 }', '{ _id: NumberLong("9007199254740993"), x: 1 }'].map(shell.parse);
  const res = await pro.compareStreams(gen(A), gen(B));
  assert.strictEqual(res.same, 2);
  assert.strictEqual(res.changed, 1);
  assert.deepStrictEqual(res.changedList[0].paths, ['b.c']);
  assert.strictEqual(res.onlyA, 1);
  assert.strictEqual(res.onlyB, 1);
  assert.strictEqual(res.outOfOrder, false);
  const report = pro.compareReport(res, 'A', 'B', 1000);
  assert.match(report, /\| Different \| 1 \|/);
  const script = pro.syncScript(res, { database: 'db', collection: 'c' }, 'A', 'B');
  assert.match(script, /c\.insertOne\(\{ _id: 1, a: 1 \}\);/);
  assert.match(script, /c\.replaceOne\(\{ _id: 3 \}/);
  assert.match(script, /c\.deleteOne\(\{ _id: 4 \}\);/);
});

test('collection compare stops when a stream is out of _id order', async () => {
  const A = ['{ _id: 2 }', '{ _id: 1 }'].map(shell.parse);
  const B = ['{ _id: 1 }'].map(shell.parse);
  const res = await pro.compareStreams(gen(A), gen(B));
  assert.strictEqual(res.outOfOrder, 'A');
});

test('field order alone is reported as equal (and counted)', async () => {
  const res = await pro.compareStreams(gen([shell.parse('{ _id: 1, a: 1, b: 2 }')]), gen([shell.parse('{ _id: 1, b: 2, a: 1 }')]));
  assert.strictEqual(res.same, 1);
  assert.strictEqual(res.sameOrderOnly, 1);
});
