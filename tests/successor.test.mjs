// server/successor.mjs: запуск рушія сам ставить наступника в чергу. GitHub API — фейковий (fetch / локальний HTTP-сервер).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeGh, ensureSuccessor, enableWorkflow, main, MAX_FAILED_PER_HOUR } from '../server/successor.mjs';

const SCRIPT = fileURLToPath(new URL('../server/successor.mjs', import.meta.url));
const TOKEN = 'ghs_test-token-never-printed';
const ENV = { GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: 'TjmerMTA/intdeliv', GITHUB_RUN_ID: '100', GITHUB_API_URL: 'https://api.github.test' };
const NOW = Date.parse('2026-10-13T16:00:00Z');
const BASE = 'https://api.github.test/repos/TjmerMTA/intdeliv/actions/workflows/engine.yml';
const ago = (min) => new Date(NOW - min * 60e3).toISOString();
const runRow = (id, status, conclusion = null, createdMinAgo = 400) => ({ id, status, conclusion, created_at: ago(createdMinAgo) });

/** Фейковий GitHub: routes — {'GET /runs…': fn|[status, body]}; записує всі запити. */
function fake(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.ok(String(url).startsWith(BASE), url);
    const key = `${init.method} ${String(url).slice(BASE.length)}`;
    calls.push({ key, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    assert.ok(init.signal, 'кожен запит має тайм-аут');
    const route = routes[key];
    if (!route) return new Response('{"message":"Not Found"}', { status: 404 });
    const [status, body] = typeof route === 'function' ? route(calls.filter((c) => c.key === key).length) : route;
    if (status === 'throw') throw new TypeError('fetch failed');
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
  };
  const lines = [];
  const sleeps = [];
  const deps = { fetch: fetchImpl, log: (m) => lines.push(m), sleep: async (ms) => { sleeps.push(ms); }, now: () => NOW };
  return { calls, lines, sleeps, deps, gh: makeGh(ENV, fetchImpl), opts: { log: deps.log, sleep: deps.sleep, now: deps.now } };
}
const LIST = 'GET /runs?per_page=30';
const DISPATCH = 'POST /dispatches';
const dispatches = (f) => f.calls.filter((c) => c.key === DISPATCH);

test('successor: у черзі нікого — ставить наступний запуск з голови main, токен лише в заголовку', async () => {
  const f = fake({ [LIST]: [200, { workflow_runs: [runRow(100, 'in_progress'), runRow(99, 'completed', 'success')] }], [DISPATCH]: [204] });
  const r = await ensureSuccessor(f.gh, f.opts);
  assert.deepEqual(r, { queued: true });
  assert.equal(dispatches(f).length, 1);
  assert.deepEqual(dispatches(f)[0].body, { ref: 'main' });
  assert.equal(dispatches(f)[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!f.lines.join('\n').includes(TOKEN));
  assert.equal(f.gh.token, undefined);
  assert.match(f.lines.join('\n'), /наступний запуск поставлено в чергу \(engine\.yml @ main\)/);
});

test('successor: наступник уже чекає (його поставив розклад або ми самі) — нічого не робить', async () => {
  for (const status of ['pending', 'queued', 'waiting', 'requested']) {
    const f = fake({ [LIST]: [200, { workflow_runs: [runRow(101, status), runRow(100, 'in_progress')] }], [DISPATCH]: [204] });
    assert.deepEqual(await ensureSuccessor(f.gh, f.opts), { queued: false, pending: 101 });
    assert.equal(dispatches(f).length, 0, status);
  }
});

test('successor: постановка в чергу не вдається — обмежена кількість спроб, гучно в журналі, без винятку', async () => {
  const flaky = fake({ [LIST]: [200, { workflow_runs: [] }], [DISPATCH]: (n) => (n < 3 ? [502, { message: 'Bad Gateway' }] : [204]) });
  assert.deepEqual(await ensureSuccessor(flaky.gh, flaky.opts), { queued: true });
  assert.equal(dispatches(flaky).length, 3);
  assert.deepEqual(flaky.sleeps, [5000, 10000]);
  assert.equal(flaky.lines.filter((l) => l.startsWith('::warning::')).length, 2);

  const dead = fake({ [LIST]: [200, { workflow_runs: [] }], [DISPATCH]: [403, { message: 'Resource not accessible by integration' }] });
  assert.deepEqual(await ensureSuccessor(dead.gh, dead.opts), { queued: false, failed: true });
  assert.equal(dispatches(dead).length, 3);
  assert.match(dead.lines.at(-1), /^::error::successor: наступний запуск НЕ поставлено в чергу/);
  assert.match(dead.lines.join('\n'), /403 \(Resource not accessible by integration\)/);

  const once = fake({ [LIST]: [200, { workflow_runs: [] }], [DISPATCH]: ['throw'] });
  assert.deepEqual(await ensureSuccessor(once.gh, { ...once.opts, tries: 1 }), { queued: false, failed: true });
  assert.equal(dispatches(once).length, 1);
  assert.deepEqual(once.sleeps, []);
});

test('successor: список запусків недоступний — у звичайному режимі однаково ставить (зайвий запуск лише замінить того, що чекає)', async () => {
  const f = fake({ [LIST]: [500, { message: 'boom' }], [DISPATCH]: [204] });
  assert.deepEqual(await ensureSuccessor(f.gh, f.opts), { queued: true });
  assert.match(f.lines[0], /^::warning::successor: не вдалося прочитати список запусків/);
});

test('successor: запуск, що впав, ставить наступника, але не крутить збій по колу', async () => {
  // перший збій за годину — ставимо
  const first = fake({ [LIST]: [200, { workflow_runs: [runRow(100, 'in_progress'), runRow(99, 'completed', 'success')] }], [DISPATCH]: [204] });
  assert.deepEqual(await ensureSuccessor(first.gh, { ...first.opts, jobStatus: 'failure' }), { queued: true });

  // давні збої, скасовані (замінені в черзі) й успішні запуски не рахуються
  const old = fake({ [LIST]: [200, { workflow_runs: [runRow(100, 'in_progress'), runRow(99, 'completed', 'failure', 61), runRow(98, 'completed', 'failure', 300), runRow(97, 'completed', 'cancelled', 5), runRow(96, 'completed', 'success', 10)] }], [DISPATCH]: [204] });
  assert.deepEqual(await ensureSuccessor(old.gh, { ...old.opts, jobStatus: 'failure' }), { queued: true });

  // уже MAX-1 свіжих збоїв + цей — стоп
  const fresh = Array.from({ length: MAX_FAILED_PER_HOUR - 1 }, (_, i) => runRow(90 + i, 'completed', 'failure', 5 + i * 5));
  const loop = fake({ [LIST]: [200, { workflow_runs: [runRow(100, 'in_progress'), ...fresh] }], [DISPATCH]: [204] });
  assert.deepEqual(await ensureSuccessor(loop.gh, { ...loop.opts, jobStatus: 'failure' }), { queued: false, breaker: true });
  assert.equal(dispatches(loop).length, 0);
  assert.match(loop.lines.at(-1), /^::error::successor: 3 збої запусків за годину/);
  // ті самі збої в історії не заважають запуску, що завершився нормально або був скасований
  for (const jobStatus of ['success', 'cancelled', '']) {
    const fine = fake({ [LIST]: [200, { workflow_runs: [runRow(100, 'in_progress'), ...fresh] }], [DISPATCH]: [204] });
    assert.deepEqual(await ensureSuccessor(fine.gh, { ...fine.opts, jobStatus }), { queued: true }, jobStatus);
  }

  // збій + невідома історія — не ставимо
  const blind = fake({ [LIST]: ['throw'], [DISPATCH]: [204] });
  assert.deepEqual(await ensureSuccessor(blind.gh, { ...blind.opts, jobStatus: 'failure' }), { queued: false, breaker: true });
  assert.equal(dispatches(blind).length, 0);
});

test('successor: enable вмикає workflow, вимкнений вручну не чіпає, збій не кидає виняток', async () => {
  const on = fake({ 'GET ': [200, { state: 'disabled_inactivity' }], 'PUT /enable': [204] });
  assert.deepEqual(await enableWorkflow(on.gh, on.opts), { enabled: true, state: 'disabled_inactivity' });
  assert.deepEqual(on.calls.map((c) => c.key), ['GET ', 'PUT /enable']);

  const manual = fake({ 'GET ': [200, { state: 'disabled_manually' }], 'PUT /enable': [204] });
  assert.deepEqual(await enableWorkflow(manual.gh, manual.opts), { enabled: false, state: 'disabled_manually' });
  assert.deepEqual(manual.calls.map((c) => c.key), ['GET ']);

  const bad = fake({ 'GET ': [200, { state: 'active' }], 'PUT /enable': [403, { message: 'Forbidden' }] });
  const r = await enableWorkflow(bad.gh, bad.opts);
  assert.equal(r.enabled, false);
  assert.match(bad.lines[0], /^::warning::successor: не вдалося увімкнути workflow/);
});

test('successor: main — без токена нічого не шле; невідома команда й винятки не валять', async () => {
  const f = fake({});
  assert.deepEqual(await main(['ensure'], { GITHUB_REPOSITORY: 'a/b' }, f.deps), { error: true });
  assert.equal(f.calls.length, 0);
  assert.match(f.lines[0], /^::error::successor: немає GITHUB_TOKEN/);
  assert.deepEqual(await main(['nope'], ENV, f.deps), { usage: true });

  const g = fake({ [LIST]: [200, { workflow_runs: [] }], [DISPATCH]: [204] });
  assert.deepEqual(await main(['ensure', '--tries=1', '--job-status=success'], ENV, g.deps), { queued: true });
});

test('successor: як процес — код 0 і коли GitHub відповідає помилкою, і коли недоступний; токена у виводі немає', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(req.url.includes('/runs') ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(req.url.includes('/runs') ? '{"workflow_runs":[]}' : '{"message":"Server Error"}');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const exec = (args, api) => new Promise((ok) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...ENV, PATH: process.env.PATH, GITHUB_API_URL: api } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => ok({ code, out }));
  });
  try {
    const api = `http://127.0.0.1:${server.address().port}`;
    const r = await exec(['ensure', '--tries=1'], api);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::error::successor: наступний запуск НЕ поставлено в чергу/);
    assert.ok(!r.out.includes(TOKEN));
    assert.deepEqual(seen, ['GET /repos/TjmerMTA/intdeliv/actions/workflows/engine.yml/runs?per_page=30', 'POST /repos/TjmerMTA/intdeliv/actions/workflows/engine.yml/dispatches']);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
  const down = await exec(['enable'], 'http://127.0.0.1:9');
  assert.equal(down.code, 0, down.out);
  assert.match(down.out, /::warning::successor: не вдалося увімкнути workflow/);
});
