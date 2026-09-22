// IntDeliv — запуск рушія Worker'а у звичайному Node 24 (GitHub Actions / будь-який сервер).
// HTTP → worker.fetch(), кожні 60 с → worker.scheduled(), БД — SQLite-файл через D1-адаптер.
//
// ENV: DB_PATH (./data/intdeliv.sqlite), PORT (8787), ADMIN_KEY, RUN_MINUTES (345),
//      SNAPSHOT_MINUTES (5), LARDI_TOKEN_1 / LARDI_TOKEN_2 (необовʼязково).
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import worker, { makeEngine } from '../worker/src/index.js';
import { D1Database } from './d1-sqlite.mjs';

const SCHEMA = fileURLToPath(new URL('../worker/schema.sql', import.meta.url));
const MAX_BODY = 1 << 20;

const defaultLog = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

/** Токени Lardi з env → у налаштування, якщо для акаунта токена ще немає. Значення не логуються. */
async function injectTokens(env, cfg, log) {
  const tokens = [cfg.LARDI_TOKEN_1, cfg.LARDI_TOKEN_2].map((t) => String(t || '').trim());
  if (!tokens.some(Boolean)) return;
  const engine = makeEngine(env, null);
  const s = await engine.getSettings();
  let changed = false;
  tokens.forEach((tok, i) => {
    if (!tok) return;
    const acc = s.lardi.accounts[i] || { name: `Акаунт ${i + 1}`, token: '', enabled: true };
    if (acc.token) return;
    s.lardi.accounts[i] = { ...acc, token: tok };
    changed = true;
    log(`lardi: token for account ${i + 1} taken from env`);
  });
  if (changed) await engine.store.setKV('settings', s);
}

function toRequest(req, port) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else headers.set(k, v);
  }
  const host = req.headers.host || `localhost:${port}`;
  const url = `http://${host}${req.url || '/'}`;
  const init = { method: req.method, headers };
  return { url, init };
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

/**
 * Старт сервера. Повертає керування: {port, url, db, tick(), stop(), done}.
 * @param {{env?: object, fetchImpl?: Function, log?: Function, tickMs?: number}} o
 *   env — конфіг у форматі process.env; fetchImpl — fetch для рушія (Della/Lardi), для тестів.
 */
export async function startServer({ env: cfg = process.env, fetchImpl, log = defaultLog, tickMs = 60e3 } = {}) {
  const dbPath = resolve(cfg.DB_PATH || './data/intdeliv.sqlite');
  const port = cfg.PORT !== undefined && cfg.PORT !== '' ? Number(cfg.PORT) : 8787;
  const runMinutes = Number(cfg.RUN_MINUTES) > 0 ? Number(cfg.RUN_MINUTES) : 345;
  const snapMs = (Number(cfg.SNAPSHOT_MINUTES) > 0 ? Number(cfg.SNAPSHOT_MINUTES) : 5) * 60e3;
  const snapPath = dbPath + '.snap';

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new D1Database(dbPath, { schemaPath: SCHEMA });
  const env = { DB: db, ADMIN_KEY: cfg.ADMIN_KEY || '' };
  if (fetchImpl) env.__engineOpts = { fetch: fetchImpl };
  if (!env.ADMIN_KEY) log('warn: ADMIN_KEY is not set — admin RPC will answer 401');
  await injectTokens(env, cfg, log);

  const inflight = new Set();
  const track = (p) => {
    const safe = Promise.resolve(p).catch((e) => log(`error: ${(e && e.message) || e}`));
    inflight.add(safe);
    safe.finally(() => inflight.delete(safe));
    return safe;
  };
  const makeCtx = () => {
    const list = [];
    return { list, waitUntil: (p) => { list.push(track(p)); }, passThroughOnException() {} };
  };

  // ---------- HTTP ----------
  const server = http.createServer((req, res) => {
    track((async () => {
      try {
        const { url, init } = toRequest(req, port);
        if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await readBody(req);
        const response = await worker.fetch(new Request(url, init), env, makeCtx());
        const body = req.method === 'HEAD' ? null : Buffer.from(await response.arrayBuffer());
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(body);
      } catch (e) {
        if (!res.headersSent) res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.status === 413 ? 'too large' : 'internal error' }));
        if (!e.status) log(`http error: ${e.message}`);
      }
    })());
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, ok); });
  const actualPort = server.address().port;
  log(`listening on :${actualPort}, db ${dbPath}, stop in ${runMinutes} min`);

  // ---------- cron ----------
  let lastSnap = 0;
  const snapshot = () => {
    try { db.snapshot(snapPath); lastSnap = Date.now(); } catch (e) { log(`snapshot failed: ${e.message}`); }
  };
  let ticks = 0;
  let chain = Promise.resolve();
  const runTick = async () => {
    const t0 = Date.now();
    const ctx = makeCtx();
    try {
      await worker.scheduled({ cron: '* * * * *', scheduledTime: t0 }, env, ctx);
      await Promise.allSettled(ctx.list);
      ticks++;
      log(`tick ${ticks} ${Date.now() - t0}ms`);
    } catch (e) {
      log(`tick failed: ${e.message}`);
    }
    if (Date.now() - lastSnap >= snapMs) snapshot();
  };
  const tick = () => (chain = chain.then(runTick));

  let stopping = false;
  let wake = () => {};
  const loop = (async () => {
    while (!stopping) {
      const t0 = Date.now();
      await tick();
      const wait = Math.max(0, t0 + tickMs - Date.now());
      if (stopping) break;
      await new Promise((ok) => { const t = setTimeout(ok, wait); wake = () => { clearTimeout(t); ok(); }; });
    }
  })();

  let resolveDone;
  const done = new Promise((ok) => { resolveDone = ok; });
  const deadline = setTimeout(() => stop('run time is over'), runMinutes * 60e3);
  deadline.unref?.();

  let stopPromise = null;
  function stop(reason = 'stop') {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      log(`stopping: ${reason}`);
      stopping = true;
      clearTimeout(deadline);
      wake();
      const closed = new Promise((ok) => server.close(() => ok()));
      server.closeIdleConnections();
      await loop;
      await chain;
      // незавершені запити й фонові задачі (waitUntil) — чекаємо до 60 с
      let timer;
      await Promise.race([Promise.allSettled([...inflight]), new Promise((ok) => { timer = setTimeout(ok, 60e3); })]);
      clearTimeout(timer);
      server.closeAllConnections();
      await closed;
      try { db.checkpoint(); } catch (e) { log(`checkpoint failed: ${e.message}`); }
      snapshot();
      db.close();
      log(`stopped after ${ticks} ticks`);
      resolveDone();
    })();
    return stopPromise;
  }

  return { port: actualPort, url: `http://127.0.0.1:${actualPort}`, db, dbPath, snapPath, tick, stop, done, get ticks() { return ticks; } };
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const srv = await startServer();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => srv.stop(sig));
  await srv.done;
  process.exit(0);
}
