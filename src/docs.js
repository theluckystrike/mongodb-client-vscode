'use strict';
// The documents panel: one webview per collection (or per aggregation result) with the query bar, the grid,
// the JSON view and the edit actions. The host holds the cursor and sends pages of documents; the webview
// never gets more than a page, and values over the display limits arrive cut (see core/wire.js).

const shell = require('./core/shell');
const { buildHtml } = require('./html');
const { keepType } = require('./core/wire');

const panels = new Map();

class DocsPanel {
  /** deps: { vscode, context, sessions, store, settings, rating, onExplain, onExport, guardWrite } */
  static open(deps, target) {
    const key = target.pipeline ? `agg:${target.conn}:${target.database}:${target.collection}:${Date.now()}` : `col:${target.conn}:${target.database}:${target.collection}`;
    const existing = panels.get(key);
    if (existing) { existing.panel.reveal(); if (target.query) existing.post({ type: 'setQuery', query: target.query, run: true }); return existing; }
    const p = new DocsPanel(deps, target, key);
    panels.set(key, p);
    return p;
  }

  static all() { return [...panels.values()]; }

  constructor(deps, target, key) {
    this.deps = deps;
    this.t = target;
    this.key = key;
    this.pager = null;
    this.q = null;
    this.ok = false;
    const { vscode, context } = deps;
    const conn = deps.store.get(target.conn);
    const title = target.pipeline ? `Aggregation: ${target.collection}` : target.collection;
    this.panel = vscode.window.createWebviewPanel('zovoMongo.docs', title, target.column || vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, enableCommandUris: require('./support').commandUris('zovoMongo'), localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'collection.svg');
    const s = deps.settings();
    this.panel.webview.html = buildHtml({
      cspSource: this.panel.webview.cspSource,
      scriptUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js')).toString(),
      styleUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.css')).toString(),
      title, page: 'docs', showSupportLinks: s.showSupportLinks,
      data: {
        ns: `${target.database}.${target.collection}`, conn: conn ? conn.name : '', readOnly: !!(conn && conn.readOnly) || !!target.view || !!target.pipeline,
        roReason: conn && conn.readOnly ? 'This connection is read-only.' : (target.view ? 'A view is read-only.' : (target.pipeline ? 'Aggregation results are read-only.' : '')),
        pipeline: target.pipeline ? shell.format(target.pipeline, { indent: 0 }) : null, query: target.query || null, pageSize: s.pageSize, types: shell.TYPES,
      },
    });
    this.panel.onDidDispose(() => { panels.delete(this.key); if (this.pager) this.pager.close().catch(() => {}); });
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.post({ type: 'error', message: (e && e.message) || String(e) })));
  }

  post(m) { return this.panel.webview.postMessage(m); }

  async session() { return this.deps.sessions.get(this.t.conn); }

  conn() { return this.deps.store.get(this.t.conn); }

  parseQuery(raw) {
    const q = {};
    try { q.filter = shell.parseDoc(raw.filter, 'The filter'); } catch (e) { throw prefix('Filter', e); }
    try { q.projection = shell.parseDoc(raw.projection, 'The projection'); } catch (e) { throw prefix('Projection', e); }
    try { q.sort = shell.parseDoc(raw.sort, 'The sort'); } catch (e) { throw prefix('Sort', e); }
    q.limit = Math.max(0, Math.floor(Number(raw.limit) || 0));
    q.skip = Math.max(0, Math.floor(Number(raw.skip) || 0));
    return q;
  }

  async onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    const { vscode } = this.deps;
    switch (m.type) {
      case 'ready': {
        if (this.t.pipeline) await this.run({ pipeline: this.t.pipeline });
        else await this.run(this.parseQuery(this.t.query || {}));
        this.loadFields().catch(() => {});
        break;
      }
      case 'run': {
        let q;
        try { q = this.t.pipeline ? { pipeline: this.t.pipeline } : this.parseQuery(m.query || {}); } catch (e) { this.post({ type: 'error', message: e.message, where: e.where }); return; }
        await this.run(q);
        break;
      }
      case 'more': await this.more(); break;
      case 'cancel': if (this.pager) { await this.pager.cancel(); this.post({ type: 'cancelled' }); } break;
      case 'fields': await this.loadFields(); break;
      case 'edit': await this.edit(m); break;
      case 'unset': await this.unset(m); break;
      case 'replace': await this.replace(m); break;
      case 'insert': await this.insert(m); break;
      case 'delete': await this.remove(m); break;
      case 'openFull': await this.openFull(m); break;
      case 'copy': await vscode.env.clipboard.writeText(String(m.text || '')); vscode.window.setStatusBarMessage('Copied', 2000); break;
      case 'explain': {
        let q;
        try { q = this.t.pipeline ? { pipeline: this.t.pipeline } : this.parseQuery(m.query || {}); } catch (e) { this.post({ type: 'error', message: e.message }); return; }
        await this.deps.onExplain(this.t, q);
        break;
      }
      case 'export': {
        let q;
        try { q = this.t.pipeline ? { pipeline: this.t.pipeline } : this.parseQuery(m.query || {}); } catch (e) { this.post({ type: 'error', message: e.message }); return; }
        await this.deps.onExport(this.t, q);
        break;
      }
      case 'bulk': await this.bulk(m); break;
      case 'command': if (['zovoMongo.supportDeveloper', 'zovoMongo.moreViewers'].includes(m.command)) vscode.commands.executeCommand(m.command); break;
      default:
    }
  }

  async run(q) {
    if (this.pager) { const old = this.pager; this.pager = null; old.close().catch(() => {}); }
    this.q = q;
    const s = await this.session();
    const pager = s.pager(this.t.database, this.t.collection, q);
    this.pager = pager;
    this.post({ type: 'running' });
    const t0 = Date.now();
    try {
      const r = await pager.next(this.deps.settings().pageSize);
      if (this.pager !== pager) return;
      this.post({ type: 'result', docs: r.docs, done: r.done, ms: Date.now() - t0, cut: r.cut });
      if (!this.ok) { this.ok = true; this.deps.rating.success(); }
    } catch (e) {
      if (this.pager !== pager) return;
      this.pager = null;
      this.post({ type: 'error', message: e.message, cancelled: !!e.cancelled });
      if (e.lost) this.deps.onLost && this.deps.onLost(this.t.conn);
    }
  }

  async more() {
    if (!this.pager) return;
    const pager = this.pager;
    this.post({ type: 'running', more: true });
    const t0 = Date.now();
    try {
      const r = await pager.next(this.deps.settings().pageSize);
      if (this.pager !== pager) return;
      this.post({ type: 'append', docs: r.docs, done: r.done, ms: Date.now() - t0, cut: r.cut });
    } catch (e) {
      this.post({ type: 'error', message: e.message, keep: true, cancelled: !!e.cancelled });
    }
  }

  async loadFields() {
    const s = await this.session();
    const r = await s.samplePaths(this.t.database, this.t.collection, 100);
    this.post({ type: 'fields', paths: r.paths.map((p) => p.path), sample: r.n });
  }

  writable() {
    const c = this.conn();
    if (!c) throw Object.assign(new Error('This connection was deleted.'), { friendly: true });
    if (c.readOnly) { this.deps.vscode.window.showWarningMessage(`${c.name} is read-only. Turn it off in the explorer (Toggle Read-Only) to change data.`); return false; }
    if (this.t.view || this.t.pipeline) { this.deps.vscode.window.showWarningMessage(this.t.view ? 'A view is read-only.' : 'Aggregation results are read-only. Edit the documents in their collection.'); return false; }
    return true;
  }

  async refreshDoc(idWire, index) {
    const s = await this.session();
    const { toWire, GRID_LIMITS } = require('./core/wire');
    const full = await s.fullDoc(this.t.database, this.t.collection, idWire);
    if (!full) { this.post({ type: 'gone', index }); return; }
    // fullDoc has no cut; cut it again for the grid the same way as a page.
    const stats = {};
    const w = cutWire(full, GRID_LIMITS, stats, toWire);
    this.post({ type: 'doc', index, doc: { w, cut: !!stats.cut } });
  }

  async edit(m) {
    if (!this.writable()) { this.post({ type: 'editDone', ok: false }); return; }
    let value;
    try {
      value = m.type2 === 'auto' ? keepType(shell.parse(m.text), m.prev) : shell.fromText(m.text, m.valueType);
    } catch (e) { this.post({ type: 'editDone', ok: false, message: e.message }); return; }
    const s = await this.session();
    try {
      const r = await s.setField(this.t.database, this.t.collection, m.id, m.path, value);
      if (!r.matched) { this.post({ type: 'editDone', ok: false, message: 'No document has this _id any more. It was deleted or its _id changed.' }); return; }
      this.post({ type: 'editDone', ok: true, message: r.modified ? `Saved ${m.path.join('.')}.` : 'The value was already the same.' });
      await this.refreshDoc(m.id, m.index);
    } catch (e) { this.post({ type: 'editDone', ok: false, message: e.message }); }
  }

  async unset(m) {
    if (!this.writable()) return;
    const { vscode } = this.deps;
    const ok = await vscode.window.showWarningMessage(`Remove the field ${m.path.join('.')} from this document?`, { modal: true }, 'Remove field');
    if (ok !== 'Remove field') return;
    const s = await this.session();
    const r = await s.unsetField(this.t.database, this.t.collection, m.id, m.path);
    this.post({ type: 'toast', message: r.modified ? `Removed ${m.path.join('.')}.` : 'Nothing changed.' });
    await this.refreshDoc(m.id, m.index);
  }

  async replace(m) {
    if (!this.writable()) { this.post({ type: 'replaceDone', ok: false }); return; }
    let doc;
    try { doc = shell.parseDoc(m.text, 'The document'); } catch (e) { this.post({ type: 'replaceDone', ok: false, message: e.message }); return; }
    const s = await this.session();
    try {
      const r = await s.replaceDoc(this.t.database, this.t.collection, m.id, doc);
      if (!r.matched) { this.post({ type: 'replaceDone', ok: false, message: 'No document has this _id any more.' }); return; }
      this.post({ type: 'replaceDone', ok: true, message: r.modified ? 'Document saved.' : 'The document was already the same.' });
      await this.refreshDoc(m.id, m.index);
    } catch (e) { this.post({ type: 'replaceDone', ok: false, message: e.message }); }
  }

  async insert(m) {
    if (!this.writable()) { this.post({ type: 'insertDone', ok: false }); return; }
    let v;
    try { v = shell.parse(m.text); } catch (e) { this.post({ type: 'insertDone', ok: false, message: e.message }); return; }
    const docs = Array.isArray(v) ? v : [v];
    if (!docs.length || docs.some((d) => shell.typeOf(d) !== 'Object')) { this.post({ type: 'insertDone', ok: false, message: 'Insert takes a document in braces, or a list of documents in brackets.' }); return; }
    const s = await this.session();
    try {
      const r = await s.insert(this.t.database, this.t.collection, docs);
      this.post({ type: 'insertDone', ok: true, message: `Inserted ${r.inserted} document${r.inserted === 1 ? '' : 's'}.` });
      if (this.q) await this.run(this.q);
    } catch (e) { this.post({ type: 'insertDone', ok: false, message: e.message }); }
  }

  async remove(m) {
    if (!this.writable()) return;
    const { vscode } = this.deps;
    const n = m.ids.length;
    if (!n) return;
    const preview = m.ids.slice(0, 3).map((x) => shell.inline(x, 60)).join(', ') + (n > 3 ? ', …' : '');
    const ok = await vscode.window.showWarningMessage(`Delete ${n} document${n === 1 ? '' : 's'} from ${this.t.collection}?`, { modal: true, detail: `_id: ${preview}\nThis cannot be undone.` }, `Delete ${n}`);
    if (ok !== `Delete ${n}`) return;
    const s = await this.session();
    const r = await s.deleteIds(this.t.database, this.t.collection, m.ids);
    this.post({ type: 'deleted', ids: m.ids, n: r.deleted });
    this.post({ type: 'toast', message: `Deleted ${r.deleted} document${r.deleted === 1 ? '' : 's'}.` });
  }

  /** Update or delete every document that matches the filter, after a count and a confirmation. */
  async bulk(m) {
    if (!this.writable()) return;
    const { vscode } = this.deps;
    let q;
    try { q = this.parseQuery(m.query || {}); } catch (e) { this.post({ type: 'error', message: e.message }); return; }
    const s = await this.session();
    const empty = !Object.keys(q.filter).length;
    const n = await s.countMatching(this.t.database, this.t.collection, q.filter);
    if (m.op === 'delete') {
      const label = empty ? 'Delete every document' : `Delete ${n.toLocaleString('en-US')}`;
      const ok = await vscode.window.showWarningMessage(empty ? `The filter is empty: this is deleteMany({}) and deletes all ${n.toLocaleString('en-US')} documents in ${this.t.collection}.` : `Delete the ${n.toLocaleString('en-US')} documents that match the filter?`, { modal: true, detail: `Filter: ${shell.inline(q.filter, 300)}\nThis cannot be undone. The indexes stay.` }, label);
      if (ok !== label) return;
      const r = await s.deleteMatching(this.t.database, this.t.collection, q.filter);
      this.post({ type: 'toast', message: `Deleted ${r.deleted.toLocaleString('en-US')} documents.` });
      await this.run(q);
      return;
    }
    const text = await vscode.window.showInputBox({ title: `Update ${n.toLocaleString('en-US')} matching documents`, prompt: 'An update document with operators, for example { $set: { status: "done" } } or { $inc: { qty: 1 } }', value: '{ $set: {  } }', ignoreFocusOut: true, validateInput: (t) => { try { const u = shell.parseDoc(t, 'The update'); return Object.keys(u).every((k) => k.startsWith('$')) ? null : 'Use update operators such as $set, $unset, $inc'; } catch (e) { return e.message; } } });
    if (!text) return;
    const update = shell.parseDoc(text, 'The update');
    const label = empty ? 'Update every document' : `Update ${n.toLocaleString('en-US')}`;
    const ok = await vscode.window.showWarningMessage(empty ? `The filter is empty: this update changes all ${n.toLocaleString('en-US')} documents in ${this.t.collection}.` : `Update the ${n.toLocaleString('en-US')} documents that match the filter?`, { modal: true, detail: `Filter: ${shell.inline(q.filter, 200)}\nUpdate: ${shell.inline(update, 300)}` }, label);
    if (ok !== label) return;
    const r = await s.updateMatching(this.t.database, this.t.collection, q.filter, update);
    this.post({ type: 'toast', message: `${r.matched.toLocaleString('en-US')} matched, ${r.modified.toLocaleString('en-US')} changed.` });
    await this.run(q);
  }

  async openFull(m) {
    const { vscode } = this.deps;
    const s = await this.session();
    let full;
    if (this.t.pipeline) full = null; else full = await s.fullDoc(this.t.database, this.t.collection, m.id);
    if (!full) { vscode.window.showWarningMessage(this.t.pipeline ? 'Aggregation results have no stored document to open.' : 'This document no longer exists.'); return; }
    const text = shell.format(full, { indent: 2 });
    const doc = await vscode.workspace.openTextDocument({ language: 'javascript', content: `// ${this.t.database}.${this.t.collection} _id ${shell.inline(full._id, 120)}\n// Read-only copy (${text.length.toLocaleString('en-US')} characters). Edit fields in the grid, or the whole document in the JSON view.\nconst doc = ${text};\n` });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }
}

