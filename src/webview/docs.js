// Documents page: query bar (filter, projection, sort, limit, skip with field autocomplete), a virtual grid
// (top-level fields as columns, documents and arrays open into sub-columns), the JSON view of the selected
// document, and inline edits that the host writes with { _id: <exact _id> } filters.

import { h, debounce } from './dom.js';
import shell from '../core/shell.js';

const ROW_H = 24;
const OVERSCAN = 10;
const MAX_COLS = 400;
const OPERATORS = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$type', '$regex', '$options', '$and', '$or', '$nor', '$not', '$elemMatch', '$size', '$all', '$expr', '$text', '$search', '$near', '$geoWithin', '$mod'];
const SEP = '\u0000';

export function startDocs(vscode, app, data) {
  const saved = vscode.getState() || {};
  const st = {
    docs: [], done: true, running: false, sel: new Set(), focus: -1, expanded: new Set(saved.expanded || []), widths: saved.widths || {},
    view: saved.view || 'both', fields: [], cols: [], openJson: new Map(), ms: 0, cut: 0,
  };
  const readOnly = !!data.readOnly;
  const isAgg = !!data.pipeline;

  // ---------- query bar ----------
  const q0 = Object.assign({ filter: '', projection: '', sort: '', limit: '', skip: '' }, saved.query || {}, data.query || {});
  const mkInput = (name, ph, cls) => { const el = h('input', { type: 'text', class: `qin ${cls || ''}`, id: `q-${name}`, placeholder: ph, spellcheck: 'false', autocomplete: 'off', 'aria-label': name }); el.value = q0[name] || ''; return el; };
  const filter = mkInput('filter', '{ field: "value" }   Filter, e.g. { age: { $gt: 30 }, "address.city": "Berlin" }', 'wide');
  const projection = mkInput('projection', '{ name: 1, email: 1 }');
  const sort = mkInput('sort', '{ _id: -1 }');
  const limit = mkInput('limit', '0 = no limit', 'num');
  const skip = mkInput('skip', '0', 'num');
  const findBtn = h('button', { class: 'btn primary', title: 'Run the query (Enter)' }, 'Find');
  const moreBtn = h('button', { class: 'btn', title: 'Projection, sort, limit and skip', 'aria-expanded': 'false' }, 'Options');
  const explainBtn = h('button', { class: 'btn', title: 'Explain: how the server runs this query' }, 'Explain');
  const exportBtn = h('button', { class: 'btn', title: 'Export the query result to JSON, JSONL or CSV (streamed)' }, 'Export');
  const insertBtn = h('button', { class: 'btn', title: 'Insert a document' }, 'Insert');
  const bulkBtn = h('button', { class: 'btn', title: 'Update or delete every document that matches the filter' }, 'Bulk ▾');
  const cancelBtn = h('button', { class: 'btn danger hidden', title: 'Stop the query on the server' }, 'Cancel');
  const spinner = h('span', { class: 'spinner hidden', 'aria-hidden': 'true' });
  // One bar: the query bar for a collection, or the pipeline line for an aggregation result. (A DOM node has one
  // parent, so the shared buttons go into exactly one of them.)
  const bar1 = isAgg
    ? h('div', { class: 'qbar' }, h('span', { class: 'qlabel' }, 'Pipeline'), h('code', { class: 'pipe', title: data.pipeline || '' }, data.pipeline || ''), spinner, cancelBtn, h('span', { class: 'grow' }), explainBtn, exportBtn)
    : h('div', { class: 'qbar' }, h('span', { class: 'qlabel' }, 'Filter'), filter, findBtn, moreBtn, spinner, cancelBtn, h('span', { class: 'grow' }), explainBtn, exportBtn);
  if (!readOnly && !isAgg) bar1.append(insertBtn, bulkBtn);
  const bar2 = h('div', { class: 'qbar opts' }, h('span', { class: 'qlabel' }, 'Project'), projection, h('span', { class: 'qlabel' }, 'Sort'), sort, h('span', { class: 'qlabel' }, 'Limit'), limit, h('span', { class: 'qlabel' }, 'Skip'), skip);
  const optsOpen = () => !!(projection.value.trim() || sort.value.trim() || limit.value.trim() || skip.value.trim());
  let showOpts = optsOpen();
  const errBox = h('div', { class: 'error hidden', role: 'alert' });
  const roNote = readOnly && data.roReason ? h('div', { class: 'ro-note' }, `🔒 ${data.roReason}`) : null;

  // ---------- grid ----------
  const scroller = h('div', { class: 'scroller', tabindex: '0', role: 'grid', 'aria-label': `Documents of ${data.ns}` });
  const sizer = h('div', { class: 'sizer' });
  const head = h('div', { class: 'head' });
  const body = h('div', { class: 'body' });
  sizer.append(head, body);
  scroller.append(sizer);
  const empty = h('div', { class: 'empty hidden' });
  const gridWrap = h('div', { class: 'grid-wrap' }, scroller, empty);

  // ---------- JSON view ----------
  const jsonHead = h('div', { class: 'json-head' });
  const jsonBody = h('div', { class: 'json-body', tabindex: '0' });
  const jsonPane = h('div', { class: 'json-pane' }, jsonHead, jsonBody);
  const split = h('div', { class: 'split', role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' });
  const main = h('div', { class: 'main' }, gridWrap, split, jsonPane);

  // ---------- status ----------
  const statusText = h('span', { class: 'status-text' });
  const loadMore = h('button', { class: 'btn small hidden', title: 'Read the next page from the server cursor' }, 'Load more');
  const viewSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'View' });
  for (const [id, label] of [['table', 'Table'], ['json', 'JSON'], ['both', 'Both']]) {
    const b = h('button', { class: 'seg-btn', role: 'radio', 'data-v': id }, label);
    b.addEventListener('click', () => { st.view = id; layout(); persist(); });
    viewSeg.append(b);
  }
  const status = h('div', { class: 'status' }, statusText, loadMore, h('span', { class: 'grow' }), viewSeg);
  const supportLine = document.getElementById('zovo-support');
  if (supportLine) status.append(supportLine);
  const toastBox = h('div', { class: 'toast hidden', role: 'status', 'aria-live': 'polite' });
  const popup = h('div', { class: 'popup hidden', role: 'dialog' });
  const ac = h('div', { class: 'ac hidden', role: 'listbox' });

  app.append(bar1);
  if (!isAgg) app.append(bar2);
  if (roNote) app.append(roNote);
  app.append(errBox, main, status, toastBox, popup, ac);

  // ---------- helpers ----------
  const send = (m) => vscode.postMessage(m);
  const queryNow = () => ({ filter: filter.value, projection: projection.value, sort: sort.value, limit: limit.value, skip: skip.value });
  function persist() { vscode.setState({ query: queryNow(), view: st.view, expanded: [...st.expanded], widths: st.widths }); }
  function run() { hideAc(); persist(); send({ type: 'run', query: queryNow() }); }
  function showError(msg) { errBox.textContent = msg; errBox.classList.remove('hidden'); }
  function hideError() { errBox.classList.add('hidden'); errBox.textContent = ''; }
  let toastT = null;
  function toast(msg, bad) { toastBox.textContent = msg; toastBox.className = 'toast' + (bad ? ' bad' : ''); clearTimeout(toastT); toastT = setTimeout(() => toastBox.classList.add('hidden'), 3500); }
  function setRunning(on) { st.running = on; spinner.classList.toggle('hidden', !on); cancelBtn.classList.toggle('hidden', !on); findBtn.disabled = on; loadMore.disabled = on; }

  findBtn.addEventListener('click', run);
  cancelBtn.addEventListener('click', () => send({ type: 'cancel' }));
  moreBtn.addEventListener('click', () => { showOpts = !showOpts; layout(); });
  explainBtn.addEventListener('click', () => send({ type: 'explain', query: queryNow() }));
  exportBtn.addEventListener('click', () => send({ type: 'export', query: queryNow() }));
  insertBtn.addEventListener('click', () => openInsert());
  bulkBtn.addEventListener('click', (e) => openMenu(e.currentTarget, [
    ['Update matching documents…', () => send({ type: 'bulk', op: 'update', query: queryNow() })],
    ['Delete matching documents…', () => send({ type: 'bulk', op: 'delete', query: queryNow() })],
  ]));
  loadMore.addEventListener('click', () => send({ type: 'more' }));
  for (const el of [filter, projection, sort, limit, skip]) {
    el.addEventListener('keydown', (e) => {
      if (!ac.classList.contains('hidden') && acKey(e, el)) return;
      if (e.key === 'Enter') { e.preventDefault(); run(); }
    });
  }
  for (const el of [filter, projection, sort]) {
    el.addEventListener('input', () => suggest(el));
    el.addEventListener('blur', () => setTimeout(hideAc, 150));
  }

  // ---------- autocomplete of field names ----------
  let acItems = [];
  let acSel = 0;
  let acToken = null;
  function tokenAt(el) {
    const pos = el.selectionStart;
    const before = el.value.slice(0, pos);
    const m = /(["']?)([A-Za-z_$][\w.$]*)?$/.exec(before);
    if (!m) return null;
    const word = m[2] || '';
    const start = pos - word.length - m[1].length;
    const prev = before.slice(0, start).replace(/\s+$/, '').slice(-1);
    if (!['{', ',', ''].includes(prev) && !(prev === '[' && /\$(and|or|nor)\s*:\s*\[\s*$/.test(before.slice(0, start)))) return null;
    return { start, end: pos, word, quote: m[1] };
  }
  function suggest(el) {
    const t = tokenAt(el);
    if (!t || (!t.word && el.value.trim() !== '{}' && el.value.trim() !== '{')) { hideAc(); return; }
    const w = t.word.toLowerCase();
    const pool = w.startsWith('$') ? OPERATORS : st.fields;
    acItems = pool.filter((f) => f.toLowerCase().startsWith(w) && f !== t.word).slice(0, 12);
    if (!acItems.length) { const more = pool.filter((f) => f.toLowerCase().includes(w) && f !== t.word).slice(0, 12); acItems = more; }
    if (!acItems.length) { hideAc(); return; }
    acSel = 0;
    acToken = { el, ...t };
    ac.textContent = '';
    acItems.forEach((f, i) => {
      const it = h('div', { class: 'ac-item' + (i === 0 ? ' on' : ''), role: 'option' }, f);
      it.addEventListener('mousedown', (e) => { e.preventDefault(); acSel = i; acAccept(); });
      ac.append(it);
    });
    const r = el.getBoundingClientRect();
    ac.style.left = `${r.left + Math.min(t.start * 7, r.width - 160)}px`;
    ac.style.top = `${r.bottom + 2}px`;
    ac.classList.remove('hidden');
  }
  function hideAc() { ac.classList.add('hidden'); acToken = null; }
  function acKey(e, el) {
    if (!acToken || acToken.el !== el) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); acSel = (acSel + (e.key === 'ArrowDown' ? 1 : -1) + acItems.length) % acItems.length; [...ac.children].forEach((c, i) => c.classList.toggle('on', i === acSel)); return true; }
    if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); acAccept(); return true; }
    if (e.key === 'Escape') { e.preventDefault(); hideAc(); return true; }
    return false;
  }
  function acAccept() {
    const t = acToken;
    if (!t) return;
    const f = acItems[acSel];
    const needsQuote = !/^[A-Za-z_$][\w$]*$/.test(f);
    const text = t.quote ? `${f}${t.quote}: ` : (needsQuote ? `"${f}": ` : `${f}: `);
    const v = t.el.value;
    t.el.value = v.slice(0, t.start) + text + v.slice(t.end);
    const pos = t.start + text.length;
    t.el.setSelectionRange(pos, pos);
    hideAc();
    t.el.focus();
  }

  // ---------- columns ----------
  const pk = (path) => path.join(SEP);
  function computeCols() {
    const out = [];
    const seen = new Set();
    const add = (path) => { const k = pk(path); if (!seen.has(k) && out.length < MAX_COLS) { seen.add(k); out.push(path); } };
    const childKeys = (path) => {
      const keys = [];
      const ks = new Set();
      let arrLen = 0;
      for (const d of st.docs) {
        const v = getAt(d.w, path);
        if (Array.isArray(v)) arrLen = Math.max(arrLen, v.filter((x) => !(x && typeof x === 'object' && '$zovoMore' in x)).length);
        else if (shell.isContainer(v)) for (const k of Object.keys(v)) if (!ks.has(k)) { ks.add(k); keys.push(k); }
        if (keys.length > 200) break;
      }
      const res = keys.map((k) => path.concat([k]));
      for (let i = 0; i < Math.min(arrLen, 50); i++) res.push(path.concat([i]));
      return res;
    };
    const walk = (path) => {
      if (st.expanded.has(pk(path))) {
        const kids = childKeys(path);
        if (kids.length) { for (const k of kids) walk(k); return; }
      }
      add(path);
    };
    const top = [];
    const tk = new Set();
    for (const d of st.docs) for (const k of Object.keys(d.w || {})) if (!tk.has(k)) { tk.add(k); top.push(k); }
    top.sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0));
    for (const k of top) walk([k]);
    st.cols = out;
  }
  function getAt(w, path) {
    let cur = w;
    for (const p of path) {
      if (cur === null || typeof cur !== 'object') return undefined;
      if (Array.isArray(cur)) { if (typeof p !== 'number') return undefined; cur = cur[p]; } else {
        if (shell.isWrapper(cur) || !Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
        cur = cur[p];
      }
    }
    return cur;
  }
  const colLabel = (path) => path.map((p, i) => (typeof p === 'number' ? `[${p}]` : (i ? `.${p}` : p))).join('');
  function colWidth(path) {
    const k = pk(path);
    if (st.widths[k]) return st.widths[k];
    const label = colLabel(path);
    let w = Math.min(Math.max(label.length * 7.5 + 34, 70), 360);
    for (let i = 0; i < Math.min(st.docs.length, 60); i++) {
      const v = getAt(st.docs[i].w, path);
      w = Math.max(w, Math.min(cellText(v).length * 7 + 26, 360));
    }
    st.widths[k] = Math.round(w);
    return st.widths[k];
  }

  function cellText(v) {
    if (v === undefined) return '';
    if (Array.isArray(v)) { const more = v.length && v[v.length - 1] && typeof v[v.length - 1] === 'object' && '$zovoMore' in v[v.length - 1] ? v[v.length - 1].$zovoMore + v.length - 1 : v.length; return `[${more} item${more === 1 ? '' : 's'}]`; }
    if (shell.isContainer(v)) { const n = Object.keys(v).length; return `{${n} field${n === 1 ? '' : 's'}}`; }
    const t = shell.typeOf(v);
    if (t === 'Null') return 'null';
    if (t === 'String' && v && typeof v === 'object') return `${v.$zovoTrunc.s.slice(0, 300).replace(/\s+/g, ' ')}… (${v.$zovoTrunc.n.toLocaleString('en-US')} chars)`;
    if (t === 'String') return v.length > 300 ? v.slice(0, 300).replace(/[\r\n\t]+/g, ' ') + '…' : v.replace(/[\r\n\t]+/g, ' ');
    if (t === 'Binary' && v.$zovoBin) return `Binary ${v.$zovoBin.n.toLocaleString('en-US')} bytes`;
    return shell.plain(v).slice(0, 300);
  }
  const TYPE_CLASS = { String: 'v-str', Int32: 'v-num', Int64: 'v-num', Double: 'v-num', Decimal128: 'v-num', Boolean: 'v-bool', Null: 'v-null', Date: 'v-date', ObjectId: 'v-oid', Object: 'v-obj', Array: 'v-obj' };

  // ---------- render grid ----------
  let colX = [];
  function render(resetScroll) {
    computeCols();
    colX = [];
    let x = 48;
    for (const c of st.cols) { colX.push(x); x += colWidth(c); }
    sizer.style.width = `${x}px`;
    body.style.height = `${st.docs.length * ROW_H}px`;
    if (resetScroll) { scroller.scrollTop = 0; }
    renderHead();
    renderRows();
    renderEmpty();
    renderStatus();
  }

  function visibleCols() {
    const left = scroller.scrollLeft;
    const right = left + scroller.clientWidth;
    let a = 0;
    while (a < st.cols.length && colX[a] + colWidth(st.cols[a]) < left) a++;
    let b = a;
    while (b < st.cols.length && colX[b] < right) b++;
    return [Math.max(0, a - 2), Math.min(st.cols.length, b + 2)];
  }

  function renderHead() {
    head.textContent = '';
    const row = h('div', { class: 'row hrow' });
    row.append(h('div', { class: 'cell num', style: 'width:48px;left:0', title: 'Row number. Click a row to select it; Ctrl/Cmd or Shift adds more.' }, '#'));
    const [a, b] = visibleCols();
    const sortSpec = parseSortSafe();
    for (let i = a; i < b; i++) {
      const path = st.cols[i];
      const k = pk(path);
      const w = colWidth(path);
      const label = colLabel(path);
      const parentExpanded = path.length > 1;
      const sorted = sortSpec && sortSpec[path.join('.')];
      const cell = h('div', { class: 'cell hcell', style: `width:${w}px;left:${colX[i]}px`, title: `${label}\nClick: sort on the server (ascending, descending, none)` },
        parentExpanded ? h('span', { class: 'collapse', title: `Close ${colLabel(path.slice(0, -1))} back into one column` }, '◂') : null,
        h('span', { class: 'hname' }, label),
        sorted ? h('span', { class: 'sorti' }, sorted > 0 ? '▲' : '▼') : null);
      cell.addEventListener('click', (e) => {
        if (e.target.classList.contains('grip')) return;
        if (e.target.classList.contains('collapse')) { collapseTo(path.slice(0, -1)); return; }
        if (isAgg) return;
        const dotted = path.join('.');
        const cur = sortSpec ? sortSpec[dotted] : 0;
        const next = cur === 1 ? -1 : cur === -1 ? 0 : 1;
        const key = /^[A-Za-z_$][\w$]*$/.test(dotted) ? dotted : JSON.stringify(dotted);
        sort.value = next ? `{ ${key}: ${next} }` : '';
        if (sort.value) showOpts = true;
        layout();
        run();
      });
      const grip = h('div', { class: 'grip' });
      grip.addEventListener('mousedown', (e) => startResize(e, k));
      cell.append(grip);
      row.append(cell);
    }
    head.append(row);
  }

  function parseSortSafe() {
    try { const v = shell.parseDoc(sort.value, 'sort'); const out = {}; for (const k of Object.keys(v)) { const x = v[k]; const n = Number(x && typeof x === 'object' ? (x.$numberInt || x.$numberDouble || x.$numberLong) : x); out[k] = n; } return out; } catch { return null; }
  }

  function collapseTo(path) {
    for (const k of [...st.expanded]) if (k === pk(path) || k.startsWith(pk(path) + SEP)) st.expanded.delete(k);
    persist();
    render(false);
  }

  function startResize(e, k) {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = st.widths[k];
    const mv = (ev) => { st.widths[k] = Math.max(48, w0 + ev.clientX - x0); render(false); };
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); persist(); };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  }

  function renderRows() {
    body.textContent = '';
    const top = scroller.scrollTop;
    const hgt = scroller.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(st.docs.length, Math.ceil((top + hgt) / ROW_H) + OVERSCAN);
    const [a, b] = visibleCols();
    const frag = document.createDocumentFragment();
    for (let r = first; r < last; r++) {
      const d = st.docs[r];
      const row = h('div', { class: 'row' + (st.sel.has(r) ? ' sel' : '') + (r === st.focus ? ' focus' : ''), style: `top:${r * ROW_H}px`, 'data-r': r, role: 'row', 'aria-rowindex': r + 2 });
      row.append(h('div', { class: 'cell num', style: 'width:48px;left:0', title: d.cut ? 'Some values of this document are shortened for display.' : '' }, `${r + 1}${d.cut ? '✂' : ''}`));
      for (let i = a; i < b; i++) {
        const path = st.cols[i];
        const v = getAt(d.w, path);
        const t = v === undefined ? 'missing' : shell.typeOf(v);
        const cont = v !== undefined && shell.isContainer(v);
        const cell = h('div', { class: `cell ${v === undefined ? 'v-missing' : (TYPE_CLASS[t] || 'v-other')}`, style: `width:${colWidth(path)}px;left:${colX[i]}px`, 'data-c': i, role: 'gridcell', title: v === undefined ? 'No such field in this document' : `${t}${cont ? ' (click ▸ to open it into columns)' : ''}` });
        if (cont) {
          const tw = h('span', { class: 'twisty', title: 'Open into columns' }, '▸');
          tw.addEventListener('click', (e) => { e.stopPropagation(); st.expanded.add(pk(path)); persist(); render(false); });
          cell.append(tw);
        }
        cell.append(document.createTextNode(cellText(v)));
        row.append(cell);
      }
      frag.append(row);
    }
    body.append(frag);
  }

  scroller.addEventListener('scroll', () => { renderRows(); renderHeadIfNeeded(); });
  let lastRange = '';
  function renderHeadIfNeeded() { const r = visibleCols().join(','); if (r !== lastRange) { lastRange = r; renderHead(); } }
  window.addEventListener('resize', debounce(() => render(false), 100));

  body.addEventListener('click', (e) => {
    const rowEl = e.target.closest('.row');
    if (!rowEl) return;
    const r = Number(rowEl.dataset.r);
    if (e.shiftKey && st.focus >= 0) { const [x, y] = [Math.min(st.focus, r), Math.max(st.focus, r)]; for (let i = x; i <= y; i++) st.sel.add(i); } else if (e.metaKey || e.ctrlKey) { if (st.sel.has(r)) st.sel.delete(r); else st.sel.add(r); } else { st.sel = new Set([r]); }
    st.focus = r;
    renderRows();
    renderJson();
    renderStatus();
  });
  body.addEventListener('dblclick', (e) => {
    const cellEl = e.target.closest('.cell');
    const rowEl = e.target.closest('.row');
    if (!cellEl || !rowEl || cellEl.dataset.c === undefined) return;
    const r = Number(rowEl.dataset.r);
    const path = st.cols[Number(cellEl.dataset.c)];
    openEditor(r, path, cellEl);
  });
  scroller.addEventListener('keydown', (e) => {
    if (!st.docs.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      st.focus = Math.max(0, Math.min(st.docs.length - 1, st.focus + (e.key === 'ArrowDown' ? 1 : -1)));
      st.sel = new Set([st.focus]);
      const y = (st.focus + 1) * ROW_H;
      if (y - ROW_H < scroller.scrollTop) scroller.scrollTop = y - ROW_H;
      if (y + ROW_H > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + ROW_H - scroller.clientHeight;
      renderRows(); renderJson(); renderStatus();
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && st.sel.size && !readOnly) { e.preventDefault(); deleteSelected(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'c' && st.sel.size) {
      e.preventDefault();
      const docs = [...st.sel].sort((x, y) => x - y).map((i) => shell.format(st.docs[i].w, { indent: 2 }));
      send({ type: 'copy', text: docs.length === 1 ? docs[0] : `[\n${docs.join(',\n')}\n]` });
    }
  });

  function deleteSelected() {
    const ids = [...st.sel].map((i) => st.docs[i] && st.docs[i].w._id).filter((x) => x !== undefined);
    if (ids.length) send({ type: 'delete', ids });
  }

  function renderEmpty() {
    const show = !st.docs.length && !st.running;
    empty.classList.toggle('hidden', !show);
    empty.textContent = show ? (st.lastError ? '' : 'No documents match. Change the filter, or insert a document.') : '';
  }

  function renderStatus() {
    const n = st.docs.length;
    statusText.textContent = `${n.toLocaleString('en-US')}${st.done ? '' : '+'} document${n === 1 ? '' : 's'}${st.sel.size > 1 ? ` · ${st.sel.size} selected` : ''}${st.ms ? ` · ${st.ms} ms` : ''}${st.cut ? ` · ${st.cut} shortened for display (✂)` : ''} · ${data.ns}`;
    loadMore.classList.toggle('hidden', st.done);
  }

  // ---------- JSON view ----------
  function renderJson() {
    jsonHead.textContent = '';
    jsonBody.textContent = '';
    const d = st.docs[st.focus];
    if (!d) { jsonBody.append(h('div', { class: 'json-empty' }, st.docs.length ? 'Click a row to see its document here.' : '')); return; }
    const editBtn = h('button', { class: 'btn small', title: d.cut ? 'This document is shortened for display. Open the full document to read it all.' : 'Edit the whole document as text' }, 'Edit JSON');
    editBtn.disabled = readOnly || d.cut;
    editBtn.addEventListener('click', () => openJsonEdit(st.focus));
    const copyBtn = h('button', { class: 'btn small', title: 'Copy the document as shell JSON' }, 'Copy');
    copyBtn.addEventListener('click', () => send({ type: 'copy', text: shell.format(d.w, { indent: 2 }) }));
    const fullBtn = h('button', { class: 'btn small', title: 'Open the whole document, with nothing shortened, in an editor tab' }, 'Open full');
    fullBtn.addEventListener('click', () => send({ type: 'openFull', id: d.w._id }));
    const delBtn = h('button', { class: 'btn small danger', title: 'Delete this document (asks first)' }, 'Delete');
    delBtn.addEventListener('click', () => { st.sel = new Set([st.focus]); deleteSelected(); });
    jsonHead.append(h('span', { class: 'json-title' }, `Document ${st.focus + 1}`), h('span', { class: 'grow' }), copyBtn);
    if (!isAgg) jsonHead.append(fullBtn);
    if (!readOnly) jsonHead.append(editBtn, delBtn);
    if (d.cut) jsonBody.append(h('div', { class: 'cut-note' }, '✂ Long values are shortened here. "Open full" shows everything. Shortened fields cannot be edited inline.'));
    jsonBody.append(tree(d.w, [], st.focus));
  }

  function tree(v, path, r) {
    const wrap = h('div', { class: 'jt' });
    const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
    for (const k of keys) {
      const x = v[k];
      if (x && typeof x === 'object' && !Array.isArray(x) && '$zovoMore' in x && Object.keys(x).length === 1) { wrap.append(h('div', { class: 'jl more' }, `… ${x.$zovoMore.toLocaleString('en-US')} more items (Open full)`)); continue; }
      const p = path.concat([k]);
      const key = typeof k === 'number' ? `[${k}]` : k;
      const t = shell.typeOf(x);
      if (shell.isContainer(x)) {
        const id = `${r}${SEP}${pk(p)}`;
        const open = st.openJson.has(id) ? st.openJson.get(id) : (path.length === 0 && (Array.isArray(x) ? x.length : Object.keys(x).length) <= 8);
        const line = h('div', { class: 'jl cont' }, h('span', { class: 'tw' }, open ? '▾' : '▸'), h('span', { class: 'jk' }, key), h('span', { class: 'jsum' }, Array.isArray(x) ? `Array (${x.length})` : `Object (${Object.keys(x).length})`));
        line.addEventListener('click', () => { st.openJson.set(id, !open); renderJson(); });
        wrap.append(line);
        if (open) wrap.append(h('div', { class: 'jchild' }, tree(x, p, r)));
      } else {
        const val = h('span', { class: `jv ${TYPE_CLASS[t] || 'v-other'}`, title: `${t}${readOnly ? '' : ' · double-click to edit'}` }, shell.format(x, { indent: 0 }));
        const line = h('div', { class: 'jl' }, h('span', { class: 'tw' }, ''), h('span', { class: 'jk' }, key), val, h('span', { class: 'jt-type' }, t));
        line.addEventListener('dblclick', () => openEditor(r, p, line));
        wrap.append(line);
      }
    }
    return wrap;
  }

  // ---------- editors ----------
  function closePopup() { popup.classList.add('hidden'); popup.textContent = ''; scroller.focus(); }
  function placePopup(anchor, w = 420) {
    const r = anchor.getBoundingClientRect();
    popup.style.width = `${Math.min(w, window.innerWidth - 20)}px`;
    popup.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - w - 10))}px`;
    const below = r.bottom + 4;
    popup.style.top = `${Math.max(6, Math.min(below, window.innerHeight - 280))}px`;
    popup.classList.remove('hidden');
  }

  function openEditor(r, path, anchor) {
    const d = st.docs[r];
    if (!d) return;
    if (readOnly) { toast(data.roReason || 'Read-only.'); return; }
    if (path[0] === '_id') { toast('The _id cannot change. Insert a copy with a new _id instead.'); return; }
    const v = getAt(d.w, path);
    if (v !== undefined && shell.isTruncated(v)) { toast('This value is shortened for display, so it cannot be edited here. Use "Open full".', true); return; }
    // the parent must exist (a missing field can be added only in an existing document or array)
    if (path.length > 1 && getAt(d.w, path.slice(0, -1)) === undefined) { toast('The parent field does not exist in this document. Edit the document as JSON to add it.', true); return; }
    const t0 = v === undefined ? 'String' : shell.typeOf(v);
    const typeSel = h('select', { class: 'type-sel', 'aria-label': 'Type' });
    for (const t of data.types.concat(data.types.includes(t0) ? [] : [t0])) { const o = h('option', { value: t }, t); if (t === t0) o.selected = true; typeSel.append(o); }
    const ta = h('textarea', { class: 'edit-ta', spellcheck: 'false', rows: shell.isContainer(v) ? '10' : '3', 'aria-label': 'Value' });
    ta.value = v === undefined ? '' : shell.toText(v, t0);
    const msg = h('div', { class: 'edit-msg' });
    const save = h('button', { class: 'btn primary' }, 'Save');
    const cancel = h('button', { class: 'btn' }, 'Cancel');
    const unset = h('button', { class: 'btn danger', title: 'Remove this field from the document' }, 'Remove field');
    popup.textContent = '';
    popup.append(h('div', { class: 'edit-title' }, `${colLabel(path)} `, h('span', { class: 'muted' }, v === undefined ? '(new field)' : `(${t0})`)),
      h('div', { class: 'edit-row' }, typeSel), ta, msg, h('div', { class: 'edit-btns' }, save, cancel, v !== undefined && typeof path[path.length - 1] !== 'number' ? unset : null, h('span', { class: 'hint' }, 'Enter saves · Shift+Enter new line · Esc cancels')));
    placePopup(anchor);
    ta.focus();
    ta.select();
    typeSel.addEventListener('change', () => {
      const nt = typeSel.value;
      if (v !== undefined && (nt === 'Object' || nt === 'Array' || shell.typeOf(v) === 'Object' || shell.typeOf(v) === 'Array')) ta.value = shell.toText(v, nt === shell.typeOf(v) ? nt : 'auto');
      if (nt === 'Null') ta.value = '';
      if (nt === 'Date' && !ta.value.trim()) ta.value = new Date().toISOString();
      if (nt === 'ObjectId' && v === undefined && !ta.value.trim()) ta.value = '';
    });
    const doSave = () => {
      msg.textContent = 'Saving…';
      save.disabled = true;
      pendingEdit = { msg, save };
      send({ type: 'edit', index: r, id: d.w._id, path, text: ta.value, valueType: typeSel.value });
    };
    save.addEventListener('click', doSave);
    cancel.addEventListener('click', closePopup);
    unset.addEventListener('click', () => { closePopup(); send({ type: 'unset', index: r, id: d.w._id, path }); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closePopup(); }
      if (e.key === 'Enter' && !e.shiftKey && !(typeSel.value === 'Object' || typeSel.value === 'Array')) { e.preventDefault(); doSave(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSave(); }
    });
  }
  let pendingEdit = null;

  function openJsonEdit(r) {
    const d = st.docs[r];
    if (!d) return;
    const ta = h('textarea', { class: 'edit-ta big', spellcheck: 'false', 'aria-label': 'Document' });
    ta.value = shell.format(d.w, { indent: 2 });
    const msg = h('div', { class: 'edit-msg' });
    const save = h('button', { class: 'btn primary' }, 'Save document');
    const cancel = h('button', { class: 'btn' }, 'Cancel');
    jsonBody.textContent = '';
    jsonBody.append(ta, msg, h('div', { class: 'edit-btns' }, save, cancel, h('span', { class: 'hint' }, 'Ctrl/Cmd+Enter saves. Types are kept: NumberLong, NumberDecimal, ISODate, ObjectId. 5 is Int32, 5.0 is Double.')));
    ta.focus();
    const doSave = () => { msg.textContent = 'Saving…'; save.disabled = true; pendingReplace = { msg, save }; send({ type: 'replace', index: r, id: d.w._id, text: ta.value }); };
    save.addEventListener('click', doSave);
    cancel.addEventListener('click', () => renderJson());
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSave(); } if (e.key === 'Escape') { e.preventDefault(); renderJson(); } });
  }
  let pendingReplace = null;

  function openInsert() {
    const ta = h('textarea', { class: 'edit-ta big', spellcheck: 'false', 'aria-label': 'New document' });
    ta.value = '{\n  \n}';
    const msg = h('div', { class: 'edit-msg' });
    const ok = h('button', { class: 'btn primary' }, 'Insert');
    const cancel = h('button', { class: 'btn' }, 'Cancel');
    popup.textContent = '';
    popup.append(h('div', { class: 'edit-title' }, `Insert into ${data.ns}`), ta, msg, h('div', { class: 'edit-btns' }, ok, cancel, h('span', { class: 'hint' }, 'A document, or [ a list ]. _id is added when missing. Ctrl/Cmd+Enter inserts.')));
    placePopup(insertBtn, 520);
    ta.focus();
    ta.setSelectionRange(4, 4);
    const go = () => { msg.textContent = 'Inserting…'; ok.disabled = true; pendingInsert = { msg, ok }; send({ type: 'insert', text: ta.value }); };
    ok.addEventListener('click', go);
    cancel.addEventListener('click', closePopup);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closePopup(); } if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } });
  }
  let pendingInsert = null;

  function openMenu(anchor, items) {
    popup.textContent = '';
    const menu = h('div', { class: 'menu', role: 'menu' });
    for (const [label, fn] of items) {
      const it = h('button', { class: 'menu-item', role: 'menuitem' }, label);
      it.addEventListener('click', () => { closePopup(); fn(); });
      menu.append(it);
    }
    popup.append(menu);
    placePopup(anchor, 240);
    menu.firstChild.focus();
  }
  document.addEventListener('mousedown', (e) => { if (!popup.classList.contains('hidden') && !popup.contains(e.target) && !e.target.closest('.btn')) closePopup(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !popup.classList.contains('hidden')) closePopup(); });

  // ---------- layout ----------
  function layout() {
    bar2.classList.toggle('hidden', !showOpts);
    moreBtn.setAttribute('aria-expanded', String(showOpts));
    const narrow = window.innerWidth < 760;
    const v = st.view === 'both' && narrow ? 'table' : st.view;
    gridWrap.classList.toggle('hidden', v === 'json');
    jsonPane.classList.toggle('hidden', v === 'table');
    split.classList.toggle('hidden', v !== 'both');
    jsonPane.classList.toggle('full', v === 'json');
    for (const b of viewSeg.children) { const on = b.dataset.v === st.view; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
    if (v === 'json' && st.focus < 0 && st.docs.length) st.focus = 0;
    render(false);
    renderJson();
  }
  split.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const mv = (ev) => { const w = Math.max(220, Math.min(window.innerWidth - 260, window.innerWidth - ev.clientX)); jsonPane.style.width = `${w}px`; render(false); };
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  });

  // ---------- messages ----------
  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    switch (m.type) {
      case 'running': setRunning(true); if (!m.more) hideError(); break;
      case 'result':
        setRunning(false); hideError(); st.lastError = null;
        st.docs = m.docs; st.done = m.done; st.ms = m.ms; st.cut = m.docs.filter((d) => d.cut).length; st.sel = new Set(); st.focus = m.docs.length ? 0 : -1;
        render(true); renderJson();
        break;
      case 'append':
        setRunning(false);
        for (const d of m.docs) st.docs.push(d);
        st.done = m.done; st.ms = m.ms; st.cut = st.docs.filter((d) => d.cut).length;
        render(false);
        break;
      case 'error':
        setRunning(false); st.lastError = m.message;
        if (!m.keep && !m.cancelled) { st.docs = []; st.done = true; render(true); renderJson(); }
        showError(m.message);
        if (m.where) { const el = { filter, projection, sort }[m.where]; if (el) { el.focus(); if (m.where !== 'filter') { showOpts = true; layout(); } } }
        break;
      case 'cancelled': setRunning(false); toast('Cancelled.'); break;
      case 'fields': st.fields = m.paths; break;
      case 'doc': if (st.docs[m.index]) { st.docs[m.index] = m.doc; render(false); if (st.focus === m.index) renderJson(); } break;
      case 'gone': toast('That document no longer exists.', true); break;
      case 'deleted': {
        const gone = new Set(m.ids.map((x) => JSON.stringify(x)));
        st.docs = st.docs.filter((d) => !gone.has(JSON.stringify(d.w._id)));
        st.sel = new Set(); st.focus = Math.min(st.focus, st.docs.length - 1);
        render(false); renderJson();
        break;
      }
      case 'editDone': if (pendingEdit) { if (m.ok) { closePopup(); toast(m.message); } else { pendingEdit.msg.textContent = m.message || 'Not saved.'; pendingEdit.msg.className = 'edit-msg bad'; pendingEdit.save.disabled = false; } } pendingEdit = null; break;
      case 'replaceDone': if (pendingReplace) { if (m.ok) toast(m.message); else { pendingReplace.msg.textContent = m.message || 'Not saved.'; pendingReplace.msg.className = 'edit-msg bad'; pendingReplace.save.disabled = false; } } pendingReplace = null; break;
      case 'insertDone': if (pendingInsert) { if (m.ok) { closePopup(); toast(m.message); } else { pendingInsert.msg.textContent = m.message || 'Not inserted.'; pendingInsert.msg.className = 'edit-msg bad'; pendingInsert.ok.disabled = false; } } pendingInsert = null; break;
      case 'toast': toast(m.message, m.bad); break;
      case 'setQuery': if (m.query) { for (const k of Object.keys(m.query)) { const el = { filter, projection, sort, limit, skip }[k]; if (el) el.value = m.query[k]; } showOpts = optsOpen(); layout(); if (m.run) run(); } break;
      default:
    }
  });

  layout();
  send({ type: 'ready' });
}
