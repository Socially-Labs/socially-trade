import { createHash } from "node:crypto";

const css = String.raw`
:root{color-scheme:dark;--bg:#101215;--surface:#171a1f;--raised:#20242b;--line:#303640;--text:#edf1f7;--muted:#a4aebc;--accent:#94b9ff;--green:#7bddb3;--amber:#ffd18c;--red:#ff9eaa;--radius:8px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-size:13px}button,input,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}button,input,select{border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--text)}button{min-height:40px;padding:0 13px;font-weight:550}button:hover:not(:disabled){background:var(--raised);border-color:#647188}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:3px}a{color:var(--accent)}.shell{display:grid;grid-template-columns:218px 1fr;min-height:100dvh}aside{padding:26px 16px;border-right:1px solid var(--line);background:#14171b;display:flex;flex-direction:column;gap:32px}.brand{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:650;letter-spacing:-.4px}.brand-mark{width:29px;height:29px;border-radius:8px;background:var(--accent);color:var(--bg);display:grid;place-items:center;font-size:19px}.eyebrow{font-size:10px;font-weight:650;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase;margin:0 0 12px}.nav-item{display:flex;align-items:center;gap:10px;padding:12px;background:var(--raised);border:1px solid var(--line);border-radius:6px;color:var(--text)}.nav-item span{color:var(--accent)}.service-list{display:grid;gap:7px}.service-btn{width:100%;text-align:left;display:flex;justify-content:space-between;align-items:center;background:transparent;border-color:transparent}.service-btn[aria-pressed=true]{border-color:var(--line);background:var(--raised)}.service-name{display:flex;align-items:center;gap:9px}.dot{width:6px;height:6px;border-radius:50%;background:var(--muted);display:inline-block}.dot.active{background:var(--green)}.service-count{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted)}.sidebar-note{margin-top:auto;border-top:1px solid var(--line);padding-top:18px;color:var(--muted);line-height:1.7;font-size:11px}.sidebar-note strong{color:var(--text);display:block;font-size:12px;font-weight:500}.main{padding:28px 30px 20px;min-width:0;display:flex;flex-direction:column;height:100dvh;gap:22px}.topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.topbar h1{font-size:25px;letter-spacing:-.8px;margin:0 0 7px;font-weight:650}.subtitle{margin:0;color:var(--muted);font-size:12px;line-height:1.7}.actions{display:flex;gap:8px;align-items:center}.live-button{color:var(--green);display:flex;align-items:center;gap:8px}.live-button[aria-pressed=false]{color:var(--amber)}.metrics{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}.metric{padding:17px 20px;border-right:1px solid var(--line)}.metric:last-child{border:0}.metric-label{display:block;color:var(--muted);font-size:11px;margin-bottom:10px}.metric-value{font:24px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:-1px}.metric-hint{font-size:10px;color:var(--muted);margin-left:9px}.error-value{color:var(--red)}.warn-value{color:var(--amber)}.panel{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);display:flex;flex-direction:column;flex:1;min-height:240px;overflow:hidden}.panel-top{padding:16px 18px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);gap:12px}.panel-title{font-size:13px;font-weight:600}.panel-title small{font-weight:400;color:var(--muted);margin-left:9px}.transport{display:flex;gap:7px;align-items:center;color:var(--muted);font-size:11px}.filters{display:grid;grid-template-columns:minmax(180px,2fr) repeat(3,minmax(115px,1fr));gap:12px;padding:16px 18px 12px}.field label{display:block;color:var(--muted);font-size:10px;font-weight:600;margin-bottom:7px}.field input,.field select{width:100%;height:40px;padding:0 11px;background:var(--bg);min-width:0}.filter-bottom{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:0 18px 14px}.request-field{display:flex;gap:10px;align-items:center;color:var(--muted);font-size:11px}.request-field input{height:34px;width:170px;background:var(--bg);padding:0 10px;font:11px ui-monospace,SFMono-Regular,Consolas,monospace}.reset{background:none;border:0;color:var(--accent);min-height:36px;font-size:11px}.columns,.log-row{display:grid;grid-template-columns:116px 86px 66px minmax(150px,1fr) 90px;gap:14px;align-items:center}.columns{padding:12px 18px;background:var(--bg);border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:9px;font-weight:600;letter-spacing:1px;color:var(--muted);text-transform:uppercase}.log-list{overflow:auto;flex:1;scrollbar-color:var(--line) var(--surface)}.log-row{width:100%;text-align:left;border:0;border-bottom:1px solid #272c34;border-radius:0;background:transparent;padding:13px 18px;min-height:51px;font-weight:400;font-size:11px}.log-row:hover:not(:disabled){background:var(--raised)}.log-row:focus-visible{outline-offset:-3px}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.timestamp{color:var(--muted);font-size:10px}.timestamp small{display:block;font-size:9px;margin-top:3px;color:var(--muted)}.service-tag{font-size:10px;color:var(--accent)}.level{font:9px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.4px;padding:4px 5px;border-radius:4px;display:inline-block;width:max-content;color:var(--muted);background:#282e36}.level.info{color:var(--accent);background:#243247}.level.warn{color:var(--amber);background:#3b3022}.level.error,.level.fatal{color:var(--red);background:#40282f}.message{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.6}.request-id{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:10px}.empty{display:grid;place-content:center;min-height:210px;text-align:center;padding:30px;color:var(--muted);line-height:1.8}.empty strong{font-size:15px;color:var(--text);font-weight:500;margin-bottom:7px}.footer{display:flex;justify-content:space-between;gap:16px;border-top:1px solid var(--line);padding:11px 18px;font-size:10px;color:var(--muted);line-height:1.5}.notice{margin:0;padding:11px 18px;border-bottom:1px solid var(--line);background:#302919;color:var(--amber);font-size:11px;line-height:1.7}.notice[hidden]{display:none}.status-error{color:var(--red)}.page-foot{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);gap:14px}dialog{color:var(--text);border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:0;max-width:calc(100vw - 28px)}dialog::backdrop{background:#05080bc9}.detail{width:560px;margin:0 0 0 auto;height:100dvh;max-height:100dvh;border-radius:0;border-top:0;border-bottom:0;overflow:auto}.detail-head{display:flex;justify-content:space-between;align-items:center;padding:22px;border-bottom:1px solid var(--line)}.detail-head h2{font-size:17px;margin:0}.detail-body{padding:22px}.detail-body dl{display:grid;grid-template-columns:100px 1fr;gap:14px;font-size:12px;margin:0 0 25px}.detail-body dt{color:var(--muted)}.detail-body dd{margin:0;overflow-wrap:anywhere}.detail-body pre{font:11px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);border:1px solid var(--line);padding:16px;border-radius:6px}.detail-message{font:13px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;margin:0 0 22px}.detail-actions{display:flex;gap:8px}.auth{width:390px}.auth form{padding:25px;display:grid;gap:17px}.auth h2{font-size:20px;margin:0}.auth p{margin:0;color:var(--muted);line-height:1.7;font-size:12px}.auth .field input{margin-top:3px}.auth-error{color:var(--red)!important;min-height:16px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.skeleton{height:50px;margin:0 18px;border-bottom:1px solid var(--line);background:linear-gradient(90deg,transparent,var(--raised),transparent);opacity:.45}
@media(max-width:1100px){.main{padding:22px 20px}.shell{grid-template-columns:180px 1fr}.columns,.log-row{grid-template-columns:98px 64px 54px minmax(100px,1fr);gap:10px}.request-id,.request-col{display:none}.filters{grid-template-columns:repeat(3,1fr)}.search-field{grid-column:1/-1}.metric{padding:15px}.metric-hint{display:block;margin:6px 0 0}}@media(max-width:700px){.shell{display:block}aside{display:none}.main{padding:18px 12px;gap:17px;height:auto;min-height:100dvh}.topbar{display:block}.actions{margin-top:16px}.metrics{grid-template-columns:repeat(2,1fr)}.metric:nth-child(2){border-right:0}.metric:nth-child(-n+2){border-bottom:1px solid var(--line)}.panel{height:65dvh;min-height:440px;flex:none}.filters{gap:8px;padding:12px}.field label{font-size:10px}.field select{padding-left:6px;font-size:11px}.filter-bottom{padding:0 12px 12px}.columns,.log-row{grid-template-columns:68px 48px 47px minmax(80px,1fr);gap:7px;padding-left:12px;padding-right:12px}.timestamp{font-size:9px}.timestamp small{display:none}.service-tag{font-size:9px}.level{font-size:8px}.log-row{min-height:56px}.message{font-size:10px}.panel-top{padding:13px 12px;flex-wrap:wrap}.footer{padding:10px 12px}.detail{width:100%;max-width:100vw}.page-foot{flex-wrap:wrap}.panel-title small{display:none}}`;

