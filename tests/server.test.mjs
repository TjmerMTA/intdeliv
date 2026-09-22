import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/run.mjs';
import { D1Database } from '../server/d1-sqlite.mjs';

const HTML = readFileSync(fileURLToPath(new URL('./fixtures/della-search.html', import.meta.url)), 'utf8');
const ORIGIN = 'https://intdeliv.siteboosty.com';
const TOKEN = 'tok-secret-123456';

function fakeFetch(calls) {
  return async (url) => {
    const u = new URL(url);
    calls.push(u.hostname);
    if (u.hostname === 'della.com.ua') return new Response(HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
    return new Response('{"message":"not found"}', { status: 404 });
  };
}

async function boot(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'intdeliv-srv-'));
  const lines = [];
  const calls = [];
  const srv = await startServer({
    env: { DB_PATH: join(dir, 'db.sqlite'), ADMIN_KEY: 'test', PORT: '0', RUN_MINUTES: '5', ...extra },
    fetchImpl: fakeFetch(calls),
    log: (m) => lines.push(m),
    tickMs: 3600e3,
  });
  const rpc = async (method, params = {}, key = 'test') => {
    const res = await fetch(srv.url + '/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(key ? { Authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify({ method, params }),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { srv, rpc, lines, calls, dir };
}

test('server: ping, auth, CORS, loads.list, scheduled tick with fake Della', async () => {
  const { srv, rpc, lines, calls, dir } = await boot();
  try {
    const root = await fetch(srv.url + '/');
    assert.deepEqual(await root.json(), { name: 'intdeliv', ok: true });

    const p = await rpc('ping', {}, null);
    assert.equal(p.status, 200);
    assert.equal(p.body.result.authed, false);
    assert.equal(p.headers.get('access-control-allow-origin'), ORIGIN);

    const pre = await fetch(srv.url + '/api/rpc', { method: 'OPTIONS', headers: { Origin: ORIGIN } });
    assert.equal(pre.status, 204);

    const bad = await rpc('loads.list', {}, 'wrong');
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, 'unauthorized');

    await srv.tick(); // перший тік уже стоїть у черзі від старту — цей виконається після нього
    assert.ok(srv.ticks >= 1);
    assert.ok(calls.includes('della.com.ua'));

    const list = await rpc('loads.list', { status: 'all', limit: 1000 });
    assert.equal(list.status, 200);
    assert.equal(list.body.ok, true);
    assert.ok(list.body.result.total > 0, 'заявки з фікстури зібрано');

    const st = await rpc('status.get');
    assert.equal(st.body.result.dryRun, true);
    assert.ok(st.body.result.lastPollOkAt);
    assert.ok(lines.some((l) => /^tick \d+ \d+ms$/.test(l)));

    const total = list.body.result.total;
    await srv.stop('test');
    assert.ok(existsSync(srv.snapPath), 'знімок БД записано');
    // дані на диску переживають перезапуск
    const again = new D1Database(srv.dbPath);
    const row = await again.prepare("SELECT COUNT(*) AS n FROM loads WHERE status <> 'deleted'").first();
    assert.equal(row.n, total);
    const snap = new D1Database(srv.snapPath, { wal: false });
    assert.equal((await snap.prepare("SELECT COUNT(*) AS n FROM loads WHERE status <> 'deleted'").first()).n, total);
    again.close(); snap.close();
  } finally {
    await srv.stop('cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server: LARDI_TOKEN_* injected into empty settings, never logged', async () => {
  const { srv, rpc, lines, dir } = await boot({ LARDI_TOKEN_1: TOKEN });
  try {
    const s = await rpc('settings.get');
    const accs = s.body.result.lardi.accounts;
    assert.match(accs[0].token, /3456$/);
    assert.notEqual(accs[0].token, TOKEN);
    assert.equal(accs[1].token, '');
    assert.ok(lines.some((l) => l.includes('account 1')));
    assert.ok(!lines.join('\n').includes(TOKEN));
    // вже збережений токен не перезаписується
    await rpc('settings.set', { lardi: { accounts: [{ name: 'A', token: 'tok-own-999999' }, {}] } });
  } finally {
    await srv.stop('test');
  }
  const { srv: srv2, rpc: rpc2 } = await (async () => {
    const lines2 = [];
    const s2 = await startServer({
      env: { DB_PATH: join(dir, 'db.sqlite'), ADMIN_KEY: 'test', PORT: '0', LARDI_TOKEN_1: TOKEN },
      fetchImpl: fakeFetch([]), log: (m) => lines2.push(m), tickMs: 3600e3,
    });
    return { srv: s2, rpc: (m, p) => fetch(s2.url + '/api/rpc', { method: 'POST', headers: { Authorization: 'Bearer test' }, body: JSON.stringify({ method: m, params: p }) }).then((r) => r.json()) };
  })();
  try {
    const s = await rpc2('settings.get', {});
    assert.match(s.result.lardi.accounts[0].token, /9999$/);
  } finally {
    await srv2.stop('test');
    rmSync(dir, { recursive: true, force: true });
  }
});
