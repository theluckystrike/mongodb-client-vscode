'use strict';
// BSON comparison order for wire values (the order the server sorts _id in), for the collection compare.
// MinKey < null < numbers < strings < objects < arrays < binary < ObjectId < booleans < dates < timestamps
// < regular expressions < MaxKey. Numbers compare across Int32, Int64, Double and Decimal128 by value.

const { typeOf } = require('./shell');

const RANK = { MinKey: 1, Undefined: 2, Null: 2, Int32: 3, Int64: 3, Double: 3, Decimal128: 3, String: 4, Symbol: 4, Object: 5, Array: 6, Binary: 7, UUID: 7, ObjectId: 8, Boolean: 9, Date: 10, Timestamp: 11, RegExp: 12, MaxKey: 13 };

function numText(v) {
  if (typeof v === 'number') return String(v);
  return String(v.$numberInt ?? v.$numberLong ?? v.$numberDouble ?? v.$numberDecimal);
}

function cmpNum(a, b) {
  const x = numText(a);
  const y = numText(b);
  if (/^-?\d+$/.test(x) && /^-?\d+$/.test(y)) { const p = BigInt(x); const q = BigInt(y); return p < q ? -1 : p > q ? 1 : 0; }
  const p = Number(x);
  const q = Number(y);
  if (Number.isNaN(p) || Number.isNaN(q)) return Number.isNaN(p) ? (Number.isNaN(q) ? 0 : -1) : 1;
  return p < q ? -1 : p > q ? 1 : 0;
}

/** Code point order (the same as the UTF-8 byte order the server uses with the simple collation). */
function cmpStr(a, b) {
  const x = String(a);
  const y = String(b);
  const ia = x[Symbol.iterator]();
  const ib = y[Symbol.iterator]();
  for (;;) {
    const p = ia.next();
    const q = ib.next();
    if (p.done || q.done) return p.done && q.done ? 0 : p.done ? -1 : 1;
    const cp = p.value.codePointAt(0);
    const cq = q.value.codePointAt(0);
    if (cp !== cq) return cp < cq ? -1 : 1;
  }
}

function compare(a, b) {
  const ta = typeOf(a);
  const tb = typeOf(b);
  const ra = RANK[ta] || 5;
  const rb = RANK[tb] || 5;
  if (ra !== rb) return ra < rb ? -1 : 1;
  switch (ra) {
    case 3: return cmpNum(a, b);
    case 4: return cmpStr(ta === 'Symbol' ? a.$symbol : a, tb === 'Symbol' ? b.$symbol : b);
    case 8: return cmpStr(a.$oid, b.$oid);
    case 9: return a === b ? 0 : a ? 1 : -1;
    case 10: { const x = BigInt(a.$date.$numberLong); const y = BigInt(b.$date.$numberLong); return x < y ? -1 : x > y ? 1 : 0; }
    case 11: return a.$timestamp.t !== b.$timestamp.t ? (a.$timestamp.t < b.$timestamp.t ? -1 : 1) : (a.$timestamp.i < b.$timestamp.i ? -1 : a.$timestamp.i > b.$timestamp.i ? 1 : 0);
    case 7: {
      const x = Buffer.from(a.$binary.base64, 'base64');
      const y = Buffer.from(b.$binary.base64, 'base64');
      if (x.length !== y.length) return x.length < y.length ? -1 : 1;
      if (a.$binary.subType !== b.$binary.subType) return a.$binary.subType < b.$binary.subType ? -1 : 1;
      return Buffer.compare(x, y);
    }
    case 5: {
      const ka = Object.keys(a);
      const kb = Object.keys(b);
      for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
        const r = compare(a[ka[i]], b[kb[i]]);
        if (RANK[typeOf(a[ka[i]])] !== RANK[typeOf(b[kb[i]])]) return r;
        const c = cmpStr(ka[i], kb[i]);
        if (c) return c;
        if (r) return r;
      }
      return ka.length === kb.length ? 0 : ka.length < kb.length ? -1 : 1;
    }
    case 6: {
      for (let i = 0; i < Math.min(a.length, b.length); i++) { const r = compare(a[i], b[i]); if (r) return r; }
      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    }
    case 12: return cmpStr(a.$regularExpression.pattern, b.$regularExpression.pattern) || cmpStr(a.$regularExpression.options, b.$regularExpression.options);
    default: return 0;
  }
}

/** JSON text of a wire value with keys sorted, for "equal ignoring field order". */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

/** Dotted paths whose values differ between two wire documents (top 2 levels, arrays compared whole). */
function diffPaths(a, b, pre = '', depth = 0, out = []) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const p = pre ? `${pre}.${k}` : k;
    const x = a ? a[k] : undefined;
    const y = b ? b[k] : undefined;
    if (x === undefined || y === undefined) { out.push(p); continue; }
    if (stable(x) === stable(y)) continue;
    const obj = (v) => typeOf(v) === 'Object';
    if (depth < 2 && obj(x) && obj(y)) diffPaths(x, y, p, depth + 1, out);
    else out.push(p);
  }
  return out;
}

module.exports = { compare, stable, diffPaths, cmpStr };
