'use strict';
// Saved connections (VS Code global state, no secrets) and their passwords (VS Code SecretStorage).
// A connection opens only when the user expands it or runs something, and closes after the idle time.

const fs = require('fs');
const crypto = require('crypto');
const { splitUri, displayHosts } = require('./core/connstr');

const KEY = 'zovoMongo.connections';
const SECRET = (id) => `zovoMongo.password.${id}`;
const FIELDS = ['id', 'name', 'uri', 'user', 'authSource', 'tls', 'caFile', 'tlsInsecure', 'replicaSet', 'directConnection', 'readPreference', 'readOnly', 'savePassword'];

// The driver bundle (dist/mongo.js) loads on the first connect, not at activation.
let driver = null;
function loadDriver() {
  // eslint-disable-next-line global-require
  if (!driver) driver = require('./core/mongo');
  return driver;
}

class ConnectionStore {
  constructor(vscode, context) {
    this.vscode = vscode;
    this.context = context;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  list() {
    const raw = this.context.globalState.get(KEY, []);
    return Array.isArray(raw) ? raw.filter((c) => c && c.id && c.uri) : [];
  }

  get(id) {
    return this.list().find((c) => c.id === id) || null;
  }

  /**
   * Save a connection. A password inside the connection string moves to SecretStorage; the saved string
   * never holds it. password: string to store, '' to clear, undefined to keep the stored one.
   */
  async save(conn, password) {
    const clean = {};
    for (const f of FIELDS) if (conn[f] !== undefined) clean[f] = conn[f];
    const split = splitUri(clean.uri || '');
    clean.uri = split.uri;
    if (split.user && !clean.user) clean.user = split.user;
    if (split.password && (password === undefined || password === '')) password = split.password;
    if (!clean.id) clean.id = crypto.randomUUID();
    if (!clean.name) clean.name = displayHosts(clean.uri);
    clean.readOnly = !!clean.readOnly;
    clean.tlsInsecure = !!clean.tlsInsecure;
    const list = this.list();
    const i = list.findIndex((c) => c.id === clean.id);
    if (i >= 0) list[i] = clean; else list.push(clean);
    await this.context.globalState.update(KEY, list);
    if (password !== undefined) {
      if (password && clean.savePassword !== false) await this.context.secrets.store(SECRET(clean.id), password);
      else await this.context.secrets.delete(SECRET(clean.id));
    }
    this.emitter.fire(clean.id);
    return clean;
  }

  async remove(id) {
    await this.context.globalState.update(KEY, this.list().filter((c) => c.id !== id));
    await this.context.secrets.delete(SECRET(id));
    this.emitter.fire(id);
  }

  async password(id) {
    return (await this.context.secrets.get(SECRET(id))) || '';
  }
}

/** Build the session config from a saved connection and the settings. */
function sessionConfig(c, s, caText) {
  return {
    name: c.name, uri: c.uri, user: c.user || '', authSource: c.authSource || '', tls: c.tls || '', caText, tlsInsecure: !!c.tlsInsecure,
    replicaSet: c.replicaSet || '', directConnection: c.directConnection || '', readPreference: c.readPreference || '',
    timeoutMs: s.connectTimeoutSeconds * 1000, idleMs: s.idleCloseMinutes * 60 * 1000, queryTimeoutMs: s.queryTimeoutSeconds * 1000,
  };
}

function readCa(c) {
  if (!c.caFile) return undefined;
  try { return fs.readFileSync(c.caFile, 'utf8'); } catch (e) { throw Object.assign(new Error(`The CA file ${c.caFile} could not be read: ${e.message}`), { friendly: true }); }
}

class SessionManager {
  constructor(vscode, store, settings) {
    this.vscode = vscode;
    this.store = store;
    this.settings = settings;
    this.sessions = new Map(); // connId -> MongoSession
    this.askedPasswords = new Map(); // passwords typed for this window only (savePassword false)
    this.onDrop = null; // (connId, reason, err)
    this.onState = null; // (connId, open)
  }

  async get(connId) {
    if (this.sessions.has(connId)) return this.sessions.get(connId);
    const c = this.store.get(connId);
    if (!c) throw Object.assign(new Error('This connection was deleted.'), { friendly: true });
    let password = await this.store.password(connId);
    if (!password && c.user && c.savePassword === false) {
      password = this.askedPasswords.get(connId);
      if (password === undefined) {
        password = await this.vscode.window.showInputBox({ title: `Password for ${c.name}`, prompt: `${c.user}@${displayHosts(c.uri)}`, password: true, ignoreFocusOut: true });
        if (password === undefined) throw Object.assign(new Error('No password was typed.'), { friendly: true, cancelled: true });
        this.askedPasswords.set(connId, password);
      }
    }
    const { MongoSession } = loadDriver();
    const session = new MongoSession(sessionConfig(c, this.settings(), readCa(c)), password);
    session.connId = connId;
    session.readOnly = !!c.readOnly;
    session.onDrop = (reason, err) => { if (this.onDrop) this.onDrop(connId, reason, err); };
    session.onState = (open) => { if (this.onState) this.onState(connId, open); };
    this.sessions.set(connId, session);
    return session;
  }

  /** Close one connection's session (or all), and forget it so the next action builds it again. */
  async close(connId) {
    const all = [...this.sessions.entries()].filter(([k]) => !connId || k === connId);
    for (const [k] of all) this.sessions.delete(k);
    if (connId) this.askedPasswords.delete(connId); else this.askedPasswords.clear();
    await Promise.all(all.map(([, s]) => s.close().catch(() => {})));
  }

  openIds() {
    return new Set([...this.sessions.entries()].filter(([, s]) => s.isOpen()).map(([k]) => k));
  }
}

module.exports = { ConnectionStore, SessionManager, sessionConfig, readCa, loadDriver };
