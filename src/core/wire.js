'use strict';
// BSON values (as the driver returns them with promoteValues: false) -> canonical Extended JSON "wire" values,
// and wire values -> BSON. Pure: it reads _bsontype tags and never loads the driver, so tests run without it.
//
// The grid gets cut values (long text, big binaries, long arrays) so a 10 MB document does not reach the
// webview whole. Exports and "open full document" use no limits.

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

const GRID_LIMITS = { str: 2000, arr: 200, keys: 500, bin: 2048 };
const NO_LIMITS = { str: Infinity, arr: Infinity, keys: Infinity, bin: Infinity };

function hex2(n) {
  return Number(n || 0).toString(16).padStart(2, '0');
}

/** Canonical text of a double: 5.0, 1.5, -0.0, Infinity, NaN. */
function doubleText(x) {
  if (Object.is(x, -0)) return '-0.0';
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x) && Math.abs(x) < 1e21) return x.toFixed(1);
  return String(x);
}

/**
 * A BSON value as a wire value. lim: GRID_LIMITS (cut for display) or NO_LIMITS.
 * stats (optional) collects { cut: true } when anything was cut.
 */
function toWire(v, lim = NO_LIMITS, stats) {
  if (v === null) return null;
  if (v === undefined) return { $undefined: true };
  switch (typeof v) {
    case 'string':
      if (v.length > lim.str) { if (stats) stats.cut = true; return { $zovoTrunc: { s: v.slice(0, lim.str), n: v.length } }; }
      return v;
    case 'boolean': return v;
    case 'number': return Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX && !Object.is(v, -0) ? { $numberInt: String(v) } : { $numberDouble: doubleText(v) };
    case 'bigint': return { $numberLong: v.toString() };
    default:
  }
  if (v instanceof Date) return { $date: { $numberLong: String(v.getTime()) } };
  if (Array.isArray(v)) {
    const out = [];
    const n = Math.min(v.length, lim.arr);
    for (let i = 0; i < n; i++) out.push(toWire(v[i], lim, stats));
    if (v.length > lim.arr) { out.push({ $zovoMore: v.length - lim.arr }); if (stats) stats.cut = true; }
    return out;
  }
  if (v instanceof RegExp) return { $regularExpression: { pattern: v.source, options: v.flags.split('').filter((c) => 'imsux'.includes(c)).sort().join('') } };
  if (typeof Buffer !== 'undefined' && (Buffer.isBuffer(v) || v instanceof Uint8Array)) return binWire(Buffer.from(v), 0, lim, stats);
  switch (v._bsontype) {
    case 'ObjectId': case 'ObjectID': return { $oid: v.toHexString() };
    case 'Int32': return { $numberInt: String(v.value) };
    case 'Double': return { $numberDouble: doubleText(v.value) };
    case 'Long': return { $numberLong: v.toString() };
    case 'Decimal128': return { $numberDecimal: v.toString() };
    case 'Binary': return binWire(v.buffer.subarray ? v.buffer.subarray(0, v.position) : Buffer.from(v.buffer).subarray(0, v.position), v.sub_type, lim, stats);
    case 'Timestamp': return { $timestamp: { t: v.t !== undefined ? Number(v.t) : v.high >>> 0, i: v.i !== undefined ? Number(v.i) : v.low >>> 0 } };
    case 'BSONRegExp': return { $regularExpression: { pattern: v.pattern, options: v.options } };
    case 'MinKey': return { $minKey: 1 };
    case 'MaxKey': return { $maxKey: 1 };
    case 'Code': return v.scope ? { $code: String(v.code), $scope: toWire(v.scope, lim, stats) } : { $code: String(v.code) };
    case 'BSONSymbol': case 'Symbol': return { $symbol: String(v.value) };
    case 'DBRef': {
      const out = { $ref: v.collection, $id: toWire(v.oid, lim, stats) };
      if (v.db) out.$db = v.db;
      for (const k of Object.keys(v.fields || {})) out[k] = toWire(v.fields[k], lim, stats);
      return out;
    }
    case 'DBPointer': return { $dbPointer: { $ref: v.namespace, $id: toWire(v.oid, lim, stats) } };
    default:
  }
  const out = {};
  let n = 0;
  const keys = Object.keys(v);
  for (const k of keys) {
    if (n++ >= lim.keys) { out['$zovoMoreFields'] = keys.length - lim.keys; if (stats) stats.cut = true; break; }
    out[k] = toWire(v[k], lim, stats);
  }
  return out;
}

