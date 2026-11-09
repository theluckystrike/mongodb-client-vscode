'use strict';
// Mongo shell syntax <-> canonical Extended JSON (v2), without eval and without the bson package.
// The extension host, the webviews and the tests share this file.
//
// "Wire" values are canonical Extended JSON: plain JSON that keeps every BSON type exactly.
//   {$oid}, {$numberInt}, {$numberLong}, {$numberDouble}, {$numberDecimal}, {$date: {$numberLong}},
//   {$binary: {base64, subType}}, {$timestamp: {t, i}}, {$regularExpression: {pattern, options}},
//   {$minKey: 1}, {$maxKey: 1}, {$undefined: true}, {$code}, {$symbol}
// Numbers never pass through a JavaScript number on the way to the server: the literal text is kept.
// Large values sent to the grid are cut by the host and marked {$zovoTrunc: {s, n}} (text) or
// {$zovoBin: {subType, n}} (binary) or a last array item {$zovoMore: n}. Those can be viewed, not written.

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

const WRAPPERS = new Set(['$oid', '$numberInt', '$numberLong', '$numberDouble', '$numberDecimal', '$date', '$binary', '$timestamp', '$regularExpression', '$minKey', '$maxKey', '$undefined', '$code', '$symbol', '$dbPointer', '$zovoTrunc', '$zovoBin', '$zovoMore', '$uuid']);

/** The BSON type name of a wire value, as the grid and the type picker show it. */
function typeOf(v) {
  if (v === null) return 'Null';
  if (Array.isArray(v)) return 'Array';
  if (typeof v === 'string') return 'String';
  if (typeof v === 'boolean') return 'Boolean';
  if (typeof v === 'number') return Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX ? 'Int32' : 'Double';
  if (typeof v !== 'object') return 'Unknown';
  const k = Object.keys(v);
  if (k.length === 1 || (k.length === 2 && '$code' in v)) {
    switch (k[0]) {
      case '$oid': return 'ObjectId';
      case '$numberInt': return 'Int32';
      case '$numberLong': return 'Int64';
      case '$numberDouble': return 'Double';
      case '$numberDecimal': return 'Decimal128';
      case '$date': return 'Date';
      case '$binary': return v.$binary && v.$binary.subType === '04' ? 'UUID' : 'Binary';
      case '$timestamp': return 'Timestamp';
      case '$regularExpression': return 'RegExp';
      case '$minKey': return 'MinKey';
      case '$maxKey': return 'MaxKey';
      case '$undefined': return 'Undefined';
      case '$code': return 'Code';
      case '$symbol': return 'Symbol';
      case '$dbPointer': return 'DBPointer';
      case '$zovoTrunc': return 'String';
      case '$zovoBin': return 'Binary';
      default:
    }
  }
  return 'Object';
}

function isWrapper(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const k = Object.keys(v);
  return (k.length === 1 && WRAPPERS.has(k[0])) || (k.length === 2 && '$code' in v && '$scope' in v);
}

/** True for a value the grid can open further (a document or an array). */
function isContainer(v) {
  return v !== null && typeof v === 'object' && !isWrapper(v);
}

/** True when a value, or something inside it, was cut by the host for display. */
function isTruncated(v) {
  if (!v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some(isTruncated);
  if ('$zovoTrunc' in v || '$zovoBin' in v || '$zovoMore' in v) return true;
  if (isWrapper(v)) return false;
  for (const k in v) if (isTruncated(v[k])) return true;
  return false;
}

// ---------- formatting ----------

function b64ToHex(b64) {
  const tbl = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const ch of String(b64).replace(/=+$/, '')) {
    const x = tbl.indexOf(ch);
    if (x < 0) continue;
    acc = (acc << 6) | x;
    bits += 6;
    if (bits >= 8) { bits -= 8; out += ((acc >> bits) & 0xff).toString(16).padStart(2, '0'); }
  }
  return out;
}

