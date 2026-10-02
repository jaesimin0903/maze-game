#!/usr/bin/env node
// The harmless page the capability probe (00-capability-probe.sh) drives, plus the record of
// what that page did. It listens on the loopback interface only and serves nothing but itself.
//
//   node probe-server.mjs <port>
//
//   GET  /            the probe page (see PAGE below)
//   GET  /second      a second page, for the two-tab check
//   POST /hit?what=…  the page reports an event it really received (click, input, key, select),
//                     and every 300 ms that it is still open (alive)
//   GET  /hits        everything recorded so far: { requests: [...], hits: [...] }
//
// A capability counts as verified only when the *server* saw its effect, so an automation call
// that returns without doing anything is not mistaken for a working one.

import { createServer } from 'node:http';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  console.error('usage: probe-server.mjs <port>');
  process.exit(2);
}

/** Page loads, in order: { path, at }. */
const requests = [];
/** Events the page reported: { what, value, tab, at }. */
const hits = [];

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>maze aside probe</title>
</head>
<body>
<h1 data-testid="probe-title" data-kind="title">maze aside probe</h1>
<p data-testid="probe-known" data-wei="950000000000000000">known text 0.95</p>
<button type="button" data-testid="probe-click" data-clicked="0">click me</button>
<button type="button" data-testid="probe-disabled" disabled>disabled</button>
<input data-testid="probe-input" name="probe-input" value="initial" autocomplete="off">
<span data-testid="probe-echo" data-value="initial" data-events="">initial</span>
<select data-testid="probe-select"><option value="2">two</option><option value="3">three</option></select>
<span data-testid="probe-key" data-code="" data-count="0"></span>
<div id="late-slot"></div>
<span data-testid="probe-tab" data-tab=""></span>
<script>
  // Every page load is its own "tab" in the record, so two tabs can be told apart.
  const tab = Math.random().toString(36).slice(2, 10);
  document.querySelector('[data-testid="probe-tab"]').dataset.tab = tab;
  const report = (what, value) =>
    fetch(
      '/hit?what=' + encodeURIComponent(what) + '&value=' + encodeURIComponent(value ?? '') + '&tab=' + tab,
      { method: 'POST' },
    ).catch(() => {});
  // A tab that is still open keeps saying so; a closed one falls silent.
  setInterval(() => report('alive', ''), 300);

  const button = document.querySelector('[data-testid="probe-click"]');
  button.addEventListener('click', (event) => {
    button.dataset.clicked = String(Number(button.dataset.clicked) + 1);
    report('click', event.isTrusted ? 'trusted' : 'synthetic');
  });
  document.querySelector('[data-testid="probe-disabled"]').addEventListener('click', () => report('disabled-click', ''));

  // The same contract as the app's DomInput: native input/change listeners, DOM value is the truth.
  const input = document.querySelector('[data-testid="probe-input"]');
  const echo = document.querySelector('[data-testid="probe-echo"]');
  for (const type of ['input', 'change']) {
    input.addEventListener(type, () => {
      echo.textContent = input.value;
      echo.dataset.value = input.value;
      echo.dataset.events = (echo.dataset.events + ' ' + type).trim();
      report(type, input.value);
    });
  }

  const select = document.querySelector('[data-testid="probe-select"]');
  select.addEventListener('change', () => report('select', select.value));

  // The same contract as the app's MovePad: window keydown, physical key codes, not while typing.
  const key = document.querySelector('[data-testid="probe-key"]');
  window.addEventListener('keydown', (event) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
    key.dataset.code = event.code;
    key.dataset.count = String(Number(key.dataset.count) + 1);
    report('key', event.code);
  });

  // Appears late, for the wait-for-selector check.
  setTimeout(() => {
    const late = document.createElement('span');
    late.dataset.testid = 'probe-late';
    late.textContent = 'late';
    document.getElementById('late-slot').append(late);
  }, 700);
</script>
</body>
</html>
`;

const SECOND = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>maze aside probe second</title></head>
<body><h1 data-testid="second-title">second tab</h1></body></html>
`;

// "connection: close": a browser must not keep a connection to this process and reuse it for a
// later run's page, which another process serves on the same port.
const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', connection: 'close' });
  res.end(body);
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const at = Date.now();
  if (req.method === 'GET' && url.pathname === '/') {
    requests.push({ path: '/', at });
    return send(res, 200, 'text/html; charset=utf-8', PAGE);
  }
  if (req.method === 'GET' && url.pathname === '/second') {
    requests.push({ path: '/second', at });
    return send(res, 200, 'text/html; charset=utf-8', SECOND);
  }
  if (req.method === 'POST' && url.pathname === '/hit') {
    hits.push({
      what: url.searchParams.get('what') ?? '',
      value: url.searchParams.get('value') ?? '',
      tab: url.searchParams.get('tab') ?? '',
      at,
    });
    req.resume();
    return send(res, 204, 'text/plain', '');
  }
  if (req.method === 'GET' && url.pathname === '/hits') {
    return send(res, 200, 'application/json', JSON.stringify({ requests, hits }));
  }
  return send(res, 404, 'text/plain', 'not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`probe-server: listening on http://127.0.0.1:${port} (pid ${process.pid})`);
});
// Exit at once: server.close() alone would wait for the browser's open connections.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.closeAllConnections();
    process.exit(0);
  });
}
