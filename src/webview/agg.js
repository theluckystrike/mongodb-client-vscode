// Aggregation page: a pipeline editor (shell syntax, one array of stages) with a preview of the first
// 20 documents after every stage. Run opens the full result in a documents panel; Explain shows the plan.

import { h } from './dom.js';
import shell from '../core/shell.js';

export function startAgg(vscode, app, data) {
  const saved = vscode.getState() || {};
  const ta = h('textarea', { class: 'pipe-ta', spellcheck: 'false', 'aria-label': 'Pipeline' });
  ta.value = saved.text || data.pipeline || '[\n  { $match: {} }\n]';
  const previewBtn = h('button', { class: 'btn primary', title: 'Run each stage on the server and show its first 20 documents (Ctrl/Cmd+Enter)' }, 'Preview stages');
  const runBtn = h('button', { class: 'btn', title: 'Run the whole pipeline and open the result as documents' }, 'Run');
  const explainBtn = h('button', { class: 'btn', title: 'Explain the pipeline' }, 'Explain');
  const exportBtn = h('button', { class: 'btn', title: 'Export the pipeline result (streamed)' }, 'Export');
  const cancelBtn = h('button', { class: 'btn danger hidden', title: 'Stop the running stage on the server' }, 'Cancel');
  const spinner = h('span', { class: 'spinner hidden', 'aria-hidden': 'true' });
  const statusEl = h('span', { class: 'hint' });
  const errBox = h('div', { class: 'error hidden', role: 'alert' });
  const stagesEl = h('div', { class: 'stages' });
  const left = h('div', { class: 'agg-left' }, ta, h('div', { class: 'hint' }, 'One array of stages. Shell syntax works: ObjectId("…"), ISODate("…"), NumberLong("…"), /regex/i, unquoted field names. $out and $merge are not run in the preview.'));
  const body = h('div', { class: 'agg-body' }, left, stagesEl);
  const toolbar = h('div', { class: 'qbar' }, h('span', { class: 'qlabel' }, data.ns), previewBtn, runBtn, explainBtn, exportBtn, spinner, cancelBtn, statusEl);
  const status = h('div', { class: 'status' }, h('span', { class: 'status-text' }, data.readOnly ? '🔒 Read-only connection: $out and $merge are blocked.' : ''), h('span', { class: 'grow' }));
  const supportLine = document.getElementById('zovo-support');
  if (supportLine) status.append(supportLine);
  app.append(toolbar, errBox, body, status);

  const send = (type) => {
    errBox.classList.add('hidden');
    try { shell.parsePipeline(ta.value); } catch (e) { errBox.textContent = e.message; errBox.classList.remove('hidden'); return; }
    vscode.setState({ text: ta.value });
    vscode.postMessage({ type, text: ta.value });
  };
  previewBtn.addEventListener('click', () => send('preview'));
  runBtn.addEventListener('click', () => send('run'));
  explainBtn.addEventListener('click', () => send('explain'));
  exportBtn.addEventListener('click', () => send('export'));
  cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send('preview'); }
    if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd); ta.setSelectionRange(s + 2, s + 2); }
  });
  ta.addEventListener('input', () => vscode.setState({ text: ta.value }));

  const busy = (on) => { spinner.classList.toggle('hidden', !on); cancelBtn.classList.toggle('hidden', !on); previewBtn.disabled = on; runBtn.disabled = on; };

  function renderStages(stages) {
    stagesEl.textContent = '';
    for (const st of stages) {
      const head = h('div', { class: 'stage-head' }, h('b', {}, `${st.stage + 1}. ${st.name}`), h('span', { class: 'hint' }, st.skipped ? 'not run' : st.error ? 'error' : `${st.docs.length}${st.docs.length === 20 ? '+' : ''} document${st.docs.length === 1 ? '' : 's'}${st.ms !== undefined ? ` · ${st.ms} ms` : ''}`));
      const card = h('details', { class: 'stage' + (st.error ? ' bad' : ''), open: st.stage === stages.length - 1 || !!st.error }, h('summary', {}, head));
      if (st.note) card.append(h('div', { class: 'hint' }, st.note));
      if (st.error) card.append(h('div', { class: 'error' }, st.error));
      for (const d of st.docs) card.append(h('pre', { class: 'doc' }, shell.format(d, { indent: 2 })));
      if (!st.docs.length && !st.error && !st.skipped) card.append(h('div', { class: 'hint' }, 'No documents come out of this stage.'));
      stagesEl.append(card);
    }
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'running') { busy(true); statusEl.textContent = 'Running…'; stagesEl.textContent = ''; }
    if (m.type === 'stage') statusEl.textContent = `Running stage ${m.index + 1}…`;
    if (m.type === 'preview') { busy(false); statusEl.textContent = `${m.stages.length} stage${m.stages.length === 1 ? '' : 's'} previewed`; renderStages(m.stages); }
    if (m.type === 'error') { busy(false); statusEl.textContent = ''; errBox.textContent = m.message; errBox.classList.remove('hidden'); }
    if (m.type === 'cancelled') { busy(false); statusEl.textContent = 'Cancelled.'; }
    if (m.type === 'idle') { busy(false); statusEl.textContent = ''; }
  });
}
