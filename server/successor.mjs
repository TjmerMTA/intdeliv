// IntDeliv — безперервність рушія в GitHub Actions: кожен запуск сам ставить у чергу свого наступника.
// Розклад GitHub запускається нерегулярно (паузи по кілька годин), тож покладатися лише на нього не можна:
// якщо за час роботи запуску тригер не прийшов, після його завершення рушія немає зовсім.
//
//   node server/successor.mjs enable                      — увімкнути workflow (GitHub вимикає розклад після 60 днів без активності)
//   node server/successor.mjs ensure [--tries=N] [--job-status=success|failure|cancelled]
//                                                         — якщо в черзі немає наступного запуску, поставити його (workflow_dispatch)
//
// Завжди завершується з кодом 0: збій постановки в чергу не має валити запуск рушія. Про невдачу — анотація
// ::warning:: / ::error:: у журналі. Кожна дія обмежена: N спроб, тайм-аут на запит; токен ніде не друкується.
//
// ENV (у GitHub Actions задані самі, крім токена): GITHUB_TOKEN (потрібен дозвіл actions: write), GITHUB_REPOSITORY,
// GITHUB_RUN_ID, GITHUB_API_URL; ENGINE_WORKFLOW (engine.yml), ENGINE_REF (main).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUEST_TIMEOUT_MS = 20e3;
const RETRY_STEP_MS = 5e3;
/** Запуск, що впав, теж ставить наступника — але не більше стількох збоїв поспіль за годину (далі чекаємо на розклад). */
export const MAX_FAILED_PER_HOUR = 3;
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/** Клієнт REST API GitHub для одного workflow. Повертає розібраний JSON або кидає помилку з кодом відповіді. */
export function makeGh(env = process.env, fetchImpl = fetch) {
  const cfg = {
    token: String(env.GITHUB_TOKEN || env.GH_TOKEN || '').trim(),
    repo: String(env.GITHUB_REPOSITORY || '').trim(),
    api: String(env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
    runId: String(env.GITHUB_RUN_ID || ''),
    workflow: env.ENGINE_WORKFLOW || 'engine.yml',
    ref: env.ENGINE_REF || 'main',
  };
  const request = async (method, path, body) => {
    if (!cfg.token) throw new Error('GITHUB_TOKEN не заданий');
    if (!cfg.repo) throw new Error('GITHUB_REPOSITORY не заданий');
    const res = await fetchImpl(`${cfg.api}/repos/${cfg.repo}/actions/workflows/${cfg.workflow}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'intdeliv-engine',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* не JSON — лишаємо null */ }
    if (!res.ok) throw new Error(`${method} …${path || '/'} → ${res.status}${json && json.message ? ` (${json.message})` : ''}`);
    return json;
  };
  // сам токен назовні не віддаємо — лише ознаку, що він є
  return { ...cfg, token: undefined, configured: !!(cfg.token && cfg.repo), request };
}

/**
 * Увімкнути workflow. Запит «enable» заразом скидає лічильник бездіяльності, через який GitHub вимикає розклад.
 * Вимкнений людиною (disabled_manually) не чіпаємо: це чиєсь рішення.
 */
export async function enableWorkflow(gh, { log = console.log } = {}) {
  try {
    const wf = await gh.request('GET', '');
    if (wf && wf.state === 'disabled_manually') {
      log(`::warning::successor: workflow ${gh.workflow} вимкнено вручну — не вмикаю`);
      return { enabled: false, state: wf.state };
    }
    await gh.request('PUT', '/enable');
    log(`successor: workflow ${gh.workflow} увімкнено (був: ${(wf && wf.state) || '?'})`);
    return { enabled: true, state: wf && wf.state };
  } catch (e) {
    log(`::warning::successor: не вдалося увімкнути workflow — ${e.message}`);
    return { enabled: false, error: e.message };
  }
}

/**
 * Якщо в черзі (або в роботі) немає іншого запуску цього workflow — поставити новий.
 * @param {{tries?: number, jobStatus?: string, log?: Function, sleep?: Function, now?: Function}} o
 *   jobStatus — статус поточного job (в останньому кроці): для 'failure' діє обмеження MAX_FAILED_PER_HOUR.
 * @returns {{queued: boolean, pending?: number, breaker?: boolean, failed?: boolean}}
 */
export async function ensureSuccessor(gh, o = {}) {
  const { jobStatus = '', log = console.log, now = () => Date.now() } = o;
  const tries = Math.min(5, Math.max(1, Number(o.tries) || 3));
  const sleep = o.sleep || ((ms) => new Promise((ok) => setTimeout(ok, ms)));

  let runs = null;
  try {
    runs = ((await gh.request('GET', '/runs?per_page=30')) || {}).workflow_runs || [];
  } catch (e) {
    log(`::warning::successor: не вдалося прочитати список запусків — ${e.message}`);
  }
  const others = (runs || []).filter((r) => String(r.id) !== gh.runId);
  const pending = others.find((r) => r.status !== 'completed');
  if (pending) {
    log(`successor: наступний запуск уже чекає (#${pending.id}, ${pending.status})`);
    return { queued: false, pending: pending.id };
  }

  if (jobStatus === 'failure') {
    // зламаний крок (не той ключ, недоступна гілка data) не має крутити запуски по колу
    if (!runs) {
      log('::error::successor: запуск завершився збоєм, а список запусків недоступний — наступника не ставлю, його поставить розклад');
      return { queued: false, breaker: true };
    }
    const recent = others.filter((r) => FAILED.has(r.conclusion) && now() - Date.parse(r.created_at) < 3600e3).length;
    if (recent + 1 >= MAX_FAILED_PER_HOUR) {
      log(`::error::successor: ${recent + 1} збої запусків за годину — наступника не ставлю, щоб не крутити збій по колу. Рушій стоїть до спрацювання розкладу або ручного запуску`);
      return { queued: false, breaker: true };
    }
  }

  for (let i = 1; i <= tries; i++) {
    try {
      await gh.request('POST', '/dispatches', { ref: gh.ref });
      log(`successor: наступний запуск поставлено в чергу (${gh.workflow} @ ${gh.ref}) — стартує, щойно цей завершиться`);
      return { queued: true };
    } catch (e) {
      log(`::warning::successor: спроба ${i} з ${tries} поставити наступний запуск не вдалась — ${e.message}`);
      if (i < tries) await sleep(i * RETRY_STEP_MS);
    }
  }
  log('::error::successor: наступний запуск НЕ поставлено в чергу. Якщо так і лишиться, після завершення цього запуску рушій стоятиме до спрацювання розкладу');
  return { queued: false, failed: true };
}

/** CLI. Повертає результат дії; винятків не кидає. */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const log = deps.log || console.log;
  const [cmd, ...rest] = argv;
  const flag = (name) => { const a = rest.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : undefined; };
  try {
    const gh = makeGh(env, deps.fetch || fetch);
    if ((cmd === 'enable' || cmd === 'ensure') && !gh.configured) {
      log('::error::successor: немає GITHUB_TOKEN або GITHUB_REPOSITORY — наступний запуск не ставлю');
      return { error: true };
    }
    if (cmd === 'enable') return await enableWorkflow(gh, { log });
    if (cmd === 'ensure') return await ensureSuccessor(gh, { tries: flag('tries'), jobStatus: flag('job-status'), log, sleep: deps.sleep, now: deps.now });
    log('usage: successor.mjs enable | ensure [--tries=N] [--job-status=success|failure|cancelled]');
    return { usage: true };
  } catch (e) {
    log(`::error::successor: ${(e && e.message) || e}`);
    return { error: true };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
  process.exit(0);
}
