// render-front.cjs — Render front door for FreeLLMAPI.
//
// Why this exists: Render's HTTP health check times out after 5 seconds.
// When the app is busy with long/heavy requests it can miss that window,
// and Render force-restarts the whole instance (the 502 windows seen on
// 2026-10-22). This tiny separate process owns the public port instead:
//   * GET /render-health is answered HERE, immediately: 200 while the app
//     accepts TCP connections on its internal port, 503 otherwise. It
//     never waits on the app's event loop, so other traffic cannot make
//     it late.
//   * Everything else is streamed through to the app (SSE-safe).
// It also supervises the app process: signals are forwarded to the app,
// and if the app exits, this process exits too, so the platform and the
// litestream chain restart cleanly.
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const FRONT_PORT = Number(process.env.PORT || 10000);
const APP_PORT = Number(process.env.APP_PORT || 3001);
const APP_HOST = '127.0.0.1';
const HEALTH_PATH = '/render-health';

// --- supervise the app -----------------------------------------------------
const child = spawn('node', ['server/dist/index.js'], {
  env: { ...process.env, PORT: String(APP_PORT), HOST: APP_HOST },
  stdio: 'inherit',
});
let shuttingDown = false;
function forwardSignal(sig) {
  shuttingDown = true;
  try { child.kill(sig); } catch {}
  // Safety net: never hang the platform shutdown.
  setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
    process.exit(0);
  }, 25000).unref();
}
process.on('SIGTERM', () => forwardSignal('SIGTERM'));
process.on('SIGINT', () => forwardSignal('SIGINT'));
child.on('exit', (code, signal) => {
  console.log(`[render-front] app exited (code=${code}, signal=${signal || 'none'})`);
  process.exit(shuttingDown ? 0 : (typeof code === 'number' ? code : 1));
});

// --- health check ------------------------------------------------------------
let lastCheck = { at: 0, ok: false };
function appReachable() {
  const now = Date.now();
  if (now - lastCheck.at < 1000) return Promise.resolve(lastCheck.ok);
  return new Promise((resolve) => {
    const sock = net.connect(APP_PORT, APP_HOST);
    const done = (ok) => {
      try { sock.destroy(); } catch {}
      lastCheck = { at: Date.now(), ok };
      resolve(ok);
    };
    sock.setTimeout(800);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// --- proxy ---------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === HEALTH_PATH || req.url.startsWith(HEALTH_PATH + '?')) {
    appReachable().then((ok) => {
      res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end(ok ? 'ok' : 'app not ready');
    });
    return;
  }
  const headers = { ...req.headers };
  const clientIp = req.socket.remoteAddress || '';
  headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${clientIp}` : clientIp;
  headers['x-forwarded-proto'] = 'https';
  const upstream = http.request(
    { host: APP_HOST, port: APP_PORT, method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    try { res.end(JSON.stringify({ error: { message: 'app unavailable', type: 'proxy_error' } })); } catch {}
  });
  // Preserve disconnect semantics: if the caller goes away, the app must
  // see its client disconnect so it cancels the upstream provider call.
  res.on('close', () => { try { upstream.destroy(); } catch {} });
  req.pipe(upstream);
});
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(APP_PORT, APP_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => { try { socket.destroy(); } catch {} });
  socket.on('error', () => { try { upstream.destroy(); } catch {} });
});
server.timeout = 0;
server.keepAliveTimeout = 75000;
server.listen(FRONT_PORT, () => {
  console.log(`[render-front] listening on ${FRONT_PORT}; app on ${APP_HOST}:${APP_PORT}; health at ${HEALTH_PATH}`);
});
