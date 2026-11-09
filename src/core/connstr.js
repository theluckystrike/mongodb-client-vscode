'use strict';
// Connection strings: check them, take the password out (it goes to SecretStorage), and show them without secrets.
// Pure; used by the host and by the connection form webview.

const RE = /^(mongodb(?:\+srv)?):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i;

function dec(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** { uri (no password, user kept), user, password, hosts, srv, db, params } or { error } */
function parseUri(text) {
  const t = String(text || '').trim();
  const m = RE.exec(t);
  if (!m) return { error: 'A connection string starts with mongodb:// or mongodb+srv://, for example mongodb://localhost:27017' };
  const [, scheme, user, password, hosts, path, query] = m;
  const srv = /\+srv/i.test(scheme);
  if (srv && hosts.includes(',')) return { error: 'mongodb+srv:// takes one host name (DNS gives the members). Use mongodb:// for a list of hosts.' };
  if (srv && /:\d+$/.test(hosts)) return { error: 'mongodb+srv:// does not take a port. Use mongodb://host:port for a port.' };
  const params = {};
  for (const kv of String(query || '').replace(/^\?/, '').split('&').filter(Boolean)) {
    const [k, v = ''] = kv.split('=');
    params[dec(k)] = dec(v);
  }
  return { scheme: scheme.toLowerCase(), user: user ? dec(user) : '', password: password !== undefined ? dec(password) : '', hosts, srv, db: path ? dec(path.slice(1)) : '', params, query: query || '' };
}

/** The string without the user and password (they are stored apart), and what was taken out. */
function splitUri(text) {
  const p = parseUri(text);
  if (p.error) return { uri: String(text || '').trim(), user: '', password: '' };
  const uri = `${p.scheme}://${p.hosts}/${p.db ? encodeURIComponent(p.db) : ''}${p.query}`;
  return { uri, user: p.user, password: p.password };
}

function displayHosts(text) {
  const p = parseUri(text);
  if (p.error) return String(text || '').slice(0, 60);
  return `${p.srv ? 'srv:' : ''}${p.hosts}`;
}

/** Problems with a connection before it is saved or tested (empty list = fine). */
function validate(c) {
  const errs = [];
  const p = parseUri(c.uri);
  if (p.error) errs.push(p.error);
  if (c.readPreference && !['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'].includes(c.readPreference)) errs.push('Unknown read preference.');
  if (c.directConnection === 'yes' && p.srv) errs.push('Direct connection does not work with mongodb+srv://.');
  if (c.directConnection === 'yes' && p.hosts && p.hosts.includes(',')) errs.push('Direct connection needs exactly one host.');
  return errs;
}

module.exports = { parseUri, splitUri, displayHosts, validate };
