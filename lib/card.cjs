'use strict';

// This function also travels inside each capsule. The card has no scripts,
// external fonts, requests, or machine paths; the download is the actual CJS.
function makeCard(capsule, script) {
  const esc = x => String(x).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const verdict = value => /^[A-Z_]+$/.test(value)
    ? '<span class="fail">× ' + esc(value) + '</span>'
    : '<span class="pass">✓ ' + esc(value) + '</span>';
  const rows = capsule.rows.map(row => '<tr><th><code>' + esc(row.spec) + '</code><small>'
    + esc(row.condition || 'default conditions') + '</small></th><td>' + verdict(row.expected.import)
    + '</td><td>' + verdict(row.expected.require) + '</td></tr>').join('');
  const size = (Buffer.byteLength(script) / 1024).toFixed(1);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>HollowImport · Native resolution report</title>
<style>
:root{color-scheme:light dark;--bg:#111816;--fg:#e8eee8;--muted:#aab9ad;--line:#425348;--ok:#a5e59d;--bad:#ffb08a}*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;margin:0}main{max-width:910px;margin:auto;padding:clamp(20px,6vw,64px) 20px}
header,footer,.download{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}header{border-bottom:1px solid var(--line);padding-bottom:16px}
.brand{font:bold 20px ui-monospace,monospace}.brand i{font-style:normal;color:var(--ok)}small,.meta{color:var(--muted)}
h1{font-size:clamp(34px,6vw,58px);letter-spacing:-.055em;line-height:1.05;margin:40px 0 12px}h2{font-size:20px;margin:28px 0 12px}
.intro{max-width:60ch}table{width:100%;border-collapse:collapse;margin:23px 0;font-size:14px}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
thead th{color:var(--muted);font-weight:500}tbody small{display:block;font-weight:normal}td,.mono,pre,code{font-family:ui-monospace,monospace}.pass{color:var(--ok)}.fail{color:var(--bad)}
.download{background:#202d25;border:1px solid var(--line);border-radius:12px;padding:16px}.download a{display:inline-block;color:#142416;background:#b7ef9d;border-radius:7px;font-weight:700;padding:9px 15px;text-decoration:none}
pre{padding:12px;background:#1b2520;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer}footer{margin-top:36px;border-top:1px solid var(--line);padding-top:16px}a:focus-visible,summary:focus-visible{outline:3px solid #ffcf79;outline-offset:3px}
@media(max-width:540px){th,td{padding:9px 4px;font-size:12px}td{word-break:break-word}}@media print{body{color:#111;background:white}.pass,.fail,.meta,small{color:#333}.download{display:none}}
</style><main><header><strong class="brand"><i>◌</i> HollowImport</strong><small>Native Node resolution report</small></header>
<h1>Reproduce this import failure.</h1><p class="intro">These results matched on the original package and a fresh, anonymous fixture. Replay them with Node or inspect the fixture first.</p>
<p class="meta">Captured on Node ${esc(capsule.node)} · Report replayed on Node ${esc(process.versions.node)}</p>
<table><thead><tr><th>Entry</th><th>ESM import</th><th>CommonJS require</th></tr></thead><tbody>${rows}</tbody></table>
<div class="download"><div><strong>Standalone repro</strong><br><small>${size} KiB · Node 22.15+ · no dependencies</small></div>
<a download="repro.cjs" href="data:application/octet-stream;base64,${Buffer.from(script).toString('base64')}">Download repro.cjs</a></div>
<h2>Run it locally</h2><pre>node repro.cjs</pre>
<details><summary>Inspect the anonymous package and expected outcomes</summary><pre>${esc(JSON.stringify(capsule, null, 2))}</pre></details>
<footer><small>Successful cells identify resolved files. Package initialization is outside this check.</small></footer></main></html>`;
}
module.exports = {makeCard};
