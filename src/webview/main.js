// Webview entry: picks the page (documents, aggregation or connection form) from <body data-page>.
import { startDocs } from './docs.js';
import { startAgg } from './agg.js';
import { startForm } from './form.js';

// eslint-disable-next-line no-undef
const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
let data = {};
try { data = JSON.parse(document.getElementById('zovo-data').textContent || '{}'); } catch { data = {}; }
const page = document.body.dataset.page;
if (page === 'form') startForm(vscode, app, data);
else if (page === 'agg') startAgg(vscode, app, data);
else startDocs(vscode, app, data);

// Footer links (Rate, Sponsor, More free tools) are plain links or command messages; nothing is sent by itself.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('[data-command]');
  if (a) { e.preventDefault(); vscode.postMessage({ type: 'command', command: a.dataset.command }); }
});