function uuidText(b64) {
  const h = b64ToHex(b64);
  if (h.length !== 32) return null;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function dateText(v) {
  const raw = v.$date;
  let ms;
  if (raw && typeof raw === 'object' && '$numberLong' in raw) ms = Number(raw.$numberLong);
  else if (typeof raw === 'string') ms = Date.parse(raw);
  else ms = Number(raw);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function dateMs(v) {
  const raw = v.$date;
  if (raw && typeof raw === 'object' && '$numberLong' in raw) return String(raw.$numberLong);
  if (typeof raw === 'string') return String(Date.parse(raw));
  return String(raw);
}

/** Double text the way the shell shows it: 1.5, 5.0 for whole numbers (so it reads back as a Double), Infinity, NaN. */
function doubleText(s) {
  const t = String(s);
  if (/^-?(Infinity|NaN)$/.test(t) || t === '-0.0') return t;
  const n = Number(t);
  if (!Number.isFinite(n)) return t;
  if (Number.isInteger(n) && !/[eE.]/.test(t)) return `${t}.0`;
  if (Number.isInteger(n) && /^-?\d+\.0+$/.test(t)) return t.replace(/\.0+$/, '.0');
  return t;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
function keyText(k) {
  return IDENT.test(k) ? k : JSON.stringify(k);
}

/** One wire value as shell text on one line, for grid cells and short previews. */
function inline(v, max = 200) {
  const s = format(v, { indent: 0 });
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Shell text of a wire value. opts.indent: spaces per level (0 = one line).
 * Int32 prints as 5, Double as 5.0 or 1.5, Int64 as NumberLong("..."), so the text reads back to the same types.
 */
function format(v, opts = {}, depth = 0) {
  const ind = opts.indent === undefined ? 2 : opts.indent;
  const nl = ind ? '\n' : '';
  const pad = (d) => (ind ? ' '.repeat(ind * d) : '');
  const sp = ind ? ' ' : ' ';
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : doubleText(String(v));
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    const items = v.map((x) => (x && typeof x === 'object' && '$zovoMore' in x ? `/* … ${x.$zovoMore} more items */` : format(x, opts, depth + 1)));
    if (!ind) return `[${items.join(', ')}]`;
    return `[${nl}${items.map((x) => pad(depth + 1) + x).join(`,${nl}`)}${nl}${pad(depth)}]`;
  }
  if (typeof v !== 'object') return String(v);
  const t = typeOf(v);
  switch (t) {
    case 'ObjectId': return `ObjectId("${v.$oid}")`;
    case 'Int32': return String(v.$numberInt);
    case 'Int64': return `NumberLong("${v.$numberLong}")`;
    case 'Double': return doubleText(v.$numberDouble);
    case 'Decimal128': return `NumberDecimal("${v.$numberDecimal}")`;
    case 'Date': { const d = dateText(v); return d ? `ISODate("${d}")` : `new Date(${dateMs(v)})`; }
    case 'UUID': if (v.$binary) { const u = uuidText(v.$binary.base64); if (u) return `UUID("${u}")`; } break;
    default:
  }
  if ('$binary' in v && typeOf(v) !== 'Object') return `BinData(${parseInt(v.$binary.subType, 16) || 0}, "${v.$binary.base64}")`;
  if ('$timestamp' in v && typeOf(v) === 'Timestamp') return `Timestamp({ t: ${v.$timestamp.t}, i: ${v.$timestamp.i} })`;
  if ('$regularExpression' in v && typeOf(v) === 'RegExp') return `/${String(v.$regularExpression.pattern).replace(/(^|[^\\])\//g, '$1\\/')}/${v.$regularExpression.options || ''}`;
  if (t === 'MinKey') return 'MinKey()';
  if (t === 'MaxKey') return 'MaxKey()';
  if (t === 'Undefined') return 'undefined';
  if (t === 'Code') return `Code(${JSON.stringify(v.$code)})`;
  if (t === 'Symbol') return `Symbol(${JSON.stringify(v.$symbol)})`;
  if ('$zovoTrunc' in v && Object.keys(v).length === 1) return `${JSON.stringify(v.$zovoTrunc.s)} /* … ${v.$zovoTrunc.n.toLocaleString('en-US')} characters in all */`;
  if ('$zovoBin' in v && Object.keys(v).length === 1) return `BinData(${parseInt(v.$zovoBin.subType, 16) || 0}, /* ${v.$zovoBin.n.toLocaleString('en-US')} bytes, not loaded */)`;
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  const parts = keys.map((k) => `${keyText(k)}:${sp}${format(v[k], opts, depth + 1)}`);
  if (!ind) return `{ ${parts.join(', ')} }`;
  return `{${nl}${parts.map((x) => pad(depth + 1) + x).join(`,${nl}`)}${nl}${pad(depth)}}`;
}

/** Plain text of a scalar for the grid, CSV and the cell editor: strings without quotes, numbers exact, dates ISO. */
function plain(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  switch (typeOf(v)) {
    case 'ObjectId': return v.$oid;
    case 'Int32': return String(v.$numberInt);
    case 'Int64': return String(v.$numberLong);
    case 'Double': { const n = Number(v.$numberDouble); return Number.isFinite(n) ? String(n) : String(v.$numberDouble); }
    case 'Decimal128': return String(v.$numberDecimal);
    case 'Date': return dateText(v) || dateMs(v);
    case 'UUID': return uuidText(v.$binary.base64) || v.$binary.base64;
    case 'String': return '$zovoTrunc' in v ? v.$zovoTrunc.s : '';
    default: return format(v, { indent: 0 });
  }
}

// ---------- parsing ----------

class ParseError extends Error {
  constructor(msg, pos, src) {
    const { line, col } = lineCol(src, pos);
    super(`${msg} (line ${line}, column ${col})`);
    this.pos = pos;
    this.line = line;
    this.col = col;
    this.friendly = true;
  }
}

function lineCol(src, pos) {
  const before = String(src).slice(0, Math.max(0, pos));
  const lines = before.split('\n');
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

/** Wire value of a number literal, keeping its exact text. Integers become Int32 or Int64, others Double. */
function numberWire(text) {
  const t = String(text).trim();
  if (/^[+-]?(Infinity|NaN)$/.test(t)) return { $numberDouble: t.replace(/^\+/, '') };
  if (/^[+-]?\d+$/.test(t)) {
    const b = BigInt(t);
    const s = b.toString();
    if (b >= BigInt(INT32_MIN) && b <= BigInt(INT32_MAX)) return { $numberInt: s };
    if (b >= INT64_MIN && b <= INT64_MAX) return { $numberLong: s };
    return { $numberDouble: String(Number(t)) };
  }
  if (/^[+-]?0x[0-9a-f]+$/i.test(t)) return numberWire(BigInt(t.replace(/^\+/, '')).toString());
  const n = Number(t);
  if (Number.isNaN(n)) throw new Error(`Not a number: ${t}`);
  return { $numberDouble: t.replace(/^\+/, '') };
}

const HEX24 = /^[0-9a-fA-F]{24}$/;

function dateWire(arg) {
  if (arg === undefined) return { $date: { $numberLong: String(Date.now()) } };
  let ms;
  if (typeof arg === 'string') {
    let s = arg.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00Z';
    else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    ms = Date.parse(s);
  } else if (arg && typeof arg === 'object' && ('$numberInt' in arg || '$numberLong' in arg || '$numberDouble' in arg)) {
    ms = Number(arg.$numberInt || arg.$numberLong || arg.$numberDouble);
  } else ms = Number(arg);
  if (!Number.isFinite(ms)) throw new Error(`Not a date: ${typeof arg === 'string' ? arg : JSON.stringify(arg)}`);
  return { $date: { $numberLong: String(Math.trunc(ms)) } };
}

function hexToB64(hex) {
  const tbl = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += tbl[(n >> 18) & 63] + tbl[(n >> 12) & 63] + (b === undefined ? '=' : tbl[(n >> 6) & 63]) + (c === undefined ? '=' : tbl[n & 63]);
  }
  return out;
}

function uuidWire(s) {
  const hex = String(s).replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`Not a UUID: ${s}`);
  return { $binary: { base64: hexToB64(hex.toLowerCase()), subType: '04' } };
}

function intArg(a) {
  if (typeof a === 'string') return a.trim();
  if (a && typeof a === 'object') return String(a.$numberInt || a.$numberLong || a.$numberDouble || a.$numberDecimal || '');
  return String(a);
}

/** Constructors the parser knows: name -> (args, raw texts of the args) -> wire value. */
const CTORS = {
  ObjectId: (a) => { if (a[0] === undefined) return { $oid: randomOid() }; if (typeof a[0] !== 'string' || !HEX24.test(a[0])) throw new Error('ObjectId needs 24 hex characters'); return { $oid: a[0].toLowerCase() }; },
  ISODate: (a) => dateWire(a[0]),
  Date: (a) => dateWire(a[0]),
  NumberLong: (a, raw) => { const s = typeof a[0] === 'string' ? a[0].trim() : (raw[0] || '').trim(); if (!/^[+-]?\d+$/.test(s)) throw new Error('NumberLong needs a whole number, best in quotes: NumberLong("9007199254740993")'); const b = BigInt(s); if (b < INT64_MIN || b > INT64_MAX) throw new Error('The number is outside the 64-bit range'); return { $numberLong: b.toString() }; },
  NumberInt: (a, raw) => { const s = typeof a[0] === 'string' ? a[0].trim() : (raw[0] || '').trim(); if (!/^[+-]?\d+$/.test(s)) throw new Error('NumberInt needs a whole number'); const b = BigInt(s); if (b < BigInt(INT32_MIN) || b > BigInt(INT32_MAX)) throw new Error('The number is outside the 32-bit range'); return { $numberInt: b.toString() }; },
  NumberDecimal: (a, raw) => { const s = typeof a[0] === 'string' ? a[0].trim() : (raw[0] || '').trim(); if (!/^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|Infinity|NaN|Inf)$/i.test(s)) throw new Error('NumberDecimal needs a number, best in quotes: NumberDecimal("0.10")'); return { $numberDecimal: s.replace(/^\+/, '') }; },
  Double: (a, raw) => { const s = typeof a[0] === 'string' ? a[0].trim() : (raw[0] || '').trim(); if (Number.isNaN(Number(s)) && !/^-?(Infinity|NaN)$/.test(s)) throw new Error('Double needs a number'); return { $numberDouble: s.replace(/^\+/, '') }; },
  BinData: (a) => { const st = Number(intArg(a[0])); if (!(st >= 0 && st <= 255) || typeof a[1] !== 'string') throw new Error('BinData needs a subtype and base64 text: BinData(0, "AQID")'); return { $binary: { base64: a[1], subType: st.toString(16).padStart(2, '0') } }; },
  HexData: (a) => { const st = Number(intArg(a[0])); if (typeof a[1] !== 'string' || !/^([0-9a-fA-F]{2})*$/.test(a[1])) throw new Error('HexData needs a subtype and hex text'); return { $binary: { base64: hexToB64(a[1]), subType: st.toString(16).padStart(2, '0') } }; },
  UUID: (a) => uuidWire(a[0] === undefined ? randomUuid() : a[0]),
  Timestamp: (a) => {
    if (a[0] && typeof a[0] === 'object' && !isWrapper(a[0])) return { $timestamp: { t: Number(intArg(a[0].t)), i: Number(intArg(a[0].i)) } };
    return { $timestamp: { t: Number(intArg(a[0] === undefined ? 0 : a[0])), i: Number(intArg(a[1] === undefined ? 0 : a[1])) } };
  },
  MinKey: () => ({ $minKey: 1 }),
  MaxKey: () => ({ $maxKey: 1 }),
  RegExp: (a) => ({ $regularExpression: { pattern: String(a[0] === undefined ? '' : a[0]), options: sortFlags(a[1] || '') } }),
  Code: (a) => ({ $code: String(a[0] || '') }),
};
CTORS.ObjectID = CTORS.ObjectId;
CTORS.Long = CTORS.NumberLong;
CTORS.Int32 = CTORS.NumberInt;
CTORS.Decimal128 = CTORS.NumberDecimal;

function sortFlags(f) {
  return [...new Set(String(f).split(''))].filter((c) => 'imsux'.includes(c)).sort().join('');
}

function randomHex(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
function randomOid() {
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + randomHex(16);
}
function randomUuid() {
  const h = randomHex(32).split('');
  h[12] = '4';
  h[16] = '89ab'[Math.floor(Math.random() * 4)];
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * Parse shell syntax (relaxed JSON: unquoted keys, single quotes, comments, trailing commas, ObjectId(...),
 * ISODate(...), NumberLong(...), /regex/i ...) into a wire value. Never evaluates code.
 */
function parse(src) {
  const s = String(src);
  let i = 0;
  const err = (m, at) => { throw new ParseError(m, at === undefined ? i : at, s); };
  const ws = () => {
    for (;;) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿' || c === ' ') { i++; continue; }
      if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); if (e < 0) err('A comment is not closed'); i = e + 2; continue; }
      break;
    }
  };
  const str = () => {
    const q = s[i];
    const start = i;
    i++;
    let out = '';
    while (i < s.length) {
      const c = s[i];
      if (c === q) { i++; return out; }
      if (c === '\\') {
        const n = s[i + 1];
        i += 2;
        if (n === 'n') out += '\n';
        else if (n === 't') out += '\t';
        else if (n === 'r') out += '\r';
        else if (n === 'b') out += '\b';
        else if (n === 'f') out += '\f';
        else if (n === '0') out += '\0';
        else if (n === 'u') { const hx = s.slice(i, i + 4); if (!/^[0-9a-fA-F]{4}$/.test(hx)) err('Bad \\u escape', i - 2); out += String.fromCharCode(parseInt(hx, 16)); i += 4; }
        else if (n === 'x') { const hx = s.slice(i, i + 2); if (!/^[0-9a-fA-F]{2}$/.test(hx)) err('Bad \\x escape', i - 2); out += String.fromCharCode(parseInt(hx, 16)); i += 2; }
        else if (n === '\n') { /* line continuation */ }
        else if (n === undefined) err('A string is not closed', start);
        else out += n;
        continue;
      }
      if (c === '\n' && q !== '`') err('A string is not closed before the end of the line', start);
      out += c;
      i++;
    }
    return err('A string is not closed', start);
  };
  const ident = () => {
    const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i, i + 200));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const numLit = () => {
    const m = /^[+-]?(0x[0-9a-fA-F]+|Infinity|NaN|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(s.slice(i, i + 400));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const regex = () => {
    const start = i;
    i++;
    let pat = '';
    let cls = false;
    while (i < s.length) {
      const c = s[i];
      if (c === '\n') err('A regular expression is not closed', start);
      if (c === '\\') { pat += c + (s[i + 1] || ''); i += 2; continue; }
      if (c === '[') cls = true;
      else if (c === ']') cls = false;
      else if (c === '/' && !cls) break;
      pat += c;
      i++;
    }
    if (s[i] !== '/') err('A regular expression is not closed', start);
    i++;
    const fm = /^[a-z]*/.exec(s.slice(i));
    i += fm[0].length;
    return { $regularExpression: { pattern: pat.replace(/\\\//g, '/'), options: sortFlags(fm[0]) } };
  };
  const value = () => {
    ws();
    const c = s[i];
    if (c === undefined) err('The text ends where a value was expected');
    if (c === '{') return obj();
    if (c === '[') return arr();
    if (c === '"' || c === "'" || c === '`') return str();
    if (c === '/') return regex();
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) {
      const at = i;
      const n = numLit();
      if (n === null) err('Unexpected character', at);
      try { return numberWire(n); } catch (e) { return err(e.message, at); }
    }
    const at = i;
    let id = ident();
    if (id === null) err(`Unexpected character ${JSON.stringify(c)}`);
    if (id === 'new') { ws(); const id2 = ident(); if (!id2) err('Expected a name after new'); id = id2; }
    if (id === 'true') return true;
    if (id === 'false') return false;
    if (id === 'null') return null;
    if (id === 'undefined') return { $undefined: true };
    if (id === 'Infinity' || id === 'NaN') return { $numberDouble: id };
    ws();
    if (s[i] === '(') {
      const ctor = CTORS[id];
      if (!ctor) err(`Unknown function ${id}(). Known: ObjectId, ISODate, NumberLong, NumberInt, NumberDecimal, Double, BinData, UUID, Timestamp, MinKey, MaxKey`, at);
      i++;
      const args = [];
      const raws = [];
      ws();
      while (s[i] !== ')') {
        ws();
        const a0 = i;
        args.push(value());
        raws.push(s.slice(a0, i));
        ws();
        if (s[i] === ',') { i++; ws(); continue; }
        if (s[i] !== ')') err(`Expected , or ) in ${id}(...)`);
      }
      i++;
      try { return ctor(args, raws); } catch (e) { return err(`${id}: ${e.message}`, at); }
    }
    if (CTORS[id] && (id === 'MinKey' || id === 'MaxKey')) return CTORS[id]([], []);
    return err(`Unexpected word ${id}. Put text in quotes: "${id}"`, at);
  };
  const obj = () => {
    i++;
    const out = {};
    ws();
    while (s[i] !== '}') {
      ws();
      let k;
      const at = i;
      if (s[i] === '"' || s[i] === "'") k = str();
      else {
        const m = /^[^\s:,{}[\]"'/]+/.exec(s.slice(i, i + 1000));
        if (!m) err('Expected a field name');
        k = m[0];
        i += k.length;
      }
      ws();
      if (s[i] !== ':') err(`Expected : after the field name ${JSON.stringify(k)}`);
      i++;
      if (Object.prototype.hasOwnProperty.call(out, k)) err(`The field ${JSON.stringify(k)} appears twice`, at);
      out[k] = value();
      ws();
      if (s[i] === ',') { i++; ws(); continue; }
      if (s[i] !== '}') err(s[i] === undefined ? 'A { is not closed' : 'Expected , or }');
    }
    i++;
    return out;
  };
  const arr = () => {
    i++;
    const out = [];
    ws();
    while (s[i] !== ']') {
      out.push(value());
      ws();
      if (s[i] === ',') { i++; ws(); continue; }
      if (s[i] !== ']') err(s[i] === undefined ? 'A [ is not closed' : 'Expected , or ]');
    }
    i++;
    return out;
  };
  ws();
  if (i >= s.length) throw new ParseError('Empty text', 0, s);
  const v = value();
  ws();
  if (s[i] === ';') { i++; ws(); }
  if (i < s.length) err('Unexpected text after the value');
  return v;
}

/** Parse a query bar box: empty means the default ({} for a filter). Must be a document. */
function parseDoc(text, what = 'The filter') {
  const t = String(text || '').trim();
  if (!t) return {};
  const v = parse(t);
  if (!v || typeof v !== 'object' || Array.isArray(v) || isWrapper(v)) throw Object.assign(new Error(`${what} must be a document in braces, for example { name: "Ada" }`), { friendly: true });
  return v;
}

/** Parse a pipeline: an array of stage documents. */
function parsePipeline(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const v = parse(t);
  const arr = Array.isArray(v) ? v : [v];
  arr.forEach((st, n) => {
    if (!st || typeof st !== 'object' || Array.isArray(st) || isWrapper(st)) throw Object.assign(new Error(`Stage ${n + 1} must be a document such as { $match: { ... } }`), { friendly: true });
    const k = Object.keys(st);
    if (k.length !== 1 || !k[0].startsWith('$')) throw Object.assign(new Error(`Stage ${n + 1} must have exactly one stage name starting with $, for example { $match: { ... } }. It has: ${k.join(', ') || 'nothing'}`), { friendly: true });
  });
  return arr;
}

const TYPES = ['String', 'Int32', 'Int64', 'Double', 'Decimal128', 'Boolean', 'Date', 'ObjectId', 'Null', 'Object', 'Array', 'UUID', 'Timestamp', 'RegExp', 'Binary'];

/**
 * The wire value for what a user typed in the cell editor with a chosen type. Strings are taken as typed
 * (no quotes needed). Numbers keep their exact text. Objects and arrays take shell syntax.
 */
function fromText(text, type) {
  const t = String(text);
  const tt = t.trim();
  const bad = (m) => { throw Object.assign(new Error(m), { friendly: true }); };
  switch (type) {
    case 'String': return t;
    case 'Int32': { if (!/^[+-]?\d+$/.test(tt)) bad('Int32 needs a whole number'); const b = BigInt(tt); if (b < BigInt(INT32_MIN) || b > BigInt(INT32_MAX)) bad('The number is outside the Int32 range (use Int64)'); return { $numberInt: b.toString() }; }
    case 'Int64': { if (!/^[+-]?\d+$/.test(tt)) bad('Int64 needs a whole number'); const b = BigInt(tt); if (b < INT64_MIN || b > INT64_MAX) bad('The number is outside the Int64 range'); return { $numberLong: b.toString() }; }
    case 'Double': { if (!/^[+-]?((\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|Infinity|NaN)$/.test(tt)) bad('Double needs a number such as 1.5'); return { $numberDouble: tt.replace(/^\+/, '') }; }
    case 'Decimal128': { if (!/^[+-]?((\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|Infinity|NaN)$/i.test(tt)) bad('Decimal128 needs a number such as 0.10'); return { $numberDecimal: tt.replace(/^\+/, '') }; }
    case 'Boolean': { if (!/^(true|false)$/i.test(tt)) bad('Boolean is true or false'); return tt.toLowerCase() === 'true'; }
    case 'Date': try { return dateWire(/^-?\d+$/.test(tt) ? Number(tt) : tt); } catch { return bad('Date needs an ISO date such as 2024-05-01T10:00:00Z, or milliseconds since 1970'); }
    case 'ObjectId': { const h = tt.replace(/^ObjectId\(["']?|["']?\)$/g, ''); if (!HEX24.test(h)) bad('ObjectId needs 24 hex characters'); return { $oid: h.toLowerCase() }; }
    case 'Null': return null;
    case 'UUID': try { return uuidWire(tt.replace(/^UUID\(["']?|["']?\)$/g, '')); } catch (e) { return bad(e.message); }
    case 'Object': { const v = parse(tt || '{}'); if (!v || typeof v !== 'object' || Array.isArray(v) || isWrapper(v)) bad('Object needs a document in braces'); return v; }
    case 'Array': { const v = parse(tt || '[]'); if (!Array.isArray(v)) bad('Array needs a list in brackets'); return v; }
    default: return parse(tt);
  }
}

/** Text for the cell editor for a value and the type it will be edited as. */
function toText(v, type) {
  const t = type || typeOf(v);
  if (t === 'Object' || t === 'Array') return format(v, { indent: 2 });
  if (t === 'Null') return '';
  if (['Timestamp', 'RegExp', 'Binary', 'MinKey', 'MaxKey', 'Code', 'Symbol', 'Undefined', 'DBPointer'].includes(t)) return format(v, { indent: 0 });
  return plain(v);
}

/** Field paths of a sample of wire documents, dotted, depth-limited, with how often each is present. */
function samplePaths(docs, maxDepth = 4, max = 2000) {
  const seen = new Map();
  const walk = (v, pre, d) => {
    if (!isContainer(v) || Array.isArray(v) || d > maxDepth) return;
    for (const k of Object.keys(v)) {
      const p = pre ? `${pre}.${k}` : k;
      if (seen.size >= max && !seen.has(p)) continue;
      seen.set(p, (seen.get(p) || 0) + 1);
      const x = v[k];
      if (Array.isArray(x)) { for (const el of x.slice(0, 20)) walk(el, p, d + 1); } else walk(x, p, d + 1);
    }
  };
  for (const doc of docs) walk(doc, '', 1);
  return [...seen.entries()].map(([path, n]) => ({ path, n }));
}

module.exports = {
  typeOf, isWrapper, isContainer, isTruncated, format, inline, plain, parse, parseDoc, parsePipeline, numberWire, fromText, toText,
  samplePaths, keyText, uuidText, dateWire, TYPES, ParseError, b64ToHex, hexToB64,
};
