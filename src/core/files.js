'use strict';
// Streaming readers for imports (JSON array, concatenated JSON documents, JSONL, CSV) and the CSV writer
// for exports. Pure Node: no driver. A file is never read into memory whole.

const fs = require('fs');
const readline = require('readline');
const { numberWire } = require('./shell');

/**
 * Yields { text, line } for every top-level value of a JSON file: the elements of a top-level array, or
 * each document when the file holds documents one after another (mongoexport style).
 */
async function* jsonValues(file, onBytes) {
  const input = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let mode = null; // 'array' | 'docs'
  let depth = 0;
  let inStr = false;
  let esc = false;
  let buf = '';
  let line = 1;
  let startLine = 1;
  let collecting = false;
  let done = false;
  let first = true;
  for await (let chunk of input) {
    if (onBytes) onBytes(Buffer.byteLength(chunk));
    if (first) { chunk = chunk.replace(/^﻿/, ''); first = false; }
    let from = 0;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (c === '\n') line++;
      if (done) {
        if (!/\s/.test(c)) throw Object.assign(new Error(`Line ${line}: unexpected text after the end of the top-level array`), { line, friendly: true });
        continue;
      }
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (mode === null) {
        if (/\s/.test(c)) continue;
        if (c === '[') { mode = 'array'; depth = 1; from = i + 1; continue; }
        if (c === '{') { mode = 'docs'; } else throw Object.assign(new Error(`Line ${line}: a JSON import file must start with [ or {`), { line, friendly: true });
      }
      const top = mode === 'array' ? 1 : 0;
      if (!collecting) {
        if (/\s/.test(c)) continue;
        if (mode === 'array' && depth === 1 && c === ']') { done = true; continue; }
        if (mode === 'array' && depth === 1 && c === ',') continue;
        collecting = true;
        startLine = line;
        from = i;
        buf = '';
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') { depth++; continue; }
      if (c === ']' && mode === 'array' && depth === 1) {
        // the end of the array right after a scalar element such as 5 or "x"
        buf += chunk.slice(from, i);
        collecting = false;
        done = true;
        if (buf.trim()) yield { text: buf.trim(), line: startLine };
        buf = '';
        continue;
      }
      if (c === '}' || c === ']') {
        depth--;
        if (depth < top) throw Object.assign(new Error(`Line ${line}: a ${c} has no matching opening bracket`), { line, friendly: true });
        if (depth === top) {
          buf += chunk.slice(from, i + 1);
          collecting = false;
          yield { text: buf, line: startLine };
          buf = '';
          from = i + 1;
        }
        continue;
      }
      if (mode === 'array' && depth === 1 && c === ',' && collecting) {
        // a scalar element such as 5 or "x"
        buf += chunk.slice(from, i);
        collecting = false;
        yield { text: buf.trim(), line: startLine };
        buf = '';
        from = i + 1;
      }
    }
    if (collecting) buf += chunk.slice(from);
    if (buf.length > 64 * 1024 * 1024) throw Object.assign(new Error(`Line ${startLine}: one value is larger than 64 MB. MongoDB documents are at most 16 MB.`), { line: startLine, friendly: true });
  }
  if (inStr || (collecting && buf.trim()) || (mode === 'array' && !done)) throw Object.assign(new Error(`Line ${startLine}: the file ends inside a value${mode === 'array' && !done ? ' (the top-level array is not closed)' : ''}`), { line: startLine, friendly: true });
}

/** Yields { text, line } for every non-empty line of a JSONL / NDJSON file. */
async function* jsonLines(file, onBytes) {
  const input = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  if (onBytes) input.on('data', (c) => onBytes(Buffer.byteLength(c)));
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let n = 0;
  for await (const raw of rl) {
    n++;
    const t = (n === 1 ? raw.replace(/^﻿/, '') : raw).trim();
    if (t) yield { text: t, line: n };
  }
}

/** Yields arrays of fields per CSV record (RFC 4180 quotes, newlines inside quotes) with the record's first line. */
async function* csvRecords(file, onBytes, sep) {
  const input = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  if (onBytes) input.on('data', (c) => onBytes(Buffer.byteLength(c)));
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let rec = [];
  let field = '';
  let inQ = false;
  let n = 0;
  let start = 1;
  let d = sep;
  for await (let line of rl) {
    n++;
    if (n === 1) {
      line = line.replace(/^﻿/, '');
      if (!d) { const counts = [',', ';', '\t', '|'].map((s) => [s, line.split(s).length]).sort((a, b) => b[1] - a[1]); d = counts[0][1] > 1 ? counts[0][0] : ','; }
    }
    if (!inQ) start = n;
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (inQ) {
        if (c === '"') { if (line[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"' && field === '') { inQ = true; i++; continue; }
      if (c === d) { rec.push(field); field = ''; i++; continue; }
      field += c; i++;
    }
    if (inQ) { field += '\n'; continue; }
    rec.push(field);
    yield { fields: rec, line: start };
    rec = []; field = '';
  }
  if (inQ) throw Object.assign(new Error(`Line ${start}: a quoted CSV field is not closed`), { line: start, friendly: true });
}

/** A CSV text field as a wire value: numbers keep their exact text, true/false become booleans, empty is left out. */
function csvValue(s) {
  const t = String(s);
  if (t === '') return undefined;
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(t) && t.length < 40) return numberWire(t);
  if (t === 'true' || t === 'false') return t === 'true';
  if (t === 'null') return null;
  return t;
}

/** A document (wire) from CSV header names (dotted names become nested fields) and one record. */
function csvDoc(header, fields) {
  const doc = {};
  header.forEach((h, i) => {
    const v = csvValue(fields[i] === undefined ? '' : fields[i]);
    if (v === undefined || !h) return;
    const parts = h.split('.');
    let cur = doc;
    for (let k = 0; k < parts.length - 1; k++) {
      if (!cur[parts[k]] || typeof cur[parts[k]] !== 'object' || Array.isArray(cur[parts[k]])) cur[parts[k]] = {};
      cur = cur[parts[k]];
    }
    cur[parts[parts.length - 1]] = v;
  });
  return doc;
}

function csvCell(s) {
  const t = String(s === undefined || s === null ? '' : s);
  return /[",\r\n]/.test(t) || /^\s|\s$/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** Writes text to a stream and waits for 'drain' when the stream's buffer is full (back pressure). */
function writer(stream) {
  return (text) => (stream.write(text) ? Promise.resolve() : new Promise((r) => stream.once('drain', r)));
}

module.exports = { jsonValues, jsonLines, csvRecords, csvValue, csvDoc, csvCell, writer };