function cutWire(w, lim, stats, toWireFn) {
  // Re-cut a wire value: strings, binaries and arrays over the limits. (toWireFn is not needed for wire input.)
  void toWireFn;
  if (typeof w === 'string') { if (w.length > lim.str) { stats.cut = true; return { $zovoTrunc: { s: w.slice(0, lim.str), n: w.length } }; } return w; }
  if (w === null || typeof w !== 'object') return w;
  if (Array.isArray(w)) { const out = w.slice(0, lim.arr).map((x) => cutWire(x, lim, stats)); if (w.length > lim.arr) { stats.cut = true; out.push({ $zovoMore: w.length - lim.arr }); } return out; }
  if (w.$binary && Object.keys(w).length === 1) {
    const b64 = String(w.$binary.base64);
    const n = Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
    if (n > lim.bin) { stats.cut = true; return { $zovoBin: { subType: w.$binary.subType, n } }; }
    return w;
  }
  if (shell.isWrapper(w)) return w;
  const out = {};
  for (const k of Object.keys(w)) out[k] = cutWire(w[k], lim, stats);
  return out;
}

function prefix(where, e) {
  const x = new Error(`${where}: ${e.message}`);
  x.friendly = true;
  x.where = where.toLowerCase();
  return x;
}

module.exports = { DocsPanel, cutWire };