const script = String.raw`
(() => {
  const $ = id => document.getElementById(id);
  const inputs = ['search', 'service', 'level', 'range', 'request'];
  let data = null, token = '', live = true, timer, debounce, controller, revision = 0, selected = null, rendered = '';
  const labels = { api: 'API', worker: 'Worker', ingestor: 'Ingestor' };
  const number = value => new Intl.NumberFormat().format(value);
  const params = new URLSearchParams(location.search);
  for (const id of inputs) { const value = params.get(id); if (value) $(id).value = value; }
  for (const id of ['service', 'level', 'range']) if (!$(id).value) $(id).value = id === 'range' ? '0' : 'all';
  function persistFilters() {
    const query = new URLSearchParams();
    for (const id of inputs) if ($(id).value && !['all', '0'].includes($(id).value)) query.set(id, $(id).value);
    history.replaceState(null, '', location.pathname + (query.size ? '?' + query : ''));
  }
  function query() {
    const result = new URLSearchParams();
    if ($('service').value !== 'all') result.set('service', $('service').value);
    if ($('level').value !== 'all') result.set('level', $('level').value);
    if ($('search').value.trim()) result.set('q', $('search').value.trim());
    if ($('request').value.trim()) result.set('requestId', $('request').value.trim());
    if ($('range').value !== '0') result.set('since', new Date(Date.now() - Number($('range').value) * 60000).toISOString());
    return result;
  }
  function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('status-error', error); }
  function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
  function cell(className, text) { const item = document.createElement('span'); item.className = className; item.textContent = text; return item; }
  function render(result) {
    data = result;
    $('retained').textContent = number(result.retained);
    $('errors').textContent = number(result.errors);
    $('warnings').textContent = number(result.warnings);
    $('sources').textContent = result.services.filter(service => service.count > 0).length + ' / 3';
    $('all-count').textContent = number(result.retained);
    for (const service of result.services) {
      $(service.name + '-count').textContent = number(service.count);
      $(service.name + '-dot').classList.toggle('active', !!service.count);
      $(service.name + '-button').title = service.lastSeen ? 'Last log: ' + new Date(service.lastSeen).toLocaleString() : 'No logs collected yet';
    }
    document.querySelectorAll('[data-service]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.service === $('service').value)));
    $('transport').textContent = result.transport === 'redis' ? 'Redis aggregation connected' : result.transport === 'local' ? 'Local API buffer' : 'Redis aggregation unavailable';
    $('transport-dot').classList.toggle('active', result.transport === 'redis');
    notice(result.transport === 'redis' ? '' : result.transport === 'local' ? 'Only this API process is visible. Set REDIS_URL for all three services and restart them to collect worker and ingestor logs.' : 'Redis is unavailable. Showing this API process’s local logs; shared service logs return when Redis reconnects.');
    $('count').textContent = 'Showing ' + number(result.entries.length) + ' of ' + number(result.total) + ' matching logs';
    $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    $('export').disabled = !result.entries.length;
    const signature = JSON.stringify(result.entries);
    if (rendered === signature) return;
    rendered = signature;
    const list = $('logs'), oldScroll = list.scrollTop, fragment = document.createDocumentFragment();
    if (!result.entries.length) {
      const empty = document.createElement('div'); empty.className = 'empty';
      empty.append(cell('', result.retained ? 'No logs match these filters' : 'Waiting for service logs'));
      empty.firstChild.replaceWith(Object.assign(document.createElement('strong'), { textContent: result.retained ? 'No logs match these filters' : 'Waiting for service logs' }));
      empty.append(cell('', result.retained ? 'Try another service, time range, or search. Use Reset to clear filters.' : 'Run the backend services. New entries appear here automatically.'));
      fragment.append(empty);
    }
    for (const entry of result.entries) {
      const row = document.createElement('button'); row.className = 'log-row'; row.type = 'button';
      row.setAttribute('aria-label', labels[entry.service] + ', ' + entry.level + ', ' + entry.message + '. View details');
      const date = new Date(entry.time), time = cell('timestamp mono', date.toLocaleTimeString([], { hour12: false }));
      time.append(Object.assign(document.createElement('small'), { textContent: date.toLocaleDateString([], { month: 'short', day: 'numeric' }) }));
      const message = cell('message', entry.message); message.title = entry.message;
      row.append(time, cell('service-tag', labels[entry.service]), cell('level ' + entry.level, entry.level.toUpperCase()), message, cell('request-id mono', entry.requestId || '—'));
      row.addEventListener('click', () => details(entry)); fragment.append(row);
    }
    list.replaceChildren(fragment); list.scrollTop = oldScroll;
  }
  function details(entry) {
    selected = entry;
    $('detail-message').textContent = entry.message;
    $('detail-time').textContent = new Date(entry.time).toLocaleString() + ' (' + entry.time + ')';
    $('detail-service').textContent = labels[entry.service];
    $('detail-level').textContent = entry.level.toUpperCase();
    $('detail-instance').textContent = entry.instance;
    $('detail-request').textContent = entry.requestId || 'No request ID';
    $('filter-request').hidden = !entry.requestId;
    $('detail-json').textContent = JSON.stringify(entry.details, null, 2);
    $('copy').textContent = 'Copy JSON';
    $('detail').showModal();
  }
  async function load() {
    clearTimeout(timer); controller?.abort(); controller = new AbortController(); const version = ++revision;
    if (!data) status('Loading logs…');
    try {
      const response = await fetch('/admin/logs/data?' + query(), { headers: token ? { Authorization: 'Bearer ' + token } : {}, signal: controller.signal, cache: 'no-store' });
      if (version !== revision) return;
      if (response.status === 401) {
        live = false; updateLive(); status('Access token required', true); notice('Enter your admin access token to connect. It is held only in this tab’s memory.');
        if (!$('auth').open) $('auth').showModal();
        $('auth-error').textContent = token ? 'That access token was not accepted.' : '';
        return;
      }
      if (!response.ok) throw new Error(response.status === 404 ? 'Log viewer is disabled on this backend.' : 'Could not load logs (' + response.status + ').');
      const result = await response.json();
      if (version !== revision) return;
      render(result); status(live ? 'Live · refreshes every 2 seconds' : 'Paused · snapshot held');
      if ($('auth').open) $('auth').close();
    } catch (error) {
      if (error.name === 'AbortError' || version !== revision) return;
      status('Connection interrupted', true); notice(error.message + ' Use Refresh to retry.');
      if (!data) { $('logs').replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Unable to load logs. Check that the backend is running, then refresh.' })); }
    } finally { if (version === revision && live) timer = setTimeout(load, 2000); }
  }
  function updateLive() { $('live').setAttribute('aria-pressed', String(live)); $('live-label').textContent = live ? 'Live' : 'Paused'; }
  function changed() { rendered = ''; persistFilters(); clearTimeout(debounce); debounce = setTimeout(load, 250); }
  for (const id of inputs) $(id).addEventListener(id === 'search' || id === 'request' ? 'input' : 'change', changed);
  $('reset').addEventListener('click', () => { $('search').value = ''; $('request').value = ''; $('service').value = 'all'; $('level').value = 'all'; $('range').value = '0'; changed(); });
  document.querySelectorAll('[data-service]').forEach(button => button.addEventListener('click', () => { $('service').value = button.dataset.service; changed(); }));
  $('live').addEventListener('click', () => { live = !live; updateLive(); if (live) load(); else { clearTimeout(timer); controller?.abort(); ++revision; status('Paused · snapshot held'); } });
  $('refresh').addEventListener('click', load);
  $('export').addEventListener('click', () => {
    if (!data?.entries.length) return;
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), filters: Object.fromEntries(query()), totalMatching: data.total, exported: data.entries.length, entries: data.entries }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'socially-logs-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('close-detail').addEventListener('click', () => $('detail').close());
  $('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(JSON.stringify(selected, null, 2)); $('copy').textContent = 'Copied'; } catch { $('copy').textContent = 'Copy unavailable'; } });
  $('filter-request').addEventListener('click', () => { $('request').value = selected.requestId; $('detail').close(); changed(); });
  $('auth-form').addEventListener('submit', event => { event.preventDefault(); token = $('token').value.trim(); $('token').value = ''; live = true; updateLive(); load(); });
  $('cancel-auth').addEventListener('click', () => $('auth').close());
  document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(timer); controller?.abort(); ++revision; } else if (live) load(); });
  load();
})();`;

