'use strict';
// explain('executionStats') as a readable tree with plain hints. The page has no script
// (CSP default-src 'none'; style-src 'unsafe-inline'), and nothing on it loads from anywhere.

const { relax } = require('./core/wire');
const shell = require('./core/shell');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const num = (x) => (typeof x === 'number' ? x : (x && typeof x === 'object' && x.$numberLong ? Number(x.$numberLong) : Number(x) || 0));

/** The parts of an explain result that matter, for a find or an aggregate, classic or SBE plan. */
function parts(raw) {
  const r = relax(raw);
  let qp = r.queryPlanner;
  let es = r.executionStats;
  const aggStages = Array.isArray(r.stages) ? r.stages : null;
  if (!qp && aggStages && aggStages[0] && aggStages[0].$cursor) { qp = aggStages[0].$cursor.queryPlanner; es = aggStages[0].$cursor.executionStats; }
  if (!qp && r.shards) { const first = Object.values(r.shards)[0] || {}; qp = first.queryPlanner || (first.stages && first.stages[0] && first.stages[0].$cursor && first.stages[0].$cursor.queryPlanner); es = es || first.executionStats; }
  const wp = qp ? (qp.winningPlan && qp.winningPlan.queryPlan ? qp.winningPlan.queryPlan : qp.winningPlan) : null;
  const classicExec = es && es.executionStages && /^[A-Z_]+$/.test(String(es.executionStages.stage || '')) ? es.executionStages : null;
  const later = aggStages ? aggStages.slice(1).map((s) => { const k = Object.keys(s).find((x) => x.startsWith('$')); return { name: k, spec: s[k], n: s.nReturned, ms: s.executionTimeMillisEstimate }; }).filter((x) => x.name) : [];
  return { r, qp, es, wp, exec: classicExec, later, engine: qp && qp.winningPlan && qp.winningPlan.slotBasedPlan ? 'SBE' : (r.explainVersion === '2' ? 'SBE' : 'classic') };
}

function kids(st) {
  if (!st) return [];
  if (st.inputStage) return [st.inputStage];
  if (Array.isArray(st.inputStages)) return st.inputStages;
  if (st.outerStage || st.innerStage) return [st.outerStage, st.innerStage].filter(Boolean);
  return [];
}

function walk(st, fn, depth = 0) {
  if (!st) return;
  fn(st, depth);
  for (const k of kids(st)) walk(k, fn, depth + 1);
}

/** { ms, returned, keys, docs, stages: [names], indexes: [names], hints: [text] } */
function summarizeExplain(raw, query) {
  const p = parts(raw);
  const stages = [];
  const indexes = [];
  let collscan = false;
  let memSort = false;
  walk(p.exec || p.wp, (st) => {
    stages.push(st.stage);
    if (st.indexName) indexes.push(st.indexName);
    if (st.stage === 'COLLSCAN') collscan = true;
    if (st.stage === 'SORT') memSort = true;
  });
  const es = p.es || {};
  const ms = num(es.executionTimeMillis);
  const returned = num(es.nReturned);
  const keys = num(es.totalKeysExamined);
  const docs = num(es.totalDocsExamined);
  const hints = [];
  const filter = query && query.filter ? Object.keys(query.filter) : [];
  const match = query && query.pipeline && query.pipeline[0] && query.pipeline[0].$match ? Object.keys(query.pipeline[0].$match) : [];
  const fields = (filter.length ? filter : match).filter((k) => !k.startsWith('$'));
  if (collscan && (fields.length || docs > returned)) hints.push(`Full collection scan: the server read ${docs.toLocaleString('en-US')} documents one by one.${fields.length ? ` An index on ${fields.map((f) => `{ ${f}: 1 }`).join(' or ')} would let it jump to the matches.` : ''}`);
  else if (collscan) hints.push('Collection scan: fine when every document is wanted; a filter on an indexed field would avoid it.');
  if (returned && docs > returned * 10 && docs > 1000) hints.push(`Examined ${docs.toLocaleString('en-US')} documents to return ${returned.toLocaleString('en-US')} (${Math.round(docs / returned)} per result). A more selective index would read fewer.`);
  if (!returned && docs > 1000) hints.push(`Examined ${docs.toLocaleString('en-US')} documents and returned none.`);
  if (memSort) hints.push('The sort runs in memory (SORT stage). An index that ends with the sort field, in the sort direction, returns the documents already in order.');
  if (indexes.length) hints.push(`Uses the index ${[...new Set(indexes)].join(', ')}.`);
  if (keys && docs === 0 && returned) hints.push('Covered query: the answer came from the index alone, no document was read.');
  if (!hints.length) hints.push('Nothing stands out in this plan.');
  return { ms, returned, keys, docs, stages, indexes: [...new Set(indexes)], hints, engine: p.engine, laterStages: p.later.map((x) => x.name) };
}

