// render-front.cjs — Render front door + self-healing supervisor for FreeLLMAPI.
//
// Why this exists: Render's HTTP health check times out after 5 seconds.
// When the app is busy with long/heavy requests it can miss that window,
// and Render force-restarts the whole instance (the 502 windows seen on
// 2026-10-22). This tiny separate process owns the public port instead:
//   * GET /render-health is answered HERE, immediately. It never waits on
//     the app's event loop, so other traffic cannot make it late.
//   * Everything else is streamed through to the app (SSE-safe).
//
// v2 (2026-10-22 evening) — watchdog: v1 masked a HUNG app from Render
// (health checks kept passing while the app's event loop was wedged, so
// Render never restarted it; three silent wedges that day — ~16:05,
// ~16:31, ~17:02 +06 — each needed a manual dashboard restart). Now this
// process also watches the app itself: an HTTP probe every 5s, and after
// 3 consecutive failures it restarts ONLY the app process, in place.
// The container, the local SQLite file and the litestream chain all
// survive, so recovery is one app boot (~20s) instead of a full instance
// replacement + database restore (minutes of 502). A crashed app process
// is likewise respawned in place with backoff instead of taking the
// whole container down.
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const FRONT_PORT = Number(process.env.PORT || 10000);
const APP_PORT = Number(process.env.APP_PORT || 3001);
const APP_HOST = '127.0.0.1';
const HEALTH_PATH = '/render-health';

const BOOT_GRACE_MS = 45000;        // app boot takes ~20s; don't judge it before this
const PROBE_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 4000;
const PROBE_FAIL_LIMIT = 3;         // 3 strikes (~15s of silence) -> restart the app
const RESTART_MIN_GAP_MS = 60000;   // never restart more often than once a minute
const KILL_GRACE_MS = 10000;        // SIGTERM, then SIGKILL after this

// --- supervise the app -------------------------------------------------------
let child = null;
let shuttingDown = false;
let restartInProgress = false;
let bootGraceUntil = 0;
let lastRestartAt = 0;
let respawnTimer = null;
let crashBackoffMs = 2000;

function startApp() {
  restartInProgress = false;
  bootGraceUntil = Date.now() + BOOT_GRACE_MS;
  child = spawn('node', ['server/dist/index.js'], {
    env: { ...process.env, PORT: String(APP_PORT), HOST: APP_HOST },
    stdio: 'inherit',
  });
  const thisChild = child;
  const spawnedAt = Date.now();
  thisChild.on('exit', (code, signal) => {
    console.log(`[render-front] app exited (code=${code}, signal=${signal || 'none'})`);
    if (child === thisChild) child = null;
    if (shuttingDown) {
      process.exit(0);
      return;
    }
    // A child that stayed up a while earns back the fast respawn.
    if (Date.now() - spawnedAt > 120000) crashBackoffMs = 2000;
    const wasWatchdogRestart = restartInProgress;
    scheduleRespawn(wasWatchdogRestart ? 1000 : crashBackoffMs);
    if (!wasWatchdogRestart) crashBackoffMs = Math.min(crashBackoffMs * 2, 30000);
  });
}

function scheduleRespawn(delayMs) {
  if (shuttingDown || respawnTimer) return;
  bootGraceUntil = Date.now() + delayMs + BOOT_GRACE_MS;
  respawnTimer = setTimeout(() => {
    respawnTimer = null;
    if (!shuttingDown && !child) startApp();
  }, delayMs);
  respawnTimer.unref();
}

function restartApp(reason) {
  if (!child || restartInProgress || shuttingDown) return;
  restartInProgress = true;
  lastRestartAt = Date.now();
  console.log(`[render-front] watchdog: restarting app (${reason})`);
  try { child.kill('SIGTERM'); } catch {}
  const victim = child;
  setTimeout(() => {
    // If SIGTERM was ignored (wedged loop), force it.
    if (child === victim && victim) {
      try { victim.kill('SIGKILL'); } catch {}
    }
  }, KILL_GRACE_MS).unref();
}

function forwardSignal(sig) {
  shuttingDown = true;
  if (child) {
    try { child.kill(sig); } catch {}
  }
  // Safety net: never hang the platform shutdown.
  setTimeout(() => {
    if (child) {
      try { child.kill('SIGKILL'); } catch {}
    }
    process.exit(0);
  }, 25000).unref();
}
process.on('SIGTERM', () => forwardSignal('SIGTERM'));
process.on('SIGINT', () => forwardSignal('SIGINT'));

// --- watchdog: is the app's event loop actually answering? --------------------
let probeFailures = 0;
function probeApp() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    const req = http.get({ host: APP_HOST, port: APP_PORT, path: '/api/ping', timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      done(true); // any HTTP response means the event loop is alive
    });
    req.on('timeout', () => {
      try { req.destroy(); } catch {}
      done(false);
    });
    req.on('error', () => done(false));
  });
}
setInterval(async () => {
  if (shuttingDown || restartInProgress || !child) return;
  if (Date.now() < bootGraceUntil) return;
  const ok = await probeApp();
  if (ok) {
    probeFailures = 0;
    return;
  }
  probeFailures += 1;
  console.log(`[render-front] watchdog: app probe failed (${probeFailures}/${PROBE_FAIL_LIMIT})`);
  if (probeFailures >= PROBE_FAIL_LIMIT && Date.now() - lastRestartAt >= RESTART_MIN_GAP_MS) {
    probeFailures = 0;
    restartApp('app unresponsive');
  }
}, PROBE_INTERVAL_MS).unref();

// --- health check (for Render) -------------------------------------------------
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
    appReachable().then((tcpOk) => {
      // While the watchdog is recovering the app (or it is still booting),
      // report healthy: the front door is up and a restart is already in
      // hand — a container restart by Render would only make it slower.
      const recovering = restartInProgress || Date.now() < bootGraceUntil || !child;
      const ok = tcpOk || recovering;
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

startApp();
server.listen(FRONT_PORT, () => {
  console.log(`[render-front] listening on ${FRONT_PORT}; app on ${APP_HOST}:${APP_PORT}; health at ${HEALTH_PATH}; watchdog on (probe ${PROBE_INTERVAL_MS}ms, ${PROBE_FAIL_LIMIT} strikes)`);
});