export const logsCsp = `default-src 'none'; script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'; style-src 'sha256-${createHash("sha256").update(css).digest("base64")}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export const logsHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Service logs · Socially</title><style>${css}</style></head>
<body><div class="shell">
<aside aria-label="Log navigation"><div class="brand"><span class="brand-mark" aria-hidden="true">s</span>socially<span class="sr-only"> admin</span></div>
<div><p class="eyebrow">Observability</p><div class="nav-item"><span aria-hidden="true">≡</span> Service logs</div></div>
<div><p class="eyebrow">Services</p><div class="service-list">
<button type="button" class="service-btn" data-service="all" aria-pressed="true"><span class="service-name">All services</span><span class="service-count" id="all-count">—</span></button>
<button type="button" class="service-btn" id="api-button" data-service="api" aria-pressed="false"><span class="service-name"><span class="dot" id="api-dot" aria-hidden="true"></span>API</span><span class="service-count" id="api-count">—</span></button>
<button type="button" class="service-btn" id="worker-button" data-service="worker" aria-pressed="false"><span class="service-name"><span class="dot" id="worker-dot" aria-hidden="true"></span>Worker</span><span class="service-count" id="worker-count">—</span></button>
<button type="button" class="service-btn" id="ingestor-button" data-service="ingestor" aria-pressed="false"><span class="service-name"><span class="dot" id="ingestor-dot" aria-hidden="true"></span>Ingestor</span><span class="service-count" id="ingestor-count">—</span></button>
</div></div><div class="sidebar-note"><strong>Recent service activity</strong>Counts reflect retained log entries, not service health.<br><br>Up to 2,000 entries · 24 hours<br>Newest entries appear first.</div></aside>
<main class="main"><header class="topbar"><div><p class="eyebrow">Backend / Observability</p><h1>Service logs</h1><p class="subtitle">One place for API requests, worker jobs, and market ingestion.</p></div><div class="actions"><button type="button" id="live" class="live-button" aria-pressed="true"><span class="dot active" aria-hidden="true"></span><span id="live-label">Live</span></button><button type="button" id="refresh">Refresh</button><button type="button" id="export" disabled>Export JSON</button></div></header>
<section class="metrics" aria-label="Retained buffer summary"><div class="metric"><span class="metric-label">Retained logs</span><span class="metric-value" id="retained">—</span><span class="metric-hint">all services</span></div><div class="metric"><span class="metric-label">Errors &amp; fatal</span><span class="metric-value error-value" id="errors">—</span><span class="metric-hint">in buffer</span></div><div class="metric"><span class="metric-label">Warnings</span><span class="metric-value warn-value" id="warnings">—</span><span class="metric-hint">in buffer</span></div><div class="metric"><span class="metric-label">Services with logs</span><span class="metric-value" id="sources">—</span><span class="metric-hint">in buffer</span></div></section>
<section class="panel" aria-label="Log explorer"><div class="panel-top"><div class="panel-title">Log explorer<small>Click an entry to inspect its context</small></div><div class="transport"><span class="dot" id="transport-dot" aria-hidden="true"></span><span id="transport">Connecting…</span></div></div>
<p class="notice" id="notice" role="status" hidden></p>
<div class="filters"><div class="field search-field"><label for="search">Search messages and context</label><input type="search" id="search" maxlength="200" placeholder="Search logs…" autocomplete="off" spellcheck="false"></div><div class="field"><label for="service">Service</label><select id="service"><option value="all">All services</option><option value="api">API</option><option value="worker">Worker</option><option value="ingestor">Ingestor</option></select></div><div class="field"><label for="level">Severity</label><select id="level"><option value="all">All levels</option><option value="trace">Trace</option><option value="debug">Debug</option><option value="info">Info</option><option value="warn">Warn</option><option value="error">Error</option><option value="fatal">Fatal</option></select></div><div class="field"><label for="range">Time range</label><select id="range"><option value="0">Retained · 24h</option><option value="15">Last 15 minutes</option><option value="60">Last hour</option><option value="360">Last 6 hours</option></select></div></div>
<div class="filter-bottom"><div class="request-field"><label for="request">Request ID</label><input id="request" placeholder="Any request" maxlength="200" autocomplete="off" spellcheck="false"></div><button type="button" class="reset" id="reset">Reset filters</button></div>
<div class="columns" aria-hidden="true"><span>Time · local</span><span>Service</span><span>Level</span><span>Message</span><span class="request-col">Request ID</span></div>
<div class="log-list" id="logs" aria-label="Log entries"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
<footer class="footer"><span id="count">Loading log entries…</span><span>Latest 250 matches · JSON export includes displayed entries</span></footer></section>
<footer class="page-foot"><span id="status" role="status">Connecting to backend…</span><span id="updated">Sensitive fields are redacted before collection</span></footer></main></div>
<dialog id="detail" class="detail" aria-labelledby="detail-title"><div class="detail-head"><h2 id="detail-title">Log details</h2><button type="button" id="close-detail" aria-label="Close log details">Close</button></div><div class="detail-body"><p id="detail-message" class="detail-message"></p><dl><dt>Timestamp</dt><dd id="detail-time" class="mono"></dd><dt>Service</dt><dd id="detail-service"></dd><dt>Severity</dt><dd id="detail-level"></dd><dt>Instance</dt><dd id="detail-instance" class="mono"></dd><dt>Request ID</dt><dd id="detail-request" class="mono"></dd></dl><p class="eyebrow">Structured context</p><pre id="detail-json"></pre><div class="detail-actions"><button type="button" id="copy">Copy JSON</button><button type="button" id="filter-request" hidden>Filter this request</button></div></div></dialog>
<dialog id="auth" class="auth" aria-labelledby="auth-title"><form id="auth-form"><h2 id="auth-title">Connect to service logs</h2><p>Enter the backend’s admin log access token. Your token stays in this tab’s memory and is cleared when you reload.</p><div class="field"><label for="token">Admin access token</label><input type="password" id="token" required autocomplete="off" spellcheck="false"></div><p class="auth-error" id="auth-error" role="alert"></p><div class="detail-actions"><button type="submit">Connect</button><button type="button" id="cancel-auth">Cancel</button></div></form></dialog>
<script>${script}</script></body></html>`;