function stageHtml(st) {
  const meta = [];
  if (st.indexName) meta.push(`index <b>${esc(st.indexName)}</b>`);
  if (st.keyPattern) meta.push(`keys ${esc(shell.format(toWireLoose(st.keyPattern), { indent: 0 }))}`);
  if (st.direction) meta.push(`direction ${esc(st.direction)}`);
  if (st.filter) meta.push(`filter ${esc(shell.format(toWireLoose(st.filter), { indent: 0 }).slice(0, 400))}`);
  if (st.sortPattern) meta.push(`sort ${esc(shell.format(toWireLoose(st.sortPattern), { indent: 0 }))}`);
  if (st.limitAmount !== undefined) meta.push(`limit ${esc(st.limitAmount)}`);
  if (st.skipAmount !== undefined) meta.push(`skip ${esc(st.skipAmount)}`);
  if (st.usedDisk) meta.push('<b>used disk</b>');
  const stats = [];
  if (st.nReturned !== undefined) stats.push(`${num(st.nReturned).toLocaleString('en-US')} returned`);
  if (st.docsExamined !== undefined) stats.push(`${num(st.docsExamined).toLocaleString('en-US')} docs examined`);
  if (st.keysExamined !== undefined) stats.push(`${num(st.keysExamined).toLocaleString('en-US')} keys examined`);
  if (st.executionTimeMillisEstimate !== undefined) stats.push(`~${num(st.executionTimeMillisEstimate)} ms`);
  const bad = st.stage === 'COLLSCAN' || st.stage === 'SORT';
  return `<div class="node${bad ? ' bad' : ''}"><div class="st">${esc(st.stage || '?')}</div>${meta.length ? `<div class="meta">${meta.join(' · ')}</div>` : ''}${stats.length ? `<div class="stats">${stats.join(' · ')}</div>` : ''}${kids(st).map((k) => `<div class="kid">${stageHtml(k)}</div>`).join('')}</div>`;
}

/** relax() output back to something format() prints (numbers are plain JS numbers here). */
function toWireLoose(v) {
  return v;
}

function explainHtml({ explain, query, ns, cspSource }) {
  void cspSource;
  const p = parts(explain);
  const s = summarizeExplain(explain, query);
  const csp = "default-src 'none'; style-src 'unsafe-inline'";
  const q = query.pipeline ? shell.format(query.pipeline, { indent: 2 }) : `find(${shell.format(query.filter || {}, { indent: 0 })}${query.projection && Object.keys(query.projection).length ? `, ${shell.format(query.projection, { indent: 0 })}` : ''})${query.sort && Object.keys(query.sort).length ? `.sort(${shell.format(query.sort, { indent: 0 })})` : ''}${query.skip ? `.skip(${query.skip})` : ''}${query.limit ? `.limit(${query.limit})` : ''}`;
  const root = p.exec || p.wp;
  const later = p.later.length ? `<h2>Later pipeline stages</h2><ol class="later">${p.later.map((x) => `<li><b>${esc(x.name)}</b> ${esc(shell.format(x.spec === undefined ? {} : x.spec, { indent: 0 }).slice(0, 300))}${x.n !== undefined ? ` · ${num(x.n).toLocaleString('en-US')} out` : ''}${x.ms !== undefined ? ` · ~${num(x.ms)} ms` : ''}</li>`).join('')}</ol>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Explain</title>
<style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:12px 18px;line-height:1.45}
h1{font-size:15px;margin:0 0 4px} h2{font-size:13px;margin:16px 0 6px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.04em}
pre{font-family:var(--vscode-editor-font-family);font-size:12px;background:var(--vscode-textCodeBlock-background,#8881);padding:8px;border-radius:3px;white-space:pre-wrap;word-break:break-word;margin:0}
.kpis{display:flex;gap:18px;flex-wrap:wrap;margin:8px 0}.kpi b{display:block;font-size:18px}.kpi span{color:var(--vscode-descriptionForeground);font-size:12px}
ul.hints{margin:0;padding-left:18px}ul.hints li{margin:3px 0}
.node{border-left:3px solid var(--vscode-charts-blue,#3794ff);padding:4px 8px;margin:6px 0;background:var(--vscode-editorWidget-background,#8881)}
.node.bad{border-left-color:var(--vscode-charts-orange,#d18616)}.st{font-weight:600;font-family:var(--vscode-editor-font-family)}
.meta,.stats{font-size:12px;color:var(--vscode-descriptionForeground);word-break:break-word}.kid{margin-left:18px}
.muted{color:var(--vscode-descriptionForeground)} details{margin-top:14px} summary{cursor:pointer}
</style></head><body>
<h1>Explain · ${esc(ns)}</h1><div class="muted">executionStats · ${esc(s.engine)} engine${p.qp && p.qp.indexFilterSet ? ' · index filter set' : ''}</div>
<h2>Query</h2><pre>${esc(q)}</pre>
<div class="kpis"><div class="kpi"><b>${s.ms.toLocaleString('en-US')} ms</b><span>execution time</span></div><div class="kpi"><b>${s.returned.toLocaleString('en-US')}</b><span>returned</span></div><div class="kpi"><b>${s.docs.toLocaleString('en-US')}</b><span>documents examined</span></div><div class="kpi"><b>${s.keys.toLocaleString('en-US')}</b><span>index keys examined</span></div></div>
<h2>What it means</h2><ul class="hints">${s.hints.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
<h2>Plan${p.exec ? ' (with execution stats)' : ''}</h2>${root ? stageHtml(root) : '<div class="muted">This server did not return a plan tree. The raw output is below.</div>'}
${later}
<details><summary>Raw explain output</summary><pre>${esc(shell.format(explain, { indent: 2 }).slice(0, 400000))}</pre></details>
</body></html>`;
}

module.exports = { explainHtml, summarizeExplain, parts };
