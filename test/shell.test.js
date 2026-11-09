'use strict';
const test = require('node:test');
const assert = require('node:assert');
const shell = require('../src/core/shell');

test('numbers keep their exact text and type', () => {
  assert.deepStrictEqual(shell.parse('5'), { $numberInt: '5' });
  assert.deepStrictEqual(shell.parse('5.0'), { $numberDouble: '5.0' });
  assert.deepStrictEqual(shell.parse('2147483648'), { $numberLong: '2147483648' });
  assert.deepStrictEqual(shell.parse('9007199254740993'), { $numberLong: '9007199254740993' });
  assert.deepStrictEqual(shell.parse('-1.5e3'), { $numberDouble: '-1.5e3' });
  assert.deepStrictEqual(shell.parse('NumberLong("9007199254740993")'), { $numberLong: '9007199254740993' });
  assert.deepStrictEqual(shell.parse('Long(9007199254740993)'), { $numberLong: '9007199254740993' }, 'an unquoted literal is read from its text, not from a JS number');
  assert.deepStrictEqual(shell.parse('NumberDecimal("0.10")'), { $numberDecimal: '0.10' });
  assert.deepStrictEqual(shell.parse('Decimal128(0.1000)'), { $numberDecimal: '0.1000' });
  assert.deepStrictEqual(shell.parse('NumberInt(7)'), { $numberInt: '7' });
  assert.throws(() => shell.parse('NumberInt(3000000000)'), /32-bit/);
  assert.throws(() => shell.parse('NumberLong("9223372036854775808")'), /64-bit/);
});

test('shell constructors, regex, comments and relaxed syntax', () => {
  const v = shell.parse(`{
    // a comment
    _id: ObjectId('65A1B2C3D4E5F60718293A4B'), when: ISODate("2024-02-29T12:00:00Z"), day: ISODate('2024-03-01'),
    re: /^ab\\/c+$/i, 'quoted key': "x", "a.b": 1, uuid: UUID("0e4c3c4a-7f1e-4b9b-8c3d-2a6b5e9f1d00"),
    ts: Timestamp({ t: 1700000000, i: 7 }), ts2: Timestamp(1, 2), bin: BinData(0, "AQID"), min: MinKey(), max: MaxKey, n: null, u: undefined, b: true,
    arr: [1, 2.5, 'three',], /* trailing comma ok */
  }`);
  assert.deepStrictEqual(v._id, { $oid: '65a1b2c3d4e5f60718293a4b' });
  assert.deepStrictEqual(v.when, { $date: { $numberLong: String(Date.parse('2024-02-29T12:00:00Z')) } });
  assert.deepStrictEqual(v.day, { $date: { $numberLong: String(Date.parse('2024-03-01T00:00:00Z')) } });
  assert.deepStrictEqual(v.re, { $regularExpression: { pattern: '^ab/c+$', options: 'i' } });
  assert.strictEqual(v['quoted key'], 'x');
  assert.deepStrictEqual(v['a.b'], { $numberInt: '1' });
  assert.deepStrictEqual(v.uuid, { $binary: { base64: 'Dkw8Sn8eS5uMPSprXp8dAA==', subType: '04' } });
  assert.deepStrictEqual(v.ts, { $timestamp: { t: 1700000000, i: 7 } });
  assert.deepStrictEqual(v.ts2, { $timestamp: { t: 1, i: 2 } });
  assert.deepStrictEqual(v.bin, { $binary: { base64: 'AQID', subType: '00' } });
  assert.deepStrictEqual(v.min, { $minKey: 1 });
  assert.deepStrictEqual(v.max, { $maxKey: 1 });
  assert.strictEqual(v.n, null);
  assert.deepStrictEqual(v.u, { $undefined: true });
  assert.strictEqual(v.arr.length, 3);
});

test('format reads back to the same wire value (round trip)', () => {
  const samples = [
    '{ _id: NumberLong("9007199254740993"), d: NumberDecimal("0.10"), i: 5, f: 5.0, g: 1.5, s: "a\\"b\\n", dt: ISODate("2024-01-02T03:04:05.678Z") }',
    '{ re: /a\\/b/gi, u: UUID("0e4c3c4a-7f1e-4b9b-8c3d-2a6b5e9f1d00"), t: Timestamp({ t: 5, i: 6 }), b: BinData(5, "AAEC"), nested: { "a.b": [1, { x: null }] }, "名前": "山田" }',
  ];
  for (const s of samples) {
    const w = shell.parse(s);
    const back = shell.parse(shell.format(w, { indent: 2 }));
    assert.deepStrictEqual(back, w);
    assert.deepStrictEqual(shell.parse(shell.format(w, { indent: 0 })), w);
  }
});

