'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { BSON } = require('mongodb');
const wire = require('../src/core/wire');
const shell = require('../src/core/shell');

const { EJSON, Long, Decimal128, Int32, Double, ObjectId, Binary, Timestamp, BSONRegExp, MinKey, MaxKey } = BSON;

test('BSON values become canonical wire values without precision loss', () => {
  const doc = {
    _id: Long.fromString('9007199254740993'), d: Decimal128.fromString('0.10'), i: new Int32(5), f: new Double(5), g: new Double(-0),
    o: new ObjectId('65a1b2c3d4e5f60718293a4b'), dt: new Date(1704164645678), b: new Binary(Buffer.from([1, 2, 3]), 0),
    t: new Timestamp({ t: 1700000000, i: 7 }), r: new BSONRegExp('^a', 'i'), mn: new MinKey(), mx: new MaxKey(), s: 'x', n: null, arr: [new Int32(1)],
  };
  const w = wire.toWire(doc);
  assert.deepStrictEqual(w._id, { $numberLong: '9007199254740993' });
  assert.deepStrictEqual(w.d, { $numberDecimal: '0.10' });
  assert.deepStrictEqual(w.i, { $numberInt: '5' });
  assert.deepStrictEqual(w.f, { $numberDouble: '5.0' });
  assert.deepStrictEqual(w.g, { $numberDouble: '-0.0' });
  assert.deepStrictEqual(w.o, { $oid: '65a1b2c3d4e5f60718293a4b' });
  assert.deepStrictEqual(w.dt, { $date: { $numberLong: '1704164645678' } });
  assert.deepStrictEqual(w.b, { $binary: { base64: 'AQID', subType: '00' } });
  assert.deepStrictEqual(w.t, { $timestamp: { t: 1700000000, i: 7 } });
  assert.deepStrictEqual(w.r, { $regularExpression: { pattern: '^a', options: 'i' } });
  assert.deepStrictEqual(w.mn, { $minKey: 1 });
  // and back: EJSON.deserialize (relaxed false) gives the same BSON types
  const back = EJSON.deserialize(w, { relaxed: false });
  assert.strictEqual(back._id._bsontype, 'Long');
  assert.strictEqual(back._id.toString(), '9007199254740993');
  assert.strictEqual(back.d.toString(), '0.10');
  assert.strictEqual(back.i._bsontype, 'Int32');
  assert.strictEqual(back.f._bsontype, 'Double');
  assert.strictEqual(EJSON.stringify(back, { relaxed: false }), EJSON.stringify(doc, { relaxed: false }));
});

test('the two Long ids next to 2^53 stay apart through parse, wire and BSON', () => {
  const a = shell.parse('NumberLong("9007199254740992")');
  const b = shell.parse('NumberLong("9007199254740993")');
  const la = EJSON.deserialize({ v: a }, { relaxed: false }).v;
  const lb = EJSON.deserialize({ v: b }, { relaxed: false }).v;
  assert.notStrictEqual(la.toString(), lb.toString());
  assert.strictEqual(wire.toWire(lb).$numberLong, '9007199254740993');
});

test('grid limits cut long strings, big binaries, long arrays and wide documents', () => {
  const stats = {};
  const w = wire.toWire({ s: 'x'.repeat(5000), bin: new Binary(Buffer.alloc(100000)), arr: Array.from({ length: 1000 }, (_, i) => i), wide: Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`k${i}`, i])) }, wire.GRID_LIMITS, stats);
  assert.ok(stats.cut);
  assert.deepStrictEqual(Object.keys(w.s), ['$zovoTrunc']);
  assert.strictEqual(w.s.$zovoTrunc.n, 5000);
  assert.strictEqual(w.s.$zovoTrunc.s.length, 2000);
  assert.deepStrictEqual(w.bin, { $zovoBin: { subType: '00', n: 100000 } });
  assert.strictEqual(w.arr.length, 201);
  assert.deepStrictEqual(w.arr[200], { $zovoMore: 800 });
  assert.strictEqual(w.wide.$zovoMoreFields, 100);
  assert.ok(wire.hasMarkers(w));
  assert.ok(!wire.hasMarkers(wire.toWire({ a: 'x' })));
});

test('relax keeps exactness for exports', () => {
  const w = { a: { $numberInt: '5' }, b: { $numberDouble: '1.5' }, c: { $numberLong: '9007199254740993' }, d: { $numberLong: '42' }, e: { $numberDecimal: '0.10' }, f: { $date: { $numberLong: '0' } }, g: { $numberDouble: 'NaN' }, h: [{ $oid: 'ab'.repeat(12) }] };
  const r = wire.relax(w);
  assert.strictEqual(r.a, 5);
  assert.strictEqual(r.b, 1.5);
  assert.deepStrictEqual(r.c, { $numberLong: '9007199254740993' });
  assert.strictEqual(r.d, 42);
  assert.deepStrictEqual(r.e, { $numberDecimal: '0.10' });
  assert.deepStrictEqual(r.f, { $date: '1970-01-01T00:00:00.000Z' });
  assert.deepStrictEqual(r.g, { $numberDouble: 'NaN' });
  assert.deepStrictEqual(r.h, [{ $oid: 'ab'.repeat(12) }]);
  // EJSON reads it back to the same types where they were kept
  const back = EJSON.parse(JSON.stringify(r), { relaxed: false });
  assert.strictEqual(back.c.toString(), '9007199254740993');
  assert.strictEqual(back.e.toString(), '0.10');
});

test('getPath, setPath and keepType', () => {
  const w = { a: { b: [{ c: 1 }, { c: 2 }] } };
  assert.strictEqual(wire.getPath(w, ['a', 'b', 1, 'c']), 2);
  assert.strictEqual(wire.getPath(w, ['a', 'x']), undefined);
  const w2 = wire.setPath(w, ['a', 'b', 0, 'c'], 9);
  assert.strictEqual(w2.a.b[0].c, 9);
  assert.strictEqual(w.a.b[0].c, 1);
  assert.deepStrictEqual(wire.keepType({ $numberInt: '5' }, { $numberLong: '1' }), { $numberLong: '5' });
  assert.deepStrictEqual(wire.keepType({ $numberInt: '5' }, { $numberDouble: '1.5' }), { $numberDouble: '5' });
  assert.deepStrictEqual(wire.keepType({ $numberDouble: '0.10' }, { $numberDecimal: '1' }), { $numberDecimal: '0.10' });
});
