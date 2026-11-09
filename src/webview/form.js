// Connection form: a connection string plus optional fields. The password goes to the host only on Test or
// Save, and the host keeps it in VS Code SecretStorage, never in settings or in the saved string.
import { h } from './dom.js';
import connstr from '../core/connstr.js';

export function startForm(vscode, app, data) {
  const c = Object.assign({ name: '', uri: 'mongodb://localhost:27017', user: '', authSource: '', tls: '', caFile: '', tlsInsecure: false, replicaSet: '', directConnection: '', readPreference: '', readOnly: false, savePassword: true }, data.conn || {});
  const editing = !!(data.conn && data.conn.id);
  const hasPassword = !!data.hasPassword;

  const field = (label, input, help) => h('label', { class: 'field' }, h('span', { class: 'label' }, label), input, help ? h('span', { class: 'help' }, help) : null);
  const inp = (name, attrs = {}) => { const el = h('input', { name, id: `f-${name}`, type: 'text', spellcheck: 'false', ...attrs }); el.value = c[name] === undefined || c[name] === null ? '' : String(c[name]); return el; };
  const sel = (name, opts) => { const el = h('select', { id: `f-${name}` }); for (const [v, l] of opts) { const o = h('option', { value: v }, l); if (String(c[name] || '') === v) o.selected = true; el.append(o); } return el; };
  const chk = (name) => { const el = h('input', { type: 'checkbox', id: `f-${name}` }); el.checked = !!c[name]; return el; };

  const uri = inp('uri', { placeholder: 'mongodb://localhost:27017  or  mongodb+srv://cluster0.example.mongodb.net' });
  const name = inp('name', { placeholder: 'My MongoDB' });
  const user = inp('user', { autocomplete: 'off', placeholder: 'optional' });
  const password = h('input', { type: 'password', id: 'f-password', autocomplete: 'new-password', placeholder: editing && hasPassword ? 'saved (leave empty to keep it)' : 'optional' });
  const savePw = h('input', { type: 'checkbox', id: 'f-savePassword' });
  savePw.checked = c.savePassword !== false;
  const authSource = inp('authSource', { placeholder: 'from the string, else admin' });
  const tls = sel('tls', [['', 'From the string (mongodb+srv:// uses TLS)'], ['on', 'On'], ['off', 'Off']]);
  const ca = inp('caFile', { placeholder: 'optional PEM file, for a private CA' });
  const caBtn = h('button', { type: 'button', class: 'btn' }, 'Browse…');
  const insecure = chk('tlsInsecure');
  const replicaSet = inp('replicaSet', { placeholder: 'from the string' });
  const direct = sel('directConnection', [['', 'From the string'], ['yes', 'Yes: talk to this one host only'], ['no', 'No: discover the replica set']]);
  const readPref = sel('readPreference', [['', 'From the string (primary)'], ['primary', 'primary'], ['primaryPreferred', 'primaryPreferred'], ['secondary', 'secondary'], ['secondaryPreferred', 'secondaryPreferred'], ['nearest', 'nearest']]);
  const ro = chk('readOnly');

  const status = h('div', { class: 'form-status', role: 'status', 'aria-live': 'polite' });
  const test = h('button', { type: 'button', class: 'btn' }, 'Test connection');
  const save = h('button', { type: 'button', class: 'btn primary' }, editing ? 'Save' : 'Save connection');
  const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');

  const uriNote = h('span', { class: 'help' });
  const checkUri = () => {
    const p = connstr.parseUri(uri.value);
    if (p.error) { uriNote.textContent = p.error; uriNote.className = 'help bad'; return; }
    uriNote.className = 'help';
    const bits = [];
    if (p.user) bits.push(`user ${p.user}${p.password ? ' and a password (both are moved out of the string when you save)' : ''}`);
    if (p.params.replicaSet) bits.push(`replica set ${p.params.replicaSet}`);
    if (p.params.tls === 'true' || p.params.ssl === 'true' || p.srv) bits.push('TLS');
    if (p.params.authSource) bits.push(`auth database ${p.params.authSource}`);
    uriNote.textContent = bits.length ? `Found: ${bits.join(', ')}.` : 'The string may hold options such as ?replicaSet=rs0&tls=true. The fields below override it.';
  };
  uri.addEventListener('input', checkUri);
  checkUri();

  const form = h('div', { class: 'conn-form' },
    h('h2', {}, editing ? `Edit ${c.name}` : 'New MongoDB connection'),
    h('p', { class: 'help' }, 'Works with MongoDB 4.2 and later, MongoDB Atlas, Azure Cosmos DB for MongoDB and DocumentDB, Amazon DocumentDB and FerretDB. The extension connects only to this server, only when you open it, and closes the connection after 10 idle minutes.'),
    field('Connection string', uri, null), uriNote,
    h('div', { class: 'row2' }, field('User', user), field('Password', password)),
    h('label', { class: 'check' }, savePw, ' Save the password in VS Code secret storage (otherwise it is asked once per window)'),
    h('div', { class: 'row2' }, field('Auth database', authSource), field('Replica set name', replicaSet)),
    h('div', { class: 'row2' }, field('TLS', tls), field('Direct connection', direct)),
    h('div', { class: 'row-ca' }, field('CA certificate file', ca), caBtn),
    h('label', { class: 'check' }, insecure, ' Allow invalid certificates and host names (only for a local test server)'),
    field('Read preference', readPref),
    field('Name', name, 'Shown in the explorer. Empty: the host name.'),
    h('label', { class: 'check' }, ro, ' Read-only: block every change (edits, inserts, deletes, imports, drops, index changes, $out and $merge)'),
    h('div', { class: 'buttons' }, test, save, cancel),
    status);
  app.append(form);

  const collect = () => ({
    uri: uri.value.trim(), name: name.value.trim(), user: user.value.trim(), authSource: authSource.value.trim(), tls: tls.value, caFile: ca.value.trim(), tlsInsecure: insecure.checked,
    replicaSet: replicaSet.value.trim(), directConnection: direct.value, readPreference: readPref.value, readOnly: ro.checked, savePassword: savePw.checked,
  });
  const pw = () => (password.value ? password.value : undefined);
  test.addEventListener('click', () => { status.textContent = 'Connecting…'; status.className = 'form-status'; vscode.postMessage({ type: 'test', conn: collect(), password: pw() }); });
  save.addEventListener('click', () => vscode.postMessage({ type: 'save', conn: collect(), password: pw() }));
  cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  caBtn.addEventListener('click', () => vscode.postMessage({ type: 'browse', what: 'ca' }));
  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'tested' || m.type === 'saved') { status.textContent = m.message; status.className = 'form-status ' + (m.ok ? 'ok' : 'bad'); }
    if (m.type === 'browsed') ca.value = m.path;
  });
  uri.focus();
}
