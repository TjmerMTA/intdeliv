import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import worker from '../worker/src/index.js';
import { Engine } from '../worker/src/engine.js';
import { FakeD1 } from './helpers/fake-d1.mjs';

const SCHEMA = fileURLToPath(new URL('../worker/schema.sql', import.meta.url));
const HTML = readFileSync(fileURLToPath(new URL('./fixtures/della-search.html', import.meta.url)), 'utf8');
const T0 = Date.parse('2026-09-22T07:00:00Z'); // 10:00 за Києвом
const KEY = 'secret-admin-key';
const ORIGIN = 'https://intdeliv.siteboosty.com';

/** Середовище: D1 у пам'яті, фейкові годинник/sleep/fetch (Della + Lardi). */
function setup() {
  const clock = { t: T0 };
  const calls = { della: [], lardi: [] };
  let nextId = 1000;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === 'della.com.ua') {
      calls.della.push({ url, headers: init.headers });
      return new Response(HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (u.hostname === 'api.lardi-trans.com') {
      const method = init.method || 'GET';
      const path = u.pathname.replace('/v2', '');
      calls.lardi.push({ method, path, token: init.headers && init.headers.Authorization, body: init.body ? JSON.parse(init.body) : undefined });
      const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
      if (!init.headers || !String(init.headers.Authorization || '').startsWith('tok')) return new Response('{"message":"Unauthorized"}', { status: 401 });
      if (path === '/references/towns/by/name') {
        const q = u.searchParams.get('query');
        return ok([{ id: q.length * 7, name: q, areaId: 1, countrySign: 'UA' }]);
      }
      if (path === '/references/body/types') return ok([{ id: 34, name: 'Тент' }, { id: 25, name: 'Ізотерм' }, { id: 27, name: 'Контейнер' }]);
      if (path === '/references/payment/units') return ok([{ id: 1, name: 'за рейс' }]);
      if (path === '/references/areas') return ok([]);
      if (path === '/proposals/my/add/cargo' && method === 'POST') return ok({ id: nextId++ });
      if (path === '/proposals/my/basket/throw') return ok({ result: 'OK' });
      if (path === '/proposals/my/cargoes/published') return ok({ content: [], paginator: { totalSize: 3 } });
      return new Response('{"message":"not found"}', { status: 404 });
    }
    throw new Error('unexpected fetch ' + url);
  };
  const env = {
    DB: new FakeD1(SCHEMA),
    ADMIN_KEY: KEY,
    __engineOpts: { fetch, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } },
  };
  const engine = () => new Engine(env, env.__engineOpts);
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const rpc = async (method, params, { key = KEY, origin = ORIGIN } = {}) => {
    const headers = { 'Content-Type': 'application/json', Origin: origin };
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await worker.fetch(new Request('https://intdeliv.example.workers.dev/api/rpc', {
      method: 'POST', headers, body: JSON.stringify({ method, params }),
    }), env, ctx);
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const lardiWrites = () => calls.lardi.filter((c) => c.method !== 'GET');
  return { clock, calls, env, engine, rpc, ctx, pending, lardiWrites };
}

async function setSettings(h, patch) {
  const r = await h.rpc('settings.set', patch);
  assert.equal(r.body.ok, true, r.body.error);
  return r.body.result;
}

test('GET / and ping without auth', async () => {
  const h = setup();
  const res = await worker.fetch(new Request('https://x.dev/'), h.env, h.ctx);
  assert.deepEqual(await res.json(), { name: 'intdeliv', ok: true });
  const p = await h.rpc('ping', {}, { key: null });
  assert.equal(p.status, 200);
  assert.equal(p.body.result.authed, false);
  assert.ok(p.body.result.version);
  const p2 = await h.rpc('ping', {}, { key: 'wrong' });
  assert.equal(p2.body.result.authed, false);
  const p3 = await h.rpc('ping');
  assert.equal(p3.body.result.authed, true);
});

test('auth: 401 without or with wrong key', async () => {
  const h = setup();
  for (const key of [null, 'nope']) {
    const r = await h.rpc('status.get', {}, { key });
    assert.equal(r.status, 401);
    assert.equal(r.body.ok, false);
  }
  const noKeyEnv = await worker.fetch(new Request('https://x.dev/api/rpc', {
    method: 'POST', headers: { Authorization: 'Bearer ' }, body: JSON.stringify({ method: 'loads.list' }),
  }), { ...h.env, ADMIN_KEY: '' }, h.ctx);
  assert.equal(noKeyEnv.status, 401, 'no ADMIN_KEY configured → everything locked');
  const ok = await h.rpc('status.get');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.result.dryRun, true, 'dryRun default true');
});

