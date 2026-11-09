'use strict';
// Zovo MongoDB Client: browse, query, edit, aggregate, index, import and export MongoDB in VS Code.
// Network: only to the servers the user adds. No telemetry, no update check, no connection on startup,
// no keep-alive: a connection closes after zovoMongo.idleCloseMinutes without an action. (The optional GitHub
// Sponsors unlock asks GitHub one question, only when the user clicks it.)

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { ConnectionStore, SessionManager, sessionConfig, readCa, loadDriver } = require('./connections');
const { ExplorerProvider } = require('./tree');
const { DocsPanel } = require('./docs');
const { buildHtml } = require('./html');
const { validate, displayHosts, splitUri } = require('./core/connstr');
const shell = require('./core/shell');
const { explainHtml, summarizeExplain } = require('./explain');
const { createRatingPrompt } = require('./rate');
const { registerSupport } = require('./support');
const pro = require('./pro');

const AGG_KEY = 'zovoMongo.pipelines';

let rating = { success() {}, failure() {} };
let sessionsRef = null;

function settings() {
  const c = vscode.workspace.getConfiguration('zovoMongo');
  const num = (k, d, lo, hi) => Math.min(hi, Math.max(lo, Number(c.get(k, d)) || d));
  return {
    pageSize: Math.floor(num('pageSize', 50, 1, 1000)),
    connectTimeoutSeconds: num('connectTimeoutSeconds', 10, 1, 120),
    idleCloseMinutes: num('idleCloseMinutes', 10, 1, 240),
    queryTimeoutSeconds: num('queryTimeoutSeconds', 60, 0, 86400),
    showSupportLinks: c.get('showSupportLinks', true),
  };
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.zovo-mongodb-client', section: 'zovoMongo', name: 'MongoDB Client' });
  registerSupport({ vscode, context, prefix: 'zovoMongo', selfId: 'zovo.zovo-mongodb-client' });
  const proApi = pro.createPro(vscode, context);
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => proApi.license.handleUri(uri) }));

  const store = new ConnectionStore(vscode, context);
  const sessions = new SessionManager(vscode, store, settings);
  sessionsRef = sessions;
  const tree = new ExplorerProvider(vscode, store, sessions);
  const treeView = vscode.window.createTreeView('zovoMongo.connections', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(treeView);

  sessions.onDrop = (connId, reason, err) => {
    const c = store.get(connId);
    if (reason === 'lost' && err) vscode.window.showWarningMessage(err.message);
    if (reason === 'idle' && c) vscode.window.setStatusBarMessage(`MongoDB: closed the idle connection to ${c.name}. It opens again on your next action.`, 6000);
    tree.repaint();
  };
  sessions.onState = () => tree.repaint();

  const guard = (fn) => async (...a) => {
    try { return await fn(...a); } catch (e) {
      if (!e || !e.cancelled) vscode.window.showErrorMessage((e && e.message) || String(e));
      return undefined;
    }
  };
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(`zovoMongo.${id}`, guard(fn)));

  async function pickConnection(title) {
    const list = store.list();
    if (!list.length) {
      const pick = await vscode.window.showInformationMessage('Add a MongoDB connection first.', 'Add Connection');
      if (pick) await vscode.commands.executeCommand('zovoMongo.addConnection');
      return null;
    }
    if (list.length === 1) return list[0];
    const item = await vscode.window.showQuickPick(list.map((c) => ({ label: `$(database) ${c.name}`, description: displayHosts(c.uri) + (c.readOnly ? ' · read-only' : ''), c })), { title: title || 'Which connection?' });
    return item ? item.c : null;
  }

  /** A collection target { conn, database, collection, view } from a tree node, or picked step by step. */
  async function collectionTarget(node, title) {
    if (node && node.collection) return { conn: node.conn, database: node.database, collection: node.collection, view: !!node.view };
    const c = node && node.conn ? store.get(node.conn) : await pickConnection(title);
    if (!c) return null;
    const s = await sessions.get(c.id);
    let database = node && node.database;
    if (!database) {
      const dbs = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Listing databases' }, () => s.databases());
      const p = await vscode.window.showQuickPick(dbs.map((d) => d.name), { title: `${title || 'Collection'}: database on ${c.name}` });
      if (!p) return null;
      database = p;
    }
    const cols = await s.collections(database);
    const p = await vscode.window.showQuickPick(cols.map((x) => ({ label: x.name, description: x.type === 'view' ? 'view' : '', x })), { title: `${title || 'Collection'}: collection in ${database}` });
    if (!p) return null;
    return { conn: c.id, database, collection: p.label, view: p.x.type === 'view' };
  }

  function writable(connId) {
    const c = store.get(connId);
    if (!c) throw Object.assign(new Error('This connection was deleted.'), { friendly: true });
    if (c.readOnly) { vscode.window.showWarningMessage(`${c.name} is read-only. Use Toggle Read-Only in the explorer to change data.`); return false; }
    return true;
  }

  // ---------- connection form ----------
  async function openForm(existing) {
    const panel = vscode.window.createWebviewPanel('zovoMongo.form', existing ? `Edit ${existing.name}` : 'New MongoDB Connection', vscode.ViewColumn.Active, {
      enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'collection.svg');
    const hasPassword = existing ? !!(await store.password(existing.id)) : false;
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.css')).toString(),
      title: 'Connection', page: 'form', footer: false, data: { conn: existing || null, hasPassword },
    });
    const test = async (conn, password) => {
      let pw = password;
      if (!pw && existing) pw = await store.password(existing.id);
      const split = splitUri(conn.uri);
      if (split.password && !pw) pw = split.password;
      const c = { ...conn, uri: split.uri, user: conn.user || split.user };
      const { MongoSession } = loadDriver();
      const s = new MongoSession({ ...sessionConfig(c, settings(), readCa(c)), idleMs: 0 }, pw);
      try {
        const info = await s.open();
        let dbs = null;
        try { dbs = (await s.databases()).length; } catch { dbs = null; }
        return `Connected. MongoDB ${info.version || '(version hidden)'}${info.setName ? `, replica set ${info.setName}` : ''}${dbs !== null ? `, ${dbs} database${dbs === 1 ? '' : 's'} visible` : ''}.`;
      } finally { await s.close(); }
    };
    panel.webview.onDidReceiveMessage(async (m) => {
      if (!m) return;
      if (m.type === 'cancel') { panel.dispose(); return; }
      if (m.type === 'browse') {
        const r = await vscode.window.showOpenDialog({ canSelectMany: false, title: 'CA certificate (PEM)', filters: { Certificates: ['pem', 'crt', 'cer'], All: ['*'] } });
        if (r && r[0]) panel.webview.postMessage({ type: 'browsed', what: 'ca', path: r[0].fsPath });
        return;
      }
      const conn = m.conn || {};
      const errs = validate(conn);
      if (errs.length) { panel.webview.postMessage({ type: m.type === 'test' ? 'tested' : 'saved', ok: false, message: errs.join('\n') }); return; }
      if (m.type === 'test') {
        try { panel.webview.postMessage({ type: 'tested', ok: true, message: await test(conn, m.password) }); } catch (e) { panel.webview.postMessage({ type: 'tested', ok: false, message: e.message || String(e) }); }
        return;
      }
      if (m.type === 'save') {
        const saved = await store.save({ ...conn, id: existing ? existing.id : undefined }, m.password);
        await sessions.close(saved.id);
        tree.refresh();
        panel.dispose();
        vscode.window.showInformationMessage(`Saved ${saved.name}.${saved.savePassword === false && saved.user ? ' The password will be asked once per window.' : ''}`);
        vscode.commands.executeCommand('zovoMongo.connections.focus');
      }
    });
  }

  // ---------- panels ----------
  const deps = {
    vscode, context, sessions, store, settings, rating: { success: () => rating.success(), failure: () => rating.failure() },
    onExplain: (t, q) => showExplain(t, q),
    onExport: (t, q) => exportQuery(t, q),
    onLost: () => tree.repaint(),
  };

  async function openCollection(node, query) {
    const t = await collectionTarget(node, 'Open');
    if (!t) return null;
    const c = store.get(t.conn);
    try { await (await sessions.get(t.conn)).open(); } catch (e) { if (!e.cancelled) { rating.failure(); vscode.window.showErrorMessage(`${c ? c.name : 'Connection'}: ${e.message}`); } return null; }
    return DocsPanel.open(deps, { ...t, query });
  }

  async function showExplain(t, q) {
    const s = await sessions.get(t.conn);
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Explain on ${t.collection}`, cancellable: false }, () => s.explain(t.database, t.collection, q));
    const panel = vscode.window.createWebviewPanel('zovoMongo.explain', `Explain: ${t.collection}`, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: false, localResourceRoots: [] });
    panel.webview.html = explainHtml({ explain: r, query: q, ns: `${t.database}.${t.collection}`, cspSource: panel.webview.cspSource });
    return { panel, summary: summarizeExplain(r) };
  }

  // ---------- export and import ----------
  async function exportQuery(t, q) {
    const fmt = await vscode.window.showQuickPick([
      { label: 'JSON', description: 'one array, relaxed Extended JSON (Int64 beyond 2^53 and Decimal128 keep their type)', id: 'json' },
      { label: 'JSONL', description: 'one document per line (mongoimport reads it)', id: 'jsonl' },
      { label: 'CSV', description: 'columns from the fields of the first 1,000 documents; nested fields as a.b', id: 'csv' },
    ], { title: `Export ${t.collection}${q && (q.pipeline || Object.keys(q.filter || {}).length) ? ' (the current query)' : ''}` });
    if (!fmt) return null;
    const folder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri : undefined;
    const target = await vscode.window.showSaveDialog({ title: 'Export to', defaultUri: folder ? vscode.Uri.joinPath(folder, `${t.collection}.${fmt.id}`) : undefined, filters: { [fmt.label]: [fmt.id] } });
    if (!target) return null;
    const s = await sessions.get(t.conn);
    let stop = false;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting ${t.collection}`, cancellable: true }, (progress, token) => {
      token.onCancellationRequested(() => { stop = true; });
      return s.exportTo(t.database, t.collection, q || { filter: {} }, fmt.id, target.fsPath, { shouldStop: () => stop, onProgress: (n) => progress.report({ message: `${n.toLocaleString('en-US')} documents` }) });
    });
    const msg = `${r.stopped ? 'Stopped after' : 'Exported'} ${r.count.toLocaleString('en-US')} documents to ${path.basename(target.fsPath)}${r.columns !== undefined ? ` (${r.columns} columns)` : ''}.`;
    vscode.window.showInformationMessage(msg, 'Show file').then((b) => { if (b) vscode.commands.executeCommand('revealFileInOS', target); });
    return r;
  }

  async function importInto(node, fileArg) {
    const t = await collectionTarget(node, 'Import into');
    if (!t) return null;
    if (!writable(t.conn)) return null;
    if (t.view) { vscode.window.showWarningMessage('A view is read-only; import into a collection.'); return null; }
    let file = fileArg;
    if (!file) {
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, title: `Import into ${t.collection}`, filters: { 'JSON, JSONL, CSV': ['json', 'jsonl', 'ndjson', 'csv', 'tsv'], All: ['*'] } });
      if (!files || !files[0]) return null;
      file = files[0].fsPath;
    }
    const ext = path.extname(file).toLowerCase();
    let fmt = ext === '.csv' || ext === '.tsv' ? 'csv' : ext === '.jsonl' || ext === '.ndjson' ? 'jsonl' : 'json';
    if (fmt === 'json') {
      // A .json file with one document per line and no surrounding [ ] is JSONL.
      const head = Buffer.alloc(4096);
      const fd = fs.openSync(file, 'r');
      const n = fs.readSync(fd, head, 0, 4096, 0);
      fs.closeSync(fd);
      const text = head.subarray(0, n).toString('utf8').replace(/^﻿/, '').trimStart();
      if (text.startsWith('{') && /}\s*\r?\n\s*{/.test(text)) fmt = 'jsonl';
    }
    const size = fs.statSync(file).size;
    const s = await sessions.get(t.conn);
    let stop = false;
    let last = 0;
    try {
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Importing ${path.basename(file)} into ${t.collection}`, cancellable: true }, (progress, token) => {
        token.onCancellationRequested(() => { stop = true; });
        return s.importFrom(t.database, t.collection, file, fmt, {
          shouldStop: () => stop,
          onProgress: (docs, bytes) => { const pct = size ? Math.min(100, (bytes / size) * 100) : 0; progress.report({ increment: pct - last, message: `${docs.toLocaleString('en-US')} documents · ${Math.round(pct)}%` }); last = pct; },
        });
      });
      vscode.window.showInformationMessage(`${stop ? 'Stopped. ' : ''}Imported ${r.inserted.toLocaleString('en-US')} documents into ${t.collection}.`);
      tree.refresh();
      return r;
    } catch (e) {
      vscode.window.showErrorMessage(`Import stopped: ${e.message}`);
      tree.refresh();
      return { error: e.message };
    }
  }

  // ---------- aggregation ----------
  async function openAggregation(node) {
    const t = await collectionTarget(node, 'Aggregate');
    if (!t) return null;
    const key = `${t.conn}/${t.database}/${t.collection}`;
    const savedP = (context.workspaceState.get(AGG_KEY, {}) || {})[key];
    const panel = vscode.window.createWebviewPanel('zovoMongo.agg', `Pipeline: ${t.collection}`, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, enableCommandUris: require('./support').commandUris('zovoMongo'), localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'collection.svg');
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.css')).toString(),
      title: 'Aggregation', page: 'agg', showSupportLinks: settings().showSupportLinks,
      data: { ns: `${t.database}.${t.collection}`, pipeline: savedP || '[\n  { $match: {} },\n  { $group: { _id: null, count: { $sum: 1 } } }\n]', readOnly: !!(store.get(t.conn) || {}).readOnly },
    });
    let running = null;
    const post = (m) => panel.webview.postMessage(m);
    panel.webview.onDidReceiveMessage(async (m) => {
      if (!m) return;
      if (m.type === 'cancel') {
        if (running) { running.cancelled = true; const s = await sessions.get(t.conn); for (const c of running.comments) await s.killByComment(c); }
        post({ type: 'cancelled' });
        return;
      }
      if (m.type === 'command' && ['zovoMongo.supportDeveloper', 'zovoMongo.moreViewers'].includes(m.command)) { vscode.commands.executeCommand(m.command); return; }
      let pipeline;
      try { pipeline = shell.parsePipeline(m.text); } catch (e) { post({ type: 'error', message: e.message }); return; }
      const all = context.workspaceState.get(AGG_KEY, {}) || {};
      all[key] = m.text;
      context.workspaceState.update(AGG_KEY, all);
      const s = await sessions.get(t.conn);
      try {
        if (m.type === 'preview') {
          running = { comments: [], cancelled: false };
          post({ type: 'running' });
          const stages = await s.stagePreview(t.database, t.collection, pipeline, 20, (i, comment) => { running.comments.push(comment); post({ type: 'stage', index: i }); });
          if (running.cancelled) return;
          running = null;
          post({ type: 'preview', stages });
          if (stages.length && !stages.some((x) => x.error)) rating.success();
        } else if (m.type === 'run') {
          const { writeStage } = loadDriver();
          const w = writeStage(pipeline);
          if (w) {
            if (!writable(t.conn)) { post({ type: 'error', message: 'This connection is read-only, and the pipeline writes with ' + w.stage + '.' }); return; }
            const ok = await vscode.window.showWarningMessage(`This pipeline writes its result to ${w.target} with ${w.stage}${w.stage === '$out' ? ', which replaces that collection' : ''}. Run it?`, { modal: true }, 'Run and write');
            if (ok !== 'Run and write') { post({ type: 'idle' }); return; }
          }
          post({ type: 'idle' });
          DocsPanel.open(deps, { ...t, pipeline, column: vscode.ViewColumn.Beside });
        } else if (m.type === 'explain') {
          post({ type: 'idle' });
          await showExplain(t, { pipeline });
        } else if (m.type === 'export') {
          post({ type: 'idle' });
          await exportQuery(t, { pipeline });
        }
      } catch (e) {
        running = null;
        post({ type: 'error', message: e.message || String(e) });
      }
    });
    return panel;
  }

  // ---------- indexes ----------
  async function createIndex(node) {
    const t = await collectionTarget(node, 'Create index');
    if (!t) return null;
    if (!writable(t.conn)) return null;
    const keysText = await vscode.window.showInputBox({
      title: `Create index on ${t.collection} (1 of 3): keys`, prompt: 'Fields and directions: { email: 1 } or { lastName: 1, age: -1 }. Also "text", "2dsphere", "hashed".', value: '{ field: 1 }', ignoreFocusOut: true,
      validateInput: (v) => { try { const k = shell.parseDoc(v, 'The keys'); return Object.keys(k).length ? null : 'Name at least one field'; } catch (e) { return e.message; } },
    });
    if (!keysText) return null;
    const keys = shell.parseDoc(keysText, 'The keys');
    const nKeys = Object.keys(keys).length;
    const picks = await vscode.window.showQuickPick([
      { label: 'Unique', description: 'no two documents may have the same key', id: 'unique' },
      { label: 'TTL', description: 'delete documents a number of seconds after the date in the field (one date field only)', id: 'ttl' },
      { label: 'Sparse', description: 'skip documents without the field', id: 'sparse' },
    ], { title: `Create index on ${t.collection} (2 of 3): options (none is fine)`, canPickMany: true, ignoreFocusOut: true });
    if (!picks) return null;
    const options = {};
    if (picks.some((p) => p.id === 'unique')) options.unique = true;
    if (picks.some((p) => p.id === 'sparse')) options.sparse = true;
    if (picks.some((p) => p.id === 'ttl')) {
      if (nKeys !== 1) { vscode.window.showWarningMessage('A TTL index has exactly one field (a date field).'); return null; }
      const sec = await vscode.window.showInputBox({ title: 'TTL: seconds after the date', value: '86400', ignoreFocusOut: true, validateInput: (v) => (/^\d+$/.test(v.trim()) && Number(v) <= 2147483647 ? null : 'A whole number of seconds, 0 or more') });
      if (sec === undefined) return null;
      options.expireAfterSeconds = Number(sec);
    }
    const auto = Object.keys(keys).map((k) => `${k}_${shell.plain(keys[k])}`).join('_');
    const name = await vscode.window.showInputBox({ title: `Create index on ${t.collection} (3 of 3): name`, value: auto, ignoreFocusOut: true });
    if (name === undefined) return null;
    if (name.trim()) options.name = name.trim();
    const s = await sessions.get(t.conn);
    const created = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Building index on ${t.collection}` }, () => s.createIndex(t.database, t.collection, keys, options));
    vscode.window.showInformationMessage(`Created index ${created}.`);
    tree.refresh();
    return created;
  }

  async function dropIndex(node) {
    if (!node || !node.name) return null;
    if (!writable(node.conn)) return null;
    if (node.name === '_id_') { vscode.window.showWarningMessage('The _id index cannot be dropped.'); return null; }
    const ok = await vscode.window.showWarningMessage(`Drop the index ${node.name} on ${node.collection}?`, { modal: true, detail: 'Queries that use it get slower. A unique index stops guarding against duplicates. You can create it again later.' }, 'Drop index');
    if (ok !== 'Drop index') return null;
    const s = await sessions.get(node.conn);
    await s.dropIndex(node.database, node.collection, node.name);
    vscode.window.showInformationMessage(`Dropped index ${node.name}.`);
    tree.refresh();
    return true;
  }

  // ---------- commands ----------
  reg('addConnection', () => openForm(null));
  reg('editConnection', async (node) => { const c = node ? store.get(node.conn) : await pickConnection('Edit which connection?'); if (c) await openForm(c); });
  reg('deleteConnection', async (node) => {
    const c = node ? store.get(node.conn) : await pickConnection('Delete which connection?');
    if (!c) return;
    const ok = await vscode.window.showWarningMessage(`Delete the connection "${c.name}"? Its saved password is removed too. The server and its data are not touched.`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    await sessions.close(c.id);
    await store.remove(c.id);
  });
  reg('disconnect', async (node) => {
    const c = node ? store.get(node.conn) : await pickConnection('Disconnect which connection?');
    if (!c) return;
    await sessions.close(c.id);
    tree.repaint();
    vscode.window.setStatusBarMessage(`Disconnected ${c.name}.`, 3000);
  });
  reg('refresh', async (node) => { tree.refresh(node && node.kind !== 'connection' ? undefined : undefined); });
  reg('toggleReadOnly', async (node) => {
    const c = node ? store.get(node.conn) : await pickConnection('Read-only on which connection?');
    if (!c) return;
    await store.save({ ...c, readOnly: !c.readOnly });
    await sessions.close(c.id);
    vscode.window.showInformationMessage(`${c.name} is now ${!c.readOnly ? 'read-only. Every change is blocked' : 'writable'}.`);
  });
  reg('openCollection', (node) => openCollection(node));
  reg('openAggregation', (node) => openAggregation(node));
  reg('exportCollection', async (node) => { const t = await collectionTarget(node, 'Export'); if (t) return exportQuery(t, { filter: {} }); return null; });
  reg('importDocuments', (node, file) => importInto(node, file));
  reg('createIndex', (node) => createIndex(node));
  reg('dropIndex', (node) => dropIndex(node));
  reg('insertDocument', async (node) => { const p = await openCollection(node); if (p) setTimeout(() => p.post({ type: 'toast', message: 'Click Insert in the toolbar to add a document.' }), 800); });
  reg('createCollection', async (node) => {
    const c = node ? store.get(node.conn) : await pickConnection('Create a collection on which connection?');
    if (!c || !writable(c.id)) return;
    const database = node && node.database ? node.database : await vscode.window.showInputBox({ title: 'Database name', prompt: 'An existing or a new database', ignoreFocusOut: true });
    if (!database) return;
    const name = await vscode.window.showInputBox({ title: `New collection in ${database}`, ignoreFocusOut: true, validateInput: (v) => (!v.trim() ? 'A name' : /[$\0]/.test(v) || v.startsWith('system.') ? 'No $, no NUL, not system.*' : null) });
    if (!name) return;
    await (await sessions.get(c.id)).createCollection(database, name.trim());
    tree.refresh();
  });
  reg('dropCollection', async (node) => {
    const t = await collectionTarget(node, 'Drop');
    if (!t || !writable(t.conn)) return;
    const s = await sessions.get(t.conn);
    let n = null;
    try { n = t.view ? null : await s.estimatedCount(t.database, t.collection); } catch { n = null; }
    const ok = await vscode.window.showWarningMessage(`Drop the ${t.view ? 'view' : 'collection'} ${t.database}.${t.collection}?`, { modal: true, detail: t.view ? 'The view definition is removed. Its source collection stays.' : `This deletes ${n !== null ? `about ${n.toLocaleString('en-US')} documents` : 'every document'} and every index of the collection. It cannot be undone.` }, `Drop ${t.collection}`);
    if (ok !== `Drop ${t.collection}`) return;
    await s.dropCollection(t.database, t.collection);
    vscode.window.showInformationMessage(`Dropped ${t.database}.${t.collection}.`);
    tree.refresh();
  });
  reg('dropDatabase', async (node) => {
    if (!node || !node.database) return;
    if (!writable(node.conn)) return;
    const typed = await vscode.window.showInputBox({ title: `Drop the database ${node.database}`, prompt: `Every collection, document and index in ${node.database} is deleted. Type the database name to confirm.`, ignoreFocusOut: true });
    if (typed === undefined) return;
    if (typed !== node.database) { vscode.window.showWarningMessage('The name did not match. Nothing was dropped.'); return; }
    await (await sessions.get(node.conn)).dropDatabase(node.database);
    vscode.window.showInformationMessage(`Dropped the database ${node.database}.`);
    tree.refresh();
  });
  reg('copyName', async (node) => {
    const text = node.collection ? (node.kind === 'index' || node.kind === 'index-id' ? node.name : `${node.database}.${node.collection}`) : (node.database || node.label);
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`Copied ${text}`, 2500);
  });
  reg('showError', (node) => vscode.window.showErrorMessage(node.message));
  reg('openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', 'zovo.zovo-mongodb-client#zovoMongo.start', false));

  // ---------- Zovo Pro ----------
  reg('schemaAnalysis', async (node) => {
    const t = await collectionTarget(node, 'Schema analysis');
    if (!t) return null;
    const gate = await proApi.allow('Schema analysis', pro.SCHEMA_DETAIL);
    if (!gate) return null;
    const s = await sessions.get(t.conn);
    const n = 1000;
    const docs = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Sampling ${n.toLocaleString('en-US')} documents of ${t.collection}` }, () => s.sampleDocs(t.database, t.collection, n));
    const shown = await pro.showSchema(vscode, context, t, docs);
    await gate.done(); // the try counts only now, with the schema on screen
    return shown;
  });
  reg('openJsonSchema', () => pro.openJsonSchema(vscode));
  reg('compareCollections', async (node) => {
    const a = await collectionTarget(node, 'Compare: first collection');
    if (!a) return null;
    const b = await collectionTarget(null, `Compare ${a.collection} with`);
    if (!b) return null;
    const gate = await proApi.allow('Collection compare', pro.COMPARE_DETAIL);
    if (!gate) return null;
    const [sa, sb] = [await sessions.get(a.conn), await sessions.get(b.conn)];
    const r = await pro.compareCollections(vscode, { a, b, sa, sb, labelA: `${store.get(a.conn).name} · ${a.database}.${a.collection}`, labelB: `${store.get(b.conn).name} · ${b.database}.${b.collection}` });
    if (r && r.res && !r.res.stopped) await gate.done(); // a finished compare report counts; Cancel or an error costs nothing
    return r;
  });

  // Close every connection when the window closes.
  context.subscriptions.push({ dispose: () => { sessions.close().catch(() => {}); } });
}

function deactivate() {
  if (sessionsRef) return sessionsRef.close().catch(() => {});
  return undefined;
}

module.exports = { activate, deactivate, settings };