test('format prints the shell forms', () => {
  assert.strictEqual(shell.format({ $numberLong: '9007199254740993' }), 'NumberLong("9007199254740993")');
  assert.strictEqual(shell.format({ $numberDouble: '5.0' }), '5.0');
  assert.strictEqual(shell.format({ $numberDouble: '5' }), '5.0');
  assert.strictEqual(shell.format({ $numberInt: '5' }), '5');
  assert.strictEqual(shell.format({ $oid: 'ab'.repeat(12) }), `ObjectId("${'ab'.repeat(12)}")`);
  assert.strictEqual(shell.format({ $date: { $numberLong: '0' } }), 'ISODate("1970-01-01T00:00:00.000Z")');
  assert.strictEqual(shell.format({ $date: { $numberLong: '99999999999999999' } }), 'new Date(99999999999999999)');
  assert.match(shell.format({ $zovoTrunc: { s: 'abc', n: 9000000 } }), /9,000,000 characters/);
  assert.strictEqual(shell.inline({ a: 'x'.repeat(500) }, 20).length, 20);
});

test('parse errors say where', () => {
  assert.throws(() => shell.parse('{ a: 1,\n  b: }'), (e) => e.line === 2 && /line 2/.test(e.message));
  assert.throws(() => shell.parse('{ a: foo }'), /Put text in quotes/);
  assert.throws(() => shell.parse('{ a: 1 } x'), /after the value/);
  assert.throws(() => shell.parse('{ a: 1, a: 2 }'), /appears twice/);
  assert.throws(() => shell.parse('{ a: eval("x") }'), /Unknown function eval/);
  assert.throws(() => shell.parse('"open'), /not closed/);
  assert.throws(() => shell.parseDoc('[1]'), /must be a document/);
  assert.deepStrictEqual(shell.parseDoc('   '), {});
});

test('pipelines are arrays of one-operator stages', () => {
  assert.strictEqual(shell.parsePipeline('[{ $match: {} }, { $limit: 5 }]').length, 2);
  assert.strictEqual(shell.parsePipeline('{ $match: {} }').length, 1);
  assert.throws(() => shell.parsePipeline('[{ match: {} }]'), /Stage 1/);
  assert.throws(() => shell.parsePipeline('[{ $match: {}, $limit: 1 }]'), /exactly one stage/);
});

test('fromText: the cell editor keeps the chosen type exactly', () => {
  assert.strictEqual(shell.fromText('  spaced  ', 'String'), '  spaced  ');
  assert.deepStrictEqual(shell.fromText('9007199254740993', 'Int64'), { $numberLong: '9007199254740993' });
  assert.deepStrictEqual(shell.fromText('12', 'Double'), { $numberDouble: '12' });
  assert.deepStrictEqual(shell.fromText('0.10', 'Decimal128'), { $numberDecimal: '0.10' });
  assert.deepStrictEqual(shell.fromText('42', 'Int32'), { $numberInt: '42' });
  assert.throws(() => shell.fromText('2147483648', 'Int32'), /Int32 range/);
  assert.throws(() => shell.fromText('1.5', 'Int64'), /whole number/);
  assert.strictEqual(shell.fromText('TRUE', 'Boolean'), true);
  assert.deepStrictEqual(shell.fromText('2024-05-01', 'Date'), { $date: { $numberLong: String(Date.parse('2024-05-01T00:00:00Z')) } });
  assert.deepStrictEqual(shell.fromText('65a1b2c3d4e5f60718293a4b', 'ObjectId'), { $oid: '65a1b2c3d4e5f60718293a4b' });
  assert.strictEqual(shell.fromText('anything', 'Null'), null);
  assert.deepStrictEqual(shell.fromText('{ a: 1 }', 'Object'), { a: { $numberInt: '1' } });
  assert.throws(() => shell.fromText('{ a: 1 }', 'Array'), /Array needs/);
  assert.strictEqual(shell.toText({ $numberLong: '9007199254740993' }), '9007199254740993');
  assert.strictEqual(shell.toText('text'), 'text');
  assert.strictEqual(shell.toText({ $date: { $numberLong: '0' } }), '1970-01-01T00:00:00.000Z');
});

test('typeOf and container checks', () => {
  assert.strictEqual(shell.typeOf({ $numberDecimal: '1' }), 'Decimal128');
  assert.strictEqual(shell.typeOf({ $binary: { base64: '', subType: '04' } }), 'UUID');
  assert.strictEqual(shell.typeOf({ a: 1 }), 'Object');
  assert.strictEqual(shell.typeOf({ $oid: 'x', other: 1 }), 'Object');
  assert.ok(shell.isContainer({ a: 1 }));
  assert.ok(!shell.isContainer({ $oid: 'x' }));
  assert.ok(shell.isTruncated({ a: [{ b: { $zovoTrunc: { s: '', n: 5 } } }] }));
  assert.ok(!shell.isTruncated({ a: [{ b: 'x' }] }));
});

test('samplePaths lists dotted field paths with counts', () => {
  const p = shell.samplePaths([{ a: 1, b: { c: 1, d: [{ e: 1 }] } }, { a: 2, f: 'x' }]);
  const m = Object.fromEntries(p.map((x) => [x.path, x.n]));
  assert.strictEqual(m.a, 2);
  assert.strictEqual(m['b.c'], 1);
  assert.strictEqual(m['b.d.e'], 1);
  assert.strictEqual(m.f, 1);
});