test('CORS: preflight reflects allowed origins only', async () => {
  const h = setup();
  const pre = (origin) => worker.fetch(new Request('https://x.dev/api/rpc', {
    method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
  }), h.env, h.ctx);
  for (const o of ['https://intdeliv.siteboosty.com', 'https://tjmermta.github.io', 'http://localhost:5173', 'http://127.0.0.1:8080', 'http://localhost']) {
    const r = await pre(o);
    assert.equal(r.status, 204, o);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), o);
    assert.match(r.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  }
  const bad = await pre('https://evil.example.com');
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
  const r = await h.rpc('ping', {}, { origin: 'http://localhost:3000' });
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'http://localhost:3000');
});

test('poll → loads stored (parallel pages, browser headers, dedupe), dryRun makes no Lardi writes', async () => {
  const h = setup();
  await setSettings(h, { lardi: { accounts: [{ name: 'A', token: 'tokAAAA1111', enabled: true }, { name: 'B', token: 'tokBBBB2222', enabled: true }] } });
  const out = await h.engine().runCycle();
  assert.equal(h.calls.della.length, 3, 'pagesPerPoll=3 pages fetched');
  assert.match(h.calls.della[0].headers['User-Agent'], /Mozilla\/5\.0/);
  assert.match(h.calls.della[0].headers['Accept-Language'], /^uk/);
  assert.ok(h.calls.della.some((c) => /r25l25\.html$/.test(c.url)));
  assert.equal(out.poll.seen, 25, 'same page served 4× → deduped by id');
  assert.equal(out.poll.inserted, 16, 'price ≥ 8000 and direct customer');
  const list = await h.rpc('loads.list', {});
  assert.equal(list.body.result.total, 16);
  assert.ok(list.body.result.items.every((l) => l.price >= 8000));
  // dry run: відпрацювало, але жодного запису на Lardi
  assert.ok(out.published > 0, 'dry-run steps executed');
  assert.equal(h.lardiWrites().length, 0, 'no POST/PUT to Lardi in dry run');
  const dry = list.body.result.items.filter((l) => (l.lardi || []).some((e) => e.status === 'dry'));
  assert.ok(dry.length > 0);
  const st = (await h.rpc('status.get')).body.result;
  assert.equal(st.today.collected, 16);
  assert.ok(st.today.dry[0] > 0 && st.today.dry[1] > 0);
  assert.ok(st.lastPollAt);
  // повторний збір: seenAt оновлено, нових немає, правка не перезаписується, видалена не воскресає
  const [a, b] = list.body.result.items;
  await h.rpc('loads.update', { id: a.id, patch: { price: 99999 } });
  await h.rpc('loads.delete', { id: b.id });
  h.clock.t += 120e3;
  const out2 = await h.engine().runCycle();
  assert.equal(out2.poll.inserted, 0);
  const a2 = (await h.rpc('loads.list', { q: a.id })).body.result.items[0];
  assert.equal(a2.price, 99999);
  assert.equal(a2.edited, true);
  assert.ok(a2.seenAt > a.seenAt, 'seenAt updated');
  const all = (await h.rpc('loads.list', { status: 'deleted' })).body.result.items;
  assert.equal(all.length, 1);
  assert.equal(all[0].id, b.id);
  assert.equal(h.lardiWrites().length, 0);
});

test('lock prevents overlapping runs; poll respects pollSeconds', async () => {
  const h = setup();
  const e = h.engine();
  assert.equal(await e.store.acquireLock('other', 55000), true);
  assert.deepEqual(await e.runCycle(), { skipped: 'locked' });
  h.clock.t += 56000; // замок протух
  const r = await e.runCycle();
  assert.ok(r.poll);
  h.clock.t += 30000; // 30 с < 60 с
  const r2 = await e.runCycle();
  assert.equal(r2.poll, undefined);
  h.clock.t += 30000;
  assert.ok((await e.runCycle()).poll);
});

