// Спільне середовище для тестів рушія: D1 у пам'яті, фейкові годинник/sleep/fetch (Della + Lardi), RPC через worker.fetch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import worker from '../../worker/src/index.js';
import { Engine } from '../../worker/src/engine.js';
import { FakeD1 } from './fake-d1.mjs';

export const SCHEMA = fileURLToPath(new URL('../../worker/schema.sql', import.meta.url));
export const HTML = readFileSync(fileURLToPath(new URL('../fixtures/della-search.html', import.meta.url)), 'utf8');
export const T0 = Date.parse('2026-09-22T07:00:00Z'); // 10:00 за Києвом
export const KEY = 'secret-admin-key';
export const TOK_A = 'tokAAAA1111';
export const TOK_B = 'tokBBBB2222';
export const TOK_C = 'tokCCCC3333';

/**
 * Картки фікстури з компанією, як у залогіненій сесії Della (data-company-code / data-company-name).
 * pick(i) → {code, name} | null для i-ї картки.
 */
export function withCompanies(html, pick) {
  let i = -1;
  return html.replace(/<div class="request_card(?:\s[^"]*)?"\s+data-request_id="[^"]*"/g, (m) => {
    i++;
    const c = pick(i);
    return c ? `${m} data-company-code="${c.code}" data-company-name="${c.name}"` : m;
  });
}

/**
 * Токени Lardi: 'tok…' — дійсні, будь-які інші — 401. h.lardiDown = true — basket/throw відповідає 503.
 */
export function setup({ html = HTML, env: extraEnv = {} } = {}) {
  const clock = { t: T0 };
  const calls = { della: [], lardi: [] };
  const h = { clock, calls, html, lardiDown: false };
  let nextId = 1000;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === 'della.com.ua') {
      calls.della.push({ url, headers: init.headers });
      return new Response(h.html, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (u.hostname === 'api.lardi-trans.com') {
      const method = init.method || 'GET';
      const path = u.pathname.replace('/v2', '');
      const token = init.headers && init.headers.Authorization;
      calls.lardi.push({ method, path, token, body: init.body ? JSON.parse(init.body) : undefined });
      const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
      if (!String(token || '').startsWith('tok')) return new Response('{"message":"Unauthorized"}', { status: 401 });
      if (path === '/references/towns/by/name') {
        const q = u.searchParams.get('query');
        return ok([{ id: q.length * 7, name: q, areaId: 1, countrySign: 'UA' }]);
      }
      if (path === '/references/body/types') return ok([{ id: 34, name: 'Тент' }, { id: 25, name: 'Ізотерм' }, { id: 27, name: 'Контейнер' }]);
      if (path === '/references/payment/units') return ok([{ id: 1, name: 'за рейс' }]);
      if (path === '/references/areas') return ok([]);
      if (path === '/proposals/my/add/cargo' && method === 'POST') return ok({ id: nextId++ });
      if (path === '/proposals/my/basket/throw') return h.lardiDown ? new Response('{"message":"down"}', { status: 503 }) : ok({ result: 'OK' });
      if (path === '/proposals/my/cargoes/published') return ok({ content: [], paginator: { totalSize: 3 } });
      return new Response('{"message":"not found"}', { status: 404 });
    }
    throw new Error('unexpected fetch ' + url);
  };
  const env = {
    DB: new FakeD1(SCHEMA),
    ADMIN_KEY: KEY,
    ...extraEnv,
    __engineOpts: { fetch, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } },
  };
  const engine = () => new Engine(env, env.__engineOpts);
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const rpc = async (method, params) => {
    const res = await worker.fetch(new Request('https://intdeliv.example.workers.dev/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://intdeliv.siteboosty.com', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ method, params }),
    }), env, ctx);
    return res.json();
  };
  /** RPC, що має вдатися: повертає result. */
  const call = async (method, params) => {
    const r = await rpc(method, params);
    assert.equal(r.ok, true, `${method}: ${r.error}`);
    return r.result;
  };
  const posts = () => calls.lardi.filter((c) => c.method === 'POST' && c.path === '/proposals/my/add/cargo');
  const throws = () => calls.lardi.filter((c) => c.path === '/proposals/my/basket/throw');
  const list = async (p = {}) => call('loads.list', { limit: 5000, ...p });
  const settle = async () => { while (pending.length) await pending.shift(); };
  return Object.assign(h, { env, engine, rpc, call, posts, throws, list, settle, ctx, pending });
}

/** Бойовий режим з акаунтами (за замовчуванням A і B), пауза 5 с. */
export async function live(h, accounts = [{ name: 'A', token: TOK_A, enabled: true }, { name: 'B', token: TOK_B, enabled: true }], extra = {}) {
  return h.call('settings.set', { lardi: { dryRun: false, mode: 'both', intervalSeconds: 5, accounts, ...extra } });
}
