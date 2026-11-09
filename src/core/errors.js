'use strict';
// Driver errors -> one clear sentence for the user. Pure, so tests can check the texts.

const NET = /MongoNetworkError|MongoServerSelectionError|MongoTopologyClosedError|MongoPoolClearedError|PoolClearedError|MongoNetworkTimeoutError|MongoClientClosedError|MongoNotConnectedError|MongoExpiredSessionError/;

function isConnectionLost(e) {
  if (!e) return false;
  const name = `${e.name || ''} ${e.constructor && e.constructor.name ? e.constructor.name : ''}`;
  if (NET.test(name)) return true;
  const m = String(e.message || '');
  return /ECONNRESET|EPIPE|connection .* closed|Topology is closed|client was closed|Client must be connected|socket hang up|not connected/i.test(m);
}

function hostOf(cfg) {
  const u = String((cfg && cfg.uri) || '');
  const m = /^mongodb(\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(u);
  return m ? m[2] : u;
}

/** A friendly Error for a driver error during connect (phase 'connect') or an operation. */
function friendly(e, cfg, phase) {
  if (!e) return new Error('Unknown error');
  if (e.friendly) return e;
  const msg = String(e.message || e);
  const host = hostOf(cfg);
  const reason = e.reason && e.reason.servers ? [...e.reason.servers.values()].map((s) => s.error && s.error.message).filter(Boolean)[0] : '';
  const all = `${msg} ${reason || ''}`;
  let text = msg;
  if (e.code === 18 || /Authentication failed|auth failed|bad auth/i.test(all)) text = `The user name or password is wrong, or the user is not in this auth database${cfg && cfg.authSource ? ` (${cfg.authSource})` : ''}. The server said: authentication failed.`;
  else if (/ECONNREFUSED/.test(all)) text = `Nothing answers at ${host}. Is the server running, and is the port right?`;
  else if (/querySrv|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(all)) text = `The host name ${host} could not be found (DNS). Check the connection string${/srv/i.test(String(cfg && cfg.uri)) ? ' and that mongodb+srv:// is right for this server' : ''}.`;
  else if (/self[- ]signed|unable to verify|certificate|CERT_|SSL|TLS|EPROTO|wrong version number/i.test(all)) text = `The TLS connection to ${host} failed: ${reason || msg}. Check the TLS switch and the CA file.`;
  else if (e.name === 'MongoServerSelectionError' || /Server selection timed out|timed out after \d+ms/i.test(all)) text = `No MongoDB server answered at ${host} within the time limit${reason ? `: ${reason}` : ''}. Check the host, the port, the firewall and the replica set name.`;
  else if (e.code === 13 || /not authorized|Unauthorized/i.test(all)) text = `The user is not allowed to do this: ${msg}`;
  else if (e.code === 50 || /exceeded time limit|MaxTimeMSExpired/i.test(all)) text = `The server stopped the command because it ran longer than the time limit (setting zovoMongo.queryTimeoutSeconds). ${msg}`;
  else if (e.code === 11601 || /operation was interrupted|Interrupted/i.test(all)) text = 'The command was cancelled.';
  else if (e.code === 11000) text = `A document with this key already exists (duplicate key): ${msg.replace(/^E11000 duplicate key error /, '')}`;
  else if (phase === 'connect') text = `Could not connect to ${host}: ${msg}`;
  const out = new Error(text);
  out.friendly = true;
  out.code = e.code;
  out.cause = e;
  out.lost = isConnectionLost(e);
  out.cancelled = e.code === 11601 || /operation was interrupted/i.test(all);
  return out;
}

module.exports = { friendly, isConnectionLost, hostOf };