test('publish (dryRun off) in "both" mode to 2 accounts, interval spacing within 25 s budget', async () => {
  const h = setup();
  await setSettings(h, {
    lardi: {
      dryRun: false, mode: 'both', intervalSeconds: 5,
      accounts: [{ name: 'A', token: 'tokAAAA1111', enabled: true }, { name: 'B', token: 'tokBBBB2222', enabled: true }],
    },
  });
  const start = h.clock.t;
  const out = await h.engine().runCycle();
  assert.equal(out.poll.inserted, 16);
  const posts = h.calls.lardi.filter((c) => c.method === 'POST' && c.path === '/proposals/my/add/cargo');
  assert.ok(posts.length >= 4, `posts ${posts.length}`);
  assert.ok(h.clock.t - start <= 26000, 'run stays within budget');
  const byTok = (t) => posts.filter((p) => p.token === t).length;
  assert.equal(byTok('tokAAAA1111'), byTok('tokBBBB2222'), 'both accounts get each load');
  assert.equal(posts.length, 12, '6 rounds (0,5..25 s) × 2 accounts');
  const items = (await h.rpc('loads.list', { status: 'published' })).body.result.items;
  assert.equal(items.length, posts.length / 2);
  for (const l of items) {
    assert.deepEqual(l.lardi.map((e) => e.account), [0, 1]);
    assert.ok(l.lardi.every((e) => e.status === 'published' && e.id));
  }
  assert.equal(posts[0].body.waypointListSource[0].countrySign, 'UA');
  const st = (await h.rpc('status.get')).body.result;
  assert.deepEqual(st.today.published, [6, 6]);
  // зняття з Lardi
  const r = await h.rpc('loads.unpublish', { id: items[0].id });
  assert.equal(r.body.result.status, 'inactive');
  const thr = h.calls.lardi.filter((c) => c.path === '/proposals/my/basket/throw');
  assert.equal(thr.length, 2);
});

test('dailyLimit per account is respected', async () => {
  const h = setup();
  await setSettings(h, {
    lardi: { dryRun: false, intervalSeconds: 5, dailyLimit: 2, accounts: [{ token: 'tokAAAA1111', enabled: true }, { token: 'tokBBBB2222', enabled: true }] },
  });
  await h.engine().runCycle();
  const posts = h.calls.lardi.filter((c) => c.path === '/proposals/my/add/cargo');
  assert.equal(posts.length, 4);
});

test('loads.list filters in SQL with Cyrillic case-insensitivity', async () => {
  const h = setup();
  await h.engine().runCycle();
  const q = async (p) => (await h.rpc('loads.list', p)).body.result;
  const dn = await q({ fromCity: 'ДНІПРО' });
  assert.ok(dn.total >= 3);
  assert.ok(dn.items.every((l) => l.fromCity === 'Дніпро'));
  assert.equal((await q({ fromCity: 'дніпро' })).total, dn.total);
  const kyivObl = await q({ fromRegion: 'КИЇВСЬКА' });
  assert.ok(kyivObl.total > 0 && kyivObl.items.every((l) => l.fromRegion === 'Київська обл.'));
  const toKyiv = await q({ toCity: 'КиЇв' });
  assert.ok(toKyiv.items.length > 0 && toKyiv.items.every((l) => l.toCity === 'Київ'));
  assert.equal((await q({ toRegion: 'ЗАКАРПАТСЬК' })).items.every((l) => /Закарпатськ/.test(l.toRegion)), true);
  assert.equal((await q({ q: 'УЖГОРОД' })).total, 1);
  assert.equal((await q({ fromCity: '%' })).total, 0, 'LIKE wildcards escaped');
  const page = await q({ limit: 5, offset: 5 });
  assert.equal(page.items.length, 5);
  assert.equal(page.total, 16);
});

test('settings: tokens masked, masked token keeps stored value', async () => {
  const h = setup();
  const s = await setSettings(h, { lardi: { accounts: [{ name: 'A', token: 'tokAAAA1111', enabled: true }, { name: 'B', token: 'tokBBBB2222', enabled: true }] } });
  assert.equal(s.lardi.accounts[0].token, '••••1111');
  const got = (await h.rpc('settings.get')).body.result;
  assert.deepEqual(got.lardi.accounts.map((a) => a.token), ['••••1111', '••••2222']);
  assert.equal(got.lardi.dryRun, true);
  await setSettings(h, { lardi: { accounts: [{ name: 'A2', token: '••••1111', enabled: true }, { name: 'B', token: 'tokNEW9999', enabled: false }] } });
  const raw = await h.engine().getSettings();
  assert.equal(raw.lardi.accounts[0].token, 'tokAAAA1111');
  assert.equal(raw.lardi.accounts[0].name, 'A2');
  assert.equal(raw.lardi.accounts[1].token, 'tokNEW9999');
  const t = (await h.rpc('lardi.test', { accountIndex: 0 })).body.result;
  assert.equal(t.ok, true);
  const logs = (await h.rpc('log.list', { limit: 10 })).body.result;
  assert.ok(logs.some((l) => /Перевірка токена/.test(l.msg)));
});

test('sync.now schedules a poll via waitUntil; unknown method → ok:false', async () => {
  const h = setup();
  const r = await h.rpc('sync.now');
  assert.deepEqual(r.body.result, { started: true });
  assert.equal(h.pending.length, 1);
  await Promise.all(h.pending);
  assert.equal((await h.rpc('status.get')).body.result.counts.new + (await h.rpc('status.get')).body.result.counts.queued, 16);
  const bad = await h.rpc('nope.nope');
  assert.equal(bad.body.ok, false);
});