function binWire(buf, subType, lim, stats) {
  if (buf.length > lim.bin) { if (stats) stats.cut = true; return { $zovoBin: { subType: hex2(subType), n: buf.length } }; }
  return { $binary: { base64: buf.toString('base64'), subType: hex2(subType) } };
}

/** Rough size in bytes of a wire value as JSON (to keep a page of results under a budget). */
function wireSize(w) {
  try { return JSON.stringify(w).length; } catch { return 0; }
}

/** True when the wire value holds a display-only marker that must never be written back. */
function hasMarkers(w) {
  if (!w || typeof w !== 'object') return false;
  if (Array.isArray(w)) return w.some(hasMarkers);
  for (const k of Object.keys(w)) {
    if (k === '$zovoTrunc' || k === '$zovoBin' || k === '$zovoMore' || k === '$zovoMoreFields') return true;
    if (hasMarkers(w[k])) return true;
  }
  return false;
}

/**
 * Relaxed Extended JSON for exports, without precision loss: Int32 and Double become JSON numbers,
 * Int64 becomes a number only inside +-2^53, Decimal128 stays {$numberDecimal}, dates become {$date: ISO}.
 */
function relax(w) {
  if (w === null || typeof w !== 'object') return w;
  if (Array.isArray(w)) return w.map(relax);
  const k = Object.keys(w);
  if (k.length === 1) {
    const x = w[k[0]];
    switch (k[0]) {
      case '$numberInt': return Number(x);
      case '$numberDouble': { const n = Number(x); return Number.isFinite(n) ? n : w; }
      case '$numberLong': { const b = BigInt(x); return b <= 9007199254740991n && b >= -9007199254740991n ? Number(b) : w; }
      case '$date': {
        const ms = Number(x && x.$numberLong !== undefined ? x.$numberLong : x);
        const d = new Date(ms);
        return ms >= 0 && ms <= 253402300799999 && !Number.isNaN(d.getTime()) ? { $date: d.toISOString() } : w;
      }
      case '$oid': case '$numberDecimal': case '$binary': case '$timestamp': case '$regularExpression': case '$minKey': case '$maxKey': case '$undefined': case '$symbol': case '$code':
        return w;
      default:
    }
  }
  const out = {};
  for (const key of k) out[key] = relax(w[key]);
  return out;
}

/** Value at a path (array of keys / indexes) in a wire value, or undefined. */
function getPath(w, path) {
  let cur = w;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) { const i = Number(p); if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined; cur = cur[i]; } else {
      if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
      cur = cur[p];
    }
  }
  return cur;
}

/** A copy of a wire value with the value at path set (path must exist up to its parent). */
function setPath(w, path, value) {
  if (!path.length) return value;
  const [head, ...rest] = path;
  if (Array.isArray(w)) {
    const copy = w.slice();
    copy[Number(head)] = setPath(w[Number(head)], rest, value);
    return copy;
  }
  const copy = { ...w };
  copy[head] = setPath(w ? w[head] : undefined, rest, value);
  return copy;
}

/** Keep the old type when the user typed a plain number or text into a typed field (cell edits). */
function keepType(next, prev) {
  const kind = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v)[0] : null);
  const pk = kind(prev);
  const nk = kind(next);
  const numText = next && typeof next === 'object' ? next.$numberInt || next.$numberLong || next.$numberDouble : undefined;
  if (numText !== undefined) {
    const whole = /^[+-]?\d+$/.test(numText) || /^[+-]?\d+\.0*$/.test(numText);
    if (pk === '$numberLong' && whole) return { $numberLong: BigInt(numText.replace(/\.0*$/, '')).toString() };
    if (pk === '$numberDouble') return { $numberDouble: numText };
    if (pk === '$numberDecimal') return { $numberDecimal: numText };
    if (pk === '$numberInt' && nk === '$numberLong') return next; // too big for Int32: Int64
  }
  return next;
}

module.exports = { toWire, wireSize, hasMarkers, relax, getPath, setPath, keepType, doubleText, GRID_LIMITS, NO_LIMITS };
