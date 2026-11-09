'use strict';
// The MongoDB explorer: connections > databases > collections and views > indexes.
// Each level loads when it is expanded. Document counts are estimated (collection metadata, no scan).

const { displayHosts } = require('./core/connstr');
const { format } = require('./core/shell');

function fmtCount(n) {
  if (n === null || n === undefined || n < 0) return '';
  if (n < 1000) return `${n} docs`;
  if (n < 1e6) return `~${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}K docs`;
  return `~${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M docs`;
}

function fmtSize(b) {
  if (!b) return '';
  if (b < 1048576) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

/** Run up to `limit` promises at a time. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const work = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(() => null); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work));
  return out;
}

class ExplorerProvider {
  constructor(vscode, store, sessions) {
    this.vscode = vscode;
    this.store = store;
    this.sessions = sessions;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    // Children of each expanded node, kept so that a repaint (the connected icon turning green or grey) does
    // not query the server: an idle connection that closed must stay closed until the user does something.
    this.cache = new Map();
    store.onDidChange(() => this.refresh());
  }

  /** Reload: the next expand or render asks the server again (after a change, or the Refresh command). */
  refresh(node) {
    this.cache.clear();
    this.emitter.fire(node || undefined);
  }

  /** Re-render only (icons, descriptions); expanded levels come from the cache, nothing is sent to a server. */
  repaint() {
    this.emitter.fire(undefined);
  }

  getTreeItem(node) {
    const v = this.vscode;
    const TI = v.TreeItemCollapsibleState;
    const it = new v.TreeItem(node.label, node.leaf ? TI.None : (node.expanded ? TI.Expanded : TI.Collapsed));
    it.contextValue = node.kind + (node.readOnly ? ':ro' : '');
    if (node.description) it.description = node.description;
    if (node.tooltip) it.tooltip = node.tooltip;
    it.accessibilityInformation = { label: node.description ? `${node.label}, ${node.description}` : String(node.label) };
    if (node.icon) it.iconPath = new v.ThemeIcon(node.icon, node.iconColor ? new v.ThemeColor(node.iconColor) : undefined);
    if (node.id) it.id = node.id;
    if (node.kind === 'collection' || node.kind === 'view') it.command = { command: 'zovoMongo.openCollection', title: 'Open', arguments: [node] };
    if (node.kind === 'error') it.command = { command: 'zovoMongo.showError', title: 'Show error', arguments: [node] };
    return it;
  }

  async getChildren(node) {
    if (node && this.cache.has(node.id)) return this.cache.get(node.id);
    try {
      const out = await this.children(node);
      if (node && node.conn && !out.some((x) => x.kind === 'error')) this.cache.set(node.id, out);
      return out;
    } catch (e) {
      if (e && e.cancelled) return [];
      const msg = (e && e.message) || String(e);
      return [{ kind: 'error', label: 'Could not load: ' + msg.slice(0, 140), tooltip: msg, message: msg, icon: 'error', iconColor: 'errorForeground', leaf: true, id: `${node ? node.id : 'root'}/error/${Date.now()}` }];
    }
  }

  async children(node) {
    if (!node) {
      const open = this.sessions.openIds();
      return this.store.list().map((c) => ({
        kind: 'connection', id: `c/${c.id}`, conn: c.id, label: c.name,
        description: (c.readOnly ? 'read-only · ' : '') + displayHosts(c.uri),
        tooltip: `${c.name}\n${c.uri}${c.user ? `\nUser ${c.user}` : ''}${c.readOnly ? '\nRead-only: every change is blocked' : ''}`,
        icon: 'database', iconColor: open.has(c.id) ? 'charts.green' : undefined, readOnly: c.readOnly,
      }));
    }
    const c = this.store.get(node.conn);
    if (!c) return [];
    const s = await this.sessions.get(c.id);
    const base = { conn: c.id, readOnly: c.readOnly };
    if (node.kind === 'connection') {
      const dbs = await s.databases();
      const user = dbs.filter((d) => !['admin', 'local', 'config'].includes(d.name));
      const sys = dbs.filter((d) => ['admin', 'local', 'config'].includes(d.name));
      return user.concat(sys).map((d) => ({
        ...base, kind: 'database', id: `${node.id}/d/${d.name}`, database: d.name, label: d.name,
        description: d.empty ? 'empty' : fmtSize(d.size), icon: 'database', expanded: false,
      }));
    }
    if (node.kind === 'database') {
      const list = await s.collections(node.database);
      if (!list.length) return [{ kind: 'empty', label: 'No collections', leaf: true, id: `${node.id}/none`, conn: c.id, database: node.database }];
      const counts = list.length <= 200 ? await pool(list, 6, (x) => (x.type === 'collection' && !x.timeseries ? s.estimatedCount(node.database, x.name) : Promise.resolve(null))) : [];
      return list.map((x, i) => ({
        ...base, kind: x.type === 'view' ? 'view' : 'collection', id: `${node.id}/c/${x.name}`, database: node.database, collection: x.name, label: x.name,
        description: x.type === 'view' ? `view on ${x.viewOn || '?'}` : (x.timeseries ? 'time series' : fmtCount(counts[i])),
        tooltip: `${node.database}.${x.name}${x.type === 'view' ? `\nView on ${x.viewOn}` : ''}${counts[i] !== null && counts[i] !== undefined ? `\nAbout ${Number(counts[i]).toLocaleString('en-US')} documents (estimated from metadata)` : ''}`,
        icon: x.type === 'view' ? 'eye' : 'symbol-class', view: x.type === 'view',
      }));
    }
    if (node.kind === 'collection') {
      return [{ ...base, kind: 'indexes', id: `${node.id}/i`, database: node.database, collection: node.collection, label: 'Indexes', icon: 'list-tree' }];
    }
    if (node.kind === 'indexes') {
      const idx = await s.indexes(node.database, node.collection);
      return idx.map((i) => ({
        ...base, kind: i.name === '_id_' ? 'index-id' : 'index', id: `${node.id}/${i.name}`, database: node.database, collection: node.collection, name: i.name, label: i.name, leaf: true,
        description: [format(i.key, { indent: 0 }), i.unique ? 'unique' : '', i.ttl !== null ? `TTL ${i.ttl}s` : '', i.sparse ? 'sparse' : '', i.partial ? 'partial' : '', i.hidden ? 'hidden' : ''].filter(Boolean).join(' · '),
        tooltip: `${i.name}\nKeys: ${format(i.key, { indent: 0 })}${i.unique ? '\nUnique' : ''}${i.ttl !== null ? `\nDocuments expire ${i.ttl} s after the date in the field` : ''}${i.partial ? `\nPartial: ${format(i.partial, { indent: 0 })}` : ''}`,
        icon: i.name === '_id_' ? 'key' : 'symbol-key',
      }));
    }
    return [];
  }
}

module.exports = { ExplorerProvider, fmtCount, fmtSize };
