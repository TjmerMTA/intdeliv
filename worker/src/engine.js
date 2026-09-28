// IntDeliv — хмарний рушій: збір Della → D1 → черга публікації на Lardi.
// Порт extension/background.js без chrome.*: замість alarms — cron щохвилини, замість IndexedDB — D1.
import { parseDellaSearchWithIds, buildPageUrl } from '../../extension/lib/della.js';
import { applyFilters } from '../../extension/lib/filters.js';
import { LardiClient, NeedsReviewError } from '../../extension/lib/lardi.js';
import {
  STATUSES, applyPatch, maskToken, isMasked, accountsNeeded, upsertLardiEntry, describe,
  customerKeys, weakKeys, parseCustomerInput,
} from '../../extension/lib/model.js';
import { Store } from './store.js';

export const VERSION = '1.2.0-worker';
export const ARCHIVE_DAYS = 30;
export const MAX_ACCOUNTS = 5;
export const BLACK_REASON = 'чорний список';

export const DEFAULT_SEARCH_URL = 'https://della.com.ua/search/a204bd204eflolz1z21z3z4z51z6z7z8z9y1y2y3y4y5y6h0ilk0m1.html';

export const DEFAULT_SETTINGS = {
  della: { searchUrls: [DEFAULT_SEARCH_URL], pollSeconds: 60, pagesPerPoll: 3 },
  filters: {
    minPrice: 8000, directOnly: true, bodies: [], fromRegions: [], toRegions: [], excludeRegions: [],
    stopWords: [], maxAgeHours: 0,
  },
  lardi: {
    accounts: [
      { name: 'Акаунт 1', token: '', enabled: true },
      { name: 'Акаунт 2', token: '', enabled: true },
    ],
    mode: 'both', autoPublish: true, dryRun: true, intervalSeconds: 60, dailyLimit: 500, note: '',
  },
  staleHours: 6,
};

export const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.6,en;q=0.5',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

const RUN_BUDGET_MS = 25000;
const STALE_EVERY_MS = 10 * 60e3;
export const SWEEP_LIMIT = 100; // публікацій за один прохід добору зняття
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- час за Києвом (Worker працює в UTC, Della — київські дати) ----------

let kyivFmt;
function kyivParts(ms) {
  if (!kyivFmt) {
    const opts = { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' };
    try { kyivFmt = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: 'Europe/Kyiv' }); } catch { kyivFmt = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: 'Europe/Kiev' }); }
  }
  const o = {};
  for (const p of kyivFmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
export function kyivDay(ms) {
  const p = kyivParts(ms);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
/** Date, у якого «локальні» поля = київський настінний час (для todayIso/inferDate бібліотек). */
export function kyivWall(ms) {
  const p = kyivParts(ms);
  return new Date(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
}

// ---------- налаштування ----------

export function mergeDefaults(s) {
  const d = clone(DEFAULT_SETTINGS);
  if (!s || typeof s !== 'object') return d;
  const out = {
    della: { ...d.della, ...(s.della || {}) },
    filters: { ...d.filters, ...(s.filters || {}) },
    lardi: { ...d.lardi, ...(s.lardi || {}) },
    staleHours: s.staleHours ?? d.staleHours,
  };
  if (!Array.isArray(out.lardi.accounts) || !out.lardi.accounts.length) out.lardi.accounts = d.lardi.accounts;
  if (!Array.isArray(out.della.searchUrls) || !out.della.searchUrls.length) out.della.searchUrls = d.della.searchUrls;
  return out;
}

export function maskSettings(s) {
  const m = clone(s);
  m.lardi.accounts = m.lardi.accounts.map((a, i) => ({ ...a, index: i, token: maskToken(a.token), hasToken: !!a.token, state: accountState(a) }));
  return m;
}

const num = (v, dflt, min, max = Infinity) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};
const strList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]/))
  .map((x) => String(x).trim()).filter(Boolean);

const isReview = (e) => e instanceof NeedsReviewError || (e && e.needsReview);
const isAuthError = (e) => e && (e.status === 401 || e.status === 403);

/**
 * Стан акаунта Lardi: disabled (вимкнено/архівний) · pending (немає токена — «Очікує підключення»)
 * · invalid (Lardi відхилив токен — авто-пауза) · ok.
 */
export function accountState(a) {
  if (!a || a.archived || !a.enabled) return 'disabled';
  if (!a.token) return 'pending';
  if (a.state === 'invalid') return 'invalid';
  return 'ok';
}

// міграція бази — один раз на з'єднання (Engine створюється на кожен запит)
const migrations = new WeakMap();

export class Engine {
  /**
   * @param {object} env  — {DB, ADMIN_KEY}
   * @param {{ctx?, fetch?, now?, sleep?, budgetMs?}} opts
   */
  constructor(env, opts = {}) {
    this.env = env;
    this.ctx = opts.ctx || null;
    this.fetch = opts.fetch || ((...a) => globalThis.fetch(...a));
    this.now = opts.now || (() => Date.now());
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.budgetMs = opts.budgetMs ?? RUN_BUDGET_MS;
    this.store = new Store(env.DB, this.now);
  }

  /** Міграція схеми (додає колонку й заповнює її) — перед першим зверненням до заявок. */
  ready() {
    let p = migrations.get(this.env.DB);
    if (!p) {
      p = this.store.migrate().then((n) => { if (n) console.log(`[IntDeliv] migrate: custKeys для ${n} заявок`); });
      migrations.set(this.env.DB, p);
      p.catch(() => migrations.delete(this.env.DB));
    }
    return p;
  }

  waitUntil(p) {
    const safe = Promise.resolve(p).catch((e) => this.log('error', e.message || String(e)));
    if (this.ctx && this.ctx.waitUntil) this.ctx.waitUntil(safe);
    return safe;
  }

  async log(level, msg) {
    try { await this.store.addLog(level, msg); } catch (e) { console.warn('log failed', e); }
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)('[IntDeliv]', msg);
  }

  // ---------- settings ----------

  async getSettings() {
    return mergeDefaults(await this.store.getKV('settings', null));
  }

  async setSettings(patch = {}) {
    const cur = await this.getSettings();
    const next = clone(cur);
    if (patch.della) {
      const p = patch.della;
      if (p.searchUrls !== undefined) {
        const urls = strList(p.searchUrls).filter((u) => /^https:\/\/(www\.)?della\.com\.ua\/search\/.+\.html/.test(u));
        next.della.searchUrls = urls.length ? urls : [DEFAULT_SEARCH_URL];
      }
      if (p.pollSeconds !== undefined) next.della.pollSeconds = num(p.pollSeconds, cur.della.pollSeconds, 30, 3600);
      if (p.pagesPerPoll !== undefined) next.della.pagesPerPoll = Math.round(num(p.pagesPerPoll, cur.della.pagesPerPoll, 1, 20));
    }
    if (patch.filters) {
      const p = patch.filters;
      if (p.minPrice !== undefined) next.filters.minPrice = num(p.minPrice, cur.filters.minPrice, 0);
      if (p.directOnly !== undefined) next.filters.directOnly = !!p.directOnly;
      if (p.maxAgeHours !== undefined) next.filters.maxAgeHours = num(p.maxAgeHours, 0, 0);
      for (const k of ['bodies', 'fromRegions', 'toRegions', 'excludeRegions', 'stopWords']) {
        if (p[k] !== undefined) next.filters[k] = strList(p[k]);
      }
    }
    if (patch.lardi) {
      const p = patch.lardi;
      if (Array.isArray(p.accounts)) {
        // індекс акаунта — ключ у load.lardi[].account і лічильниках: акаунти не видаляються й не переставляються,
        // «видалити» = archived (вимкнено, токен стерто). Коротший масив (стара адмінка) решту не чіпає.
        const n = Math.min(MAX_ACCOUNTS, Math.max(cur.lardi.accounts.length, p.accounts.length));
        next.lardi.accounts = Array.from({ length: n }, (_, i) => {
          const prev = cur.lardi.accounts[i] || {};
          const a = p.accounts[i];
          if (!a) return { ...prev, name: prev.name || `Акаунт ${i + 1}`, token: prev.token || '', enabled: prev.enabled ?? true };
          const acc = { ...prev };
          acc.name = String(a.name || '').trim().slice(0, 60) || prev.name || `Акаунт ${i + 1}`;
          let token = typeof a.token === 'string' ? a.token.trim() : '';
          if (!token || isMasked(token)) token = prev.token || ''; // порожнє / маска — не змінювати
          if (token !== (prev.token || '')) { acc.state = 'unchecked'; delete acc.lastError; delete acc.checkedAt; }
          acc.token = token;
          acc.enabled = a.enabled !== undefined ? !!a.enabled : (prev.enabled ?? true);
          if (a.archived) { acc.archived = true; acc.enabled = false; acc.token = ''; delete acc.state; delete acc.lastError; }
          else if (a.archived === false || a.restore) delete acc.archived;
          return acc;
        });
      }
      if (p.mode !== undefined) next.lardi.mode = p.mode === 'roundrobin' ? 'roundrobin' : 'both';
      if (p.autoPublish !== undefined) next.lardi.autoPublish = !!p.autoPublish;
      if (p.dryRun !== undefined) next.lardi.dryRun = !!p.dryRun;
      if (p.intervalSeconds !== undefined) next.lardi.intervalSeconds = num(p.intervalSeconds, cur.lardi.intervalSeconds, 5, 3600);
      if (p.dailyLimit !== undefined) next.lardi.dailyLimit = Math.round(num(p.dailyLimit, cur.lardi.dailyLimit, 0, 10000));
      if (p.note !== undefined) next.lardi.note = String(p.note || '').slice(0, 300);
    }
    if (patch.staleHours !== undefined) next.staleHours = num(patch.staleHours, cur.staleHours, 1, 240);

    await this.store.setKV('settings', next);
    // новий токен — одразу перевірити (результат — у стані акаунта; сам токен у журнал не пишемо)
    for (let i = 0; i < next.lardi.accounts.length; i++) {
      const a = next.lardi.accounts[i];
      const prev = cur.lardi.accounts[i] || {};
      if (a.archived && !prev.archived) await this.log('info', `Акаунт Lardi «${a.name}» видалено (вимкнено, токен стерто)`);
      if (a.token && a.token !== (prev.token || '')) {
        await this.log('info', `Акаунт Lardi «${a.name}»: збережено новий токен`);
        await this.checkAccount(i);
      }
    }
    if (next.lardi.dryRun !== cur.lardi.dryRun) {
      await this.log('info', next.lardi.dryRun ? 'Увімкнено DRY RUN — на Lardi нічого не публікується' : 'DRY RUN вимкнено — публікація на Lardi увімкнена');
    }
    return maskSettings(await this.getSettings());
  }

  /** Перевірити токен акаунта й записати стан (ok / invalid). Повертає результат LardiClient.test(). */
  async checkAccount(i, tokenOverride) {
    const s = await this.getSettings();
    const acc = s.lardi.accounts[i];
    const tok = tokenOverride || (acc && acc.token);
    if (!tok) return { ok: false, error: 'токен не задано' };
    const client = new LardiClient({ token: tok, cache: this.store.cache, fetch: this.fetch, sleep: this.sleep, maxRetries: 1 });
    let r;
    let status = 0;
    try {
      const data = await client.request('GET', '/proposals/my/cargoes/published', { query: { page: 1, size: 1 } });
      const total = data && data.paginator ? data.paginator.totalSize : undefined;
      r = { ok: true, name: total !== undefined ? `токен дійсний, опубліковано вантажів: ${total}` : 'токен дійсний' };
    } catch (e) {
      status = e.status || 0;
      r = { ok: false, error: e.message };
    }
    if (acc && !tokenOverride) {
      await this.patchAccount(i, (a) => (a.token !== tok ? null : {
        ...a,
        state: r.ok ? 'ok' : isAuthError({ status }) ? 'invalid' : a.state,
        lastError: r.ok ? undefined : r.error,
        checkedAt: this.now(),
      }));
    }
    await this.log(r.ok ? 'info' : 'warn', `Перевірка токена «${(acc && acc.name) || `#${i + 1}`}»: ${r.ok ? r.name : r.error}`);
    return r;
  }

  /** Змінити службові поля акаунта (стан, помилка) без settings.set. fn(acc) → новий acc або null. */
  async patchAccount(i, fn) {
    const s = await this.getSettings();
    const acc = s.lardi.accounts[i];
    if (!acc) return null;
    const next = fn({ ...acc });
    if (!next) return acc;
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    s.lardi.accounts[i] = next;
    await this.store.setKV('settings', s);
    return next;
  }

  accName(s, i) {
    return (s.lardi.accounts[i] && s.lardi.accounts[i].name) || `#${i + 1}`;
  }

  // ---------- stats ----------

  async getToday(accountsCount = 2) {
    const c = await this.store.counters(kyivDay(this.now()));
    const n = Math.max(1, accountsCount);
    const arr = (p) => Array.from({ length: n }, (_, i) => c[`${p}:${i}`] || 0);
    return { date: kyivDay(this.now()), collected: c.collected || 0, published: arr('published'), dry: arr('dry') };
  }

  /** Статистика по кожному акаунту Lardi (без токенів). */
  async accountsStats(sIn) {
    const s = sIn || (await this.getSettings());
    const [today, live, errors, lastAt] = await Promise.all([
      this.getToday(s.lardi.accounts.length),
      this.store.liveByAccount(),
      this.store.errorsByAccount(),
      this.store.getMeta('lastPublishAt', {}),
    ]);
    return s.lardi.accounts.map((a, i) => ({
      index: i,
      name: a.name || `Акаунт ${i + 1}`,
      enabled: !!a.enabled,
      archived: !!a.archived,
      state: accountState(a),
      hasToken: !!a.token,
      today: { published: today.published[i] || 0, dry: today.dry[i] || 0, limit: s.lardi.dailyLimit },
      live: live[i] || 0,
      errors: errors[i] || 0,
      lastPublishAt: (lastAt && lastAt[i]) || undefined,
      lastError: a.lastError || undefined,
      checkedAt: a.checkedAt || undefined,
    }));
  }

  bump(key, by = 1) { return this.store.bump(kyivDay(this.now()), key, by); }

  async getStatus() {
    const s = await this.getSettings();
    const [counts, today, lastPollAt, lastError, lastPollOkAt, busy, accounts] = await Promise.all([
      this.store.countByStatus(STATUSES),
      this.getToday(s.lardi.accounts.length),
      this.store.getMeta('lastPollAt', null),
      this.store.getMeta('lastError', null),
      this.store.getMeta('lastPollOkAt', null),
      this.store.lockActive(),
      this.accountsStats(s),
    ]);
    return {
      running: true,
      backend: 'cloud',
      busy,
      polling: busy,
      publishing: busy,
      lastPollAt: lastPollAt || undefined,
      lastPollOkAt: lastPollOkAt || undefined,
      lastError: lastError || undefined,
      counts,
      today: { collected: today.collected, published: today.published, dry: today.dry },
      queue: counts.queued || 0,
      dryRun: s.lardi.dryRun,
      autoPublish: s.lardi.autoPublish,
      mode: s.lardi.mode,
      accounts,
      version: VERSION,
      archiveDays: ARCHIVE_DAYS,
    };
  }

  // ---------- головний цикл (cron) ----------

  /**
   * Один запуск: збір (якщо настав час), публікація, перевірка актуальності.
   * @param {{forcePoll?: boolean, skipPoll?: boolean}} o
   */
  async runCycle(o = {}) {
    await this.ready();
    const start = this.now();
    const deadline = start + this.budgetMs;
    const owner = `${start}-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await this.store.acquireLock(owner, 55000))) {
      if (o.forcePoll) await this.store.setMeta('forcePoll', true);
      return { skipped: 'locked' };
    }
    const out = {};
    try {
      const s = await this.getSettings();
      const forced = o.forcePoll || (await this.store.getMeta('forcePoll', false));
      const lastPollAt = (await this.store.getMeta('lastPollAt', 0)) || 0;
      if (!o.skipPoll && (forced || start - lastPollAt >= s.della.pollSeconds * 1000 - 5000)) {
        if (forced) await this.store.setMeta('forcePoll', false);
        out.poll = await this.poll(s);
      }
      const lastStale = (await this.store.getMeta('lastStaleAt', 0)) || 0;
      if (start - lastStale >= STALE_EVERY_MS) {
        await this.store.setMeta('lastStaleAt', start);
        out.stale = await this.staleCheck();
      }
      out.published = await this.publishTick(deadline);
      await this.store.trimLog();
    } catch (e) {
      await this.log('error', 'Цикл: ' + (e.message || e));
      out.error = e.message;
    } finally {
      await this.store.releaseLock(owner).catch(() => {});
    }
    return out;
  }

  // ---------- збір Della ----------

  async fetchDella(url) {
    // DELLA_COOKIE — сесія залогіненого акаунта Della (тоді в картках є код компанії). Значення ніде не логується.
    const cookie = this.env && this.env.DELLA_COOKIE ? String(this.env.DELLA_COOKIE).trim() : '';
    const headers = cookie ? { ...BROWSER_HEADERS, Cookie: cookie } : BROWSER_HEADERS;
    const res = await this.fetch(url, { headers, redirect: 'follow' });
    if (!res.ok) throw new Error(`Della ${res.status} для ${url}`);
    return res.text();
  }

  filterVerdict(p, f) {
    // дата — за Києвом; maxAgeHours рахуємо від реального часу
    const v = applyFilters(p, { ...f, maxAgeHours: 0 }, kyivWall(this.now()));
    if (!v.pass) return v;
    const maxAge = Number(f.maxAgeHours) || 0;
    if (maxAge > 0 && p.postedAt && this.now() - p.postedAt > maxAge * 3600e3) return { pass: false, reason: `старша за ${maxAge} год` };
    return v;
  }

  async poll(sIn) {
    const s = sIn || (await this.getSettings());
    const now = this.now();
    await this.store.setMeta('lastPollAt', now);
    let seen = 0; let inserted = 0; let filtered = 0; let errors = 0;
    const reasons = {};
    try {
      // усі сторінки всіх пошуків — паралельно
      const jobs = [];
      for (const searchUrl of s.della.searchUrls) {
        for (let page = 0; page < s.della.pagesPerPoll; page++) jobs.push({ url: buildPageUrl(searchUrl, page), page });
      }
      const pages = await Promise.allSettled(jobs.map((j) => this.fetchDella(j.url)));
      const byId = new Map();
      const wall = kyivWall(now);
      for (let i = 0; i < jobs.length; i++) {
        const r = pages[i];
        if (r.status === 'rejected') {
          errors++;
          await this.log('warn', r.reason && r.reason.message ? r.reason.message : String(r.reason));
          continue;
        }
        const parsed = await parseDellaSearchWithIds(r.value, { url: jobs[i].url, now: wall });
        if (!parsed.length && jobs[i].page === 0 && !/request_card|search_result/.test(r.value)) {
          await this.log('warn', `Della: карток не знайдено (${jobs[i].url}) — можливо, змінилась верстка, капча або блокування IP`);
        }
        for (const p of parsed) if (!byId.has(p.id)) byId.set(p.id, p);
      }
      const parsed = [...byId.values()];
      seen = parsed.length;
      const black = await this.store.keysOfList('black');
      const isBlack = (l) => black.size > 0 && customerKeys(l).some((k) => black.has(k));
      const verdict = new Map();
      for (const p of parsed) {
        const v = this.filterVerdict(p, s.filters);
        verdict.set(p.id, v.pass && isBlack(p) ? { pass: false, reason: BLACK_REASON } : v);
      }
      const res = await this.store.upsertSeen(parsed, (p) => verdict.get(p.id).pass, now);
      const updatedIds = new Set(res.updated.map((u) => u.after.id));
      for (const p of parsed) {
        const v = verdict.get(p.id);
        if (!v.pass && !updatedIds.has(p.id)) {
          filtered++;
          const key = v.reason.replace(/\d+/g, 'N');
          reasons[key] = (reasons[key] || 0) + 1;
        }
      }
      inserted = res.inserted.length;
      for (const u of res.updated) {
        if (u.after.dellaDeleted && !u.before.dellaDeleted) {
          await this.markInactive(u.after.id, 'видалена на Della', 'deleted_on_della', s);
        } else if (u.after.status === 'new' && u.before.status === 'inactive' && isBlack(u.after)) {
          await this.markInactive(u.after.id, BLACK_REASON, 'blacklist', s); // «ожила» в Della, але замовник у чорному списку
        }
      }
      if (s.lardi.autoPublish) {
        const toQueue = [...res.inserted, ...res.updated.filter((u) => u.after.status === 'new' && u.before.status === 'inactive' && !isBlack(u.after)).map((u) => u.after)];
        for (const l of toQueue) await this.enqueue(l.id, false);
      }
      if (!errors) {
        await this.store.setMeta('lastPollOkAt', now);
        await this.store.setMeta('lastError', null);
      } else {
        await this.store.setMeta('lastError', `Помилки завантаження Della: ${errors} з ${jobs.length}`);
        if (errors < jobs.length) await this.store.setMeta('lastPollOkAt', now);
      }
      if (inserted) await this.bump('collected', inserted);
      const rs = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join('; ');
      await this.log('info', `Збір: переглянуто ${seen}, нових ${inserted}, відфільтровано ${filtered}${rs ? ` (${rs})` : ''}`);
    } catch (e) {
      await this.store.setMeta('lastError', e.message);
      await this.log('error', 'Збір: ' + e.message);
    }
    return { seen, inserted, filtered, errors };
  }

  // ---------- черга / публікація ----------

  /** Замовник заявки в чорному списку? */
  async isBlackLoad(load) {
    const keys = customerKeys(load || {});
    return keys.length > 0 && (await this.store.listOfKeys(keys)) === 'black';
  }

  async enqueue(id, manual) {
    const now = this.now();
    const cur = await this.store.getLoad(id);
    if (cur && (await this.isBlackLoad(cur))) {
      if (manual) throw new Error('замовник у чорному списку');
      return null;
    }
    return this.store.updateLoad(id, (l) => {
      if (!manual && l.status !== 'new') return null; // вручну можна повернути й з архіву
      return {
        ...l,
        status: 'queued',
        statusReason: manual ? 'поставлено в чергу вручну' : undefined,
        lardi: (l.lardi || []).filter((e) => e.status !== 'error' && e.status !== 'removed'),
        queuedAt: now,
        updatedAt: now,
      };
    });
  }

  clientFor(settings, i) {
    const acc = settings.lardi.accounts[i];
    if (!acc || !acc.token) return null;
    return new LardiClient({ token: acc.token, cache: this.store.cache, fetch: this.fetch, sleep: this.sleep, maxRetries: 2 });
  }

  anyClient(settings, prefer) {
    return this.clientFor(settings, prefer) || settings.lardi.accounts.map((_, i) => this.clientFor(settings, i)).find(Boolean) || null;
  }

  /** Публікує стільки, скільки дозволяють інтервал і ліміт, до дедлайну. Повертає кількість кроків. */
  async publishTick(deadline = this.now() + this.budgetMs) {
    let done = 0;
    for (;;) {
      const s = await this.getSettings();
      // autoPublish керує лише автоматичним постановленням у чергу; ручні «Опублікувати» теж тут
      const today = kyivDay(this.now());
      const queued = (await this.store.queuedLight()).filter((l) => !(l.dateLast && l.dateLast < today));
      if (!queued.length) break;
      const counts = await this.getToday(s.lardi.accounts.length);
      const lastAt = (await this.store.getMeta('lastPublishAt', {})) || {};
      const rr = (await this.store.getMeta('rrPointer', 0)) || 0;
      const intervalMs = s.lardi.intervalSeconds * 1000;
      const dry = s.lardi.dryRun;
      const now = this.now();

      let best = null;
      for (const l of queued) {
        const accs = accountsNeeded(l, s, rr);
        if (!accs.length) {
          if (!dry && (l.lardi || []).some((e) => e.status === 'published')) {
            await this.store.updateLoad(l.id, (x) => ({ ...x, status: 'published', updatedAt: this.now() }));
          }
          continue;
        }
        for (const a of accs) {
          const used = (counts.published[a] || 0) + (counts.dry[a] || 0);
          if (s.lardi.dailyLimit && used >= s.lardi.dailyLimit) continue;
          const at = Math.max(now, (lastAt[a] || 0) + intervalMs);
          if (!best || at < best.at) best = { id: l.id, account: a, at };
        }
        if (best && best.at <= now) break;
      }
      if (!best || best.at > deadline) break;
      if (best.at > this.now()) await this.sleep(best.at - this.now());
      await this.publishOne(best.id, best.account, s);
      done++;
      lastAt[best.account] = this.now();
      await this.store.setMeta('lastPublishAt', lastAt);
      if (s.lardi.mode === 'roundrobin') await this.store.setMeta('rrPointer', rr + 1);
      if (this.now() > deadline) break;
    }
    return done;
  }

  async publishOne(id, account, s) {
    const load = await this.store.getLoad(id);
    if (!load || load.status !== 'queued') return;
    if (await this.isBlackLoad(load)) { // страховка від гонки з додаванням у чорний список
      await this.markInactive(id, BLACK_REASON, 'blacklist', s);
      return;
    }
    const accName = this.accName(s, account);

    if (s.lardi.dryRun) {
      let reason;
      const client = this.anyClient(s, account);
      if (client) {
        try {
          await client.prepareCargo(load, s); // лише GET-довідники, без запису на Lardi
        } catch (e) {
          if (isReview(e)) reason = e.message;
          else await this.log('warn', `DRY RUN: не вдалося перевірити на Lardi (${e.message})`);
        }
      }
      if (reason) {
        await this.store.updateLoad(id, (l) => ({ ...l, status: 'needs_review', statusReason: reason, updatedAt: this.now() }));
        await this.log('warn', `Потрібна перевірка: ${describe(load)} — ${reason}`);
      } else {
        await this.store.updateLoad(id, (l) => ({
          ...upsertLardiEntry(l, { account, status: 'dry', error: undefined }),
          statusReason: 'DRY RUN — буде опубліковано після вимкнення тестового режиму',
          updatedAt: this.now(),
        }));
        await this.bump(`dry:${account}`);
        await this.log('info', `DRY RUN: would publish → Lardi «${accName}»: ${describe(load)}`);
      }
      return;
    }

    const client = this.clientFor(s, account);
    if (!client) {
      await this.store.updateLoad(id, (l) => upsertLardiEntry(l, { account, status: 'error', error: 'немає токена' }));
      return;
    }
    try {
      const { id: lardiId } = await client.addCargo(load, s);
      await this.store.updateLoad(id, (l) => {
        const next = upsertLardiEntry(l, { account, id: lardiId, status: 'published', error: undefined, publishedAt: this.now() });
        const remaining = accountsNeeded(next, s);
        return { ...next, status: remaining.length ? 'queued' : 'published', statusReason: undefined, updatedAt: this.now() };
      });
      await this.bump(`published:${account}`);
      await this.log('info', `Опубліковано на Lardi «${accName}» (id ${lardiId}): ${describe(load)}`);
    } catch (e) {
      if (isReview(e)) {
        await this.store.updateLoad(id, (l) => ({ ...l, status: 'needs_review', statusReason: e.message, updatedAt: this.now() }));
        await this.log('warn', `Потрібна перевірка: ${describe(load)} — ${e.message}`);
      } else if (isAuthError(e)) {
        // Lardi відхилив токен — акаунт на паузу (state=invalid), заявка лишається в черзі для інших акаунтів
        await this.patchAccount(account, (a) => ({ ...a, state: 'invalid', lastError: e.message, checkedAt: this.now() }));
        await this.store.updateLoad(id, (l) => {
          const next = upsertLardiEntry(l, { account, status: 'error', error: e.message });
          const anyLive = (next.lardi || []).some((x) => x.status === 'published');
          return { ...next, status: anyLive ? 'published' : 'queued', updatedAt: this.now() };
        });
        await this.log('error', `Lardi «${accName}» відхилив токен (${e.message}) — акаунт призупинено, введіть новий токен у Налаштуваннях`);
      } else {
        await this.store.updateLoad(id, (l) => {
          const next = upsertLardiEntry(l, { account, status: 'error', error: e.message });
          const anyLive = (next.lardi || []).some((x) => x.status === 'published');
          return { ...next, status: anyLive ? 'published' : 'error', statusReason: e.message, updatedAt: this.now() };
        });
        await this.log('error', `Lardi «${accName}»: ${e.message} — ${describe(load)}`);
      }
    }
  }

  // ---------- зняття / актуальність ----------

  async removeFromLardi(id, s) {
    const load = await this.store.getLoad(id);
    if (!load) return null;
    const live = (load.lardi || []).filter((e) => e.id && e.status === 'published');
    if (!live.length) {
      return this.store.updateLoad(id, (l) => ({ ...l, lardi: (l.lardi || []).map((e) => (e.status === 'dry' || e.status === 'queued' ? { ...e, status: 'removed' } : e)) }));
    }
    // тестовий режим лише не публікує; вже реальні публікації знімаємо завжди
    const results = {};
    for (const e of live) {
      const client = this.clientFor(s, e.account);
      if (!client) { results[e.account] = 'немає токена'; continue; }
      try {
        await client.throwToBasket([e.id]);
        results[e.account] = null;
      } catch (err) {
        results[e.account] = err.message;
        await this.log('error', `Не вдалося зняти з Lardi (id ${e.id}): ${err.message}`);
      }
    }
    const updated = await this.store.updateLoad(id, (l) => ({
      ...l,
      lardi: (l.lardi || []).map((e) => {
        if (!(e.account in results)) return e;
        return results[e.account] === null ? { ...e, status: 'removed', removedAt: this.now(), error: undefined } : { ...e, error: results[e.account] };
      }),
      updatedAt: this.now(),
    }));
    const ok = Object.values(results).filter((v) => v === null).length;
    if (ok) await this.log('info', `Знято з Lardi (${ok}): ${describe(load)}`);
    return updated;
  }

  async markInactive(id, reason, kind, s) {
    const updated = await this.store.updateLoad(id, (l) => {
      if (l.status === 'deleted' || l.status === 'inactive') return null;
      return { ...l, status: 'inactive', statusReason: reason, inactiveKind: kind, updatedAt: this.now() };
    });
    if (updated && updated.status === 'inactive' && updated.inactiveKind === kind) await this.removeFromLardi(id, s);
    return updated;
  }

  async staleCheck() {
    const s = await this.getSettings();
    const lastOk = (await this.store.getMeta('lastPollOkAt', 0)) || 0;
    const staleMs = s.staleHours * 3600e3;
    const today = kyivDay(this.now());
    // якщо збір ще жодного разу не вдався — «не видно в Della» не рахуємо
    const seenBefore = lastOk ? lastOk - staleMs : -1;
    // спершу добір того, що не вдалося зняти раніше; щойно неактуальні знімаються в markInactive нижче
    await this.sweepLardi(s);
    const cands = await this.store.staleCandidates(['new', 'queued', 'published', 'needs_review', 'error'], today, seenBefore, 200);
    let n = 0;
    for (const c of cands) {
      if (c.dateLast && c.dateLast < today) await this.markInactive(c.id, 'дата завантаження минула', 'date', s);
      else await this.markInactive(c.id, `не видно в Della понад ${s.staleHours} год`, 'stale', s);
      n++;
    }
    if (n) await this.log('info', `Неактуальні: ${n}`);
    const purged = await this.store.purgeArchive(this.now() - ARCHIVE_DAYS * 86400e3);
    if (purged) await this.log('info', `Архів: видалено назавжди ${purged} заявок, старших за ${ARCHIVE_DAYS} днів`);
    return n;
  }

  /**
   * Добір зняття з Lardi: неактуальні й чорні заявки з живими публікаціями (попереднє зняття впало — 503, мережа).
   * Не більше limit публікацій за прохід, пакетами по акаунтах; акаунт зі збоєм у цьому проході далі не чіпаємо.
   * Знята публікація стає removed — повторно не знімається.
   */
  async sweepLardi(s, limit = SWEEP_LIMIT) {
    // заявок беремо із запасом: публікації акаунтів без токена пропускаються й не мають забирати ліміт
    const rows = await this.store.pendingRemovals(limit * 10);
    const byAcc = new Map(); // account → [[loadId, lardiId]]
    const seen = new Set();
    for (const r of rows) {
      for (const e of r.lardi) {
        if (seen.size >= limit) break;
        const k = `${e.account}:${e.id}`;
        if (!e.id || e.status !== 'published' || seen.has(k) || !this.clientFor(s, e.account)) continue;
        seen.add(k);
        (byAcc.get(e.account) || byAcc.set(e.account, []).get(e.account)).push([r.id, e.id]);
      }
    }
    if (!seen.size) return { removed: 0, failed: 0 };
    const res = new Map(); // `${loadId}:${account}` → null (знято) | помилка
    let removed = 0; let failed = 0;
    for (const [acc, pairs] of byAcc) {
      const client = this.clientFor(s, acc);
      for (let i = 0; i < pairs.length; i += 50) {
        const part = pairs.slice(i, i + 50);
        try {
          await client.throwToBasket(part.map((x) => x[1]));
          for (const [id] of part) res.set(`${id}:${acc}`, null);
          removed += part.length;
        } catch (err) {
          for (const [id] of pairs.slice(i)) res.set(`${id}:${acc}`, err.message);
          failed += pairs.length - i;
          await this.log('error', `Добір зняття: «${this.accName(s, acc)}» — не вдалося зняти ${pairs.length - i}: ${err.message}`);
          break;
        }
      }
    }
    const now = this.now();
    for (const id of new Set([...res.keys()].map((k) => k.slice(0, k.lastIndexOf(':'))))) {
      await this.store.updateLoad(id, (l) => ({
        ...l,
        lardi: (l.lardi || []).map((e) => {
          const k = `${id}:${e.account}`;
          if (e.status !== 'published' || !res.has(k)) return e;
          return res.get(k) === null ? { ...e, status: 'removed', removedAt: now, error: undefined } : { ...e, error: res.get(k) };
        }),
      }));
    }
    if (removed) await this.log('info', `Добір зняття з Lardi: знято ${removed}${failed ? `, лишилось ${failed}` : ''}`);
    return { removed, failed };
  }

  // ---------- RPC ----------

  async rpc(method, p = {}) {
    const h = this.handlers[method];
    if (!h) throw new Error(`невідомий метод ${method}`);
    await this.ready();
    return h.call(this, p || {});
  }

  // ---------- чорний / білий список ----------

  /** Ключі й підпис замовника з параметрів RPC: {loadId} | {keys[]} | {text} | {phone, edrpou, name, dellaId}. */
  async resolveCustomer(p = {}) {
    if (p.loadId) {
      const l = await this.store.getLoad(p.loadId);
      if (!l) throw new Error('заявку не знайдено');
      const keys = customerKeys(l);
      if (!keys.length) throw new Error('Немає даних про замовника — впишіть телефон або компанію в редагуванні заявки');
      return { keys, label: l.company || l.phone || l.edrpou || keys[0] };
    }
    if (Array.isArray(p.keys) && p.keys.length) {
      const keys = p.keys.map(String).filter((k) => /^(della|edrpou|tel|name):.+/.test(k));
      if (!keys.length) throw new Error('невірні ключі');
      return { keys, label: p.label || keys[0].replace(/^\w+:/, '') };
    }
    const f = p.text !== undefined ? parseCustomerInput(p.text) : { phone: p.phone, edrpou: p.edrpou, name: p.name, dellaId: p.dellaId };
    const keys = customerKeys(f);
    if (!keys.length) throw new Error('Вкажіть телефон (0XX XXX XX XX), ЄДРПОУ (8 цифр) або назву компанії (від 4 літер)');
    return { keys, label: f.name || f.phone || f.edrpou || f.dellaId };
  }

  /** Чорний список: зняти з Lardi живі публікації й приховати заявки. Повторно не знімає вже знятих. */
  async applyBlack(keys, s) {
    let hidden = 0; let removed = 0; let failed = 0;
    for (const r of await this.store.loadsByKeys(keys)) {
      const live = r.lardi.filter((e) => e.id && e.status === 'published');
      if (live.length) {
        const after = await this.removeFromLardi(r.id, s);
        for (const e of (after && after.lardi) || []) {
          if (!live.some((x) => x.account === e.account)) continue;
          if (e.status === 'removed') removed++; else failed++;
        }
      }
      let changed = false;
      await this.store.updateLoad(r.id, (l) => {
        if (l.status === 'deleted' || (l.status === 'inactive' && l.inactiveKind === 'blacklist')) return null;
        changed = true;
        return { ...l, status: 'inactive', inactiveKind: 'blacklist', statusReason: BLACK_REASON, queuedAt: null, updatedAt: this.now() };
      });
      if (changed) hidden++;
    }
    return { hidden, removed, failed };
  }

  /** Після зняття з чорного списку: актуальні — у new (+ черга), минулі — лишаються в архіві. */
  async restoreUnblocked(s) {
    const today = kyivDay(this.now());
    let restored = 0; let archived = 0;
    for (const id of await this.store.unblockedIds()) {
      const l = await this.store.updateLoad(id, (x) => {
        const last = x.dateTo || x.dateFrom;
        if (last && last < today) return { ...x, inactiveKind: 'date', statusReason: 'дата завантаження минула', updatedAt: this.now() };
        const next = { ...x, status: 'new', statusReason: 'замовника прибрано з чорного списку', lardi: (x.lardi || []).filter((e) => e.status !== 'removed'), updatedAt: this.now() };
        delete next.inactiveKind;
        return next;
      });
      if (!l) continue;
      if (l.status === 'new') {
        restored++;
        if (s.lardi.autoPublish) await this.enqueue(id, false);
      } else archived++;
    }
    return { restored, archived };
  }

  async afterListChange(customer, prevList, s) {
    if (customer.list === 'black') {
      const a = await this.applyBlack(customer.keys, s);
      await this.log('info', `Чорний список: «${customer.label || customer.keys[0]}» — приховано ${a.hidden}, знято з Lardi ${a.removed}${a.failed ? `, не вдалося зняти ${a.failed}` : ''}`);
      return a;
    }
    const a = prevList === 'black' ? await this.restoreUnblocked(s) : { restored: 0 };
    await this.log('info', `Обрані: «${customer.label || customer.keys[0]}»${a.restored ? `, повернуто з чорного списку ${a.restored}` : ''}`);
    return a;
  }
}

Engine.prototype.handlers = {
  async ping() { return { version: VERSION }; },

  async 'loads.list'(p) { return this.store.listLoads(p); },

  async 'loads.update'({ id, patch } = {}) {
    if (!id) throw new Error('id обовʼязковий');
    const s = await this.getSettings();
    const cur = await this.store.getLoad(id);
    if (!cur) throw new Error('заявку не знайдено');
    let next = await this.store.updateLoad(id, (l) => applyPatch(l, patch || {}, this.now()));
    // правка телефону/компанії/ЄДРПОУ могла ввести заявку в чорний список або вивести з нього
    const black = await this.isBlackLoad(next);
    if (black) {
      if (patch && patch.status === 'queued') throw new Error('замовник у чорному списку');
      await this.markInactive(id, BLACK_REASON, 'blacklist', s);
      return this.store.getLoad(id);
    }
    if (next.status === 'inactive' && next.inactiveKind === 'blacklist' && !(patch && patch.status)) {
      await this.store.updateLoad(id, (l) => {
        const x = { ...l, status: 'new', statusReason: 'замовника прибрано з чорного списку', lardi: (l.lardi || []).filter((e) => e.status !== 'removed'), updatedAt: this.now() };
        delete x.inactiveKind;
        return x;
      });
      if (s.lardi.autoPublish) await this.enqueue(id, false);
    }
    if (patch && patch.status === 'inactive') await this.markInactive(id, 'знято вручну', 'manual', s);
    else if (patch && patch.status === 'queued') await this.enqueue(id, true);
    next = await this.store.getLoad(id);
    const live = (next.lardi || []).filter((e) => e.id && e.status === 'published');
    if (live.length && !s.lardi.dryRun) {
      for (const e of live) {
        const client = this.clientFor(s, e.account);
        if (!client) continue;
        try {
          await client.updateCargo(e.id, next, s);
          next = await this.store.updateLoad(id, (l) => upsertLardiEntry(l, { account: e.account, error: undefined, updatedOnLardiAt: this.now() }));
          await this.log('info', `Оновлено на Lardi (id ${e.id}): ${describe(next)}`);
        } catch (err) {
          next = await this.store.updateLoad(id, (l) => upsertLardiEntry(l, { account: e.account, error: 'оновлення: ' + err.message }));
          await this.log('error', `Не вдалося оновити на Lardi (id ${e.id}): ${err.message}`);
        }
      }
    } else if (next.status === 'needs_review') {
      await this.enqueue(id, true);
      next = await this.store.getLoad(id);
    }
    return next;
  },

  async 'loads.delete'({ id, fromLardi = true } = {}) {
    if (!id) throw new Error('id обовʼязковий');
    const s = await this.getSettings();
    if (fromLardi) await this.removeFromLardi(id, s);
    const l = await this.store.updateLoad(id, (x) => ({ ...x, status: 'deleted', statusReason: 'видалено вручну', updatedAt: this.now() }));
    if (!l) throw new Error('заявку не знайдено');
    return { ok: true };
  },

  async 'loads.publish'({ id } = {}) {
    if (!id) throw new Error('id обовʼязковий');
    const l = await this.enqueue(id, true);
    if (!l) throw new Error('заявку не знайдено');
    this.waitUntil(this.runCycle({ skipPoll: true }));
    return this.store.getLoad(id);
  },

  async 'loads.unpublish'({ id } = {}) {
    if (!id) throw new Error('id обовʼязковий');
    const s = await this.getSettings();
    await this.removeFromLardi(id, s);
    const l = await this.store.updateLoad(id, (x) => ({ ...x, status: 'inactive', inactiveKind: 'manual', statusReason: 'знято вручну', updatedAt: this.now() }));
    if (!l) throw new Error('заявку не знайдено');
    return l;
  },

  /** Зупинити все: вимкнути автопублікацію, очистити чергу; remove — ще й зняти всі публікації з Lardi. */
  async 'lardi.stopAll'({ remove = false } = {}) {
    await this.setSettings({ lardi: { autoPublish: false } });
    const now = this.now();
    let dequeued = 0;
    for (const q of await this.store.queuedLight(100000, { withBlack: true })) {
      const l = await this.store.updateLoad(q.id, (x) => (x.status !== 'queued' ? null : {
        ...x, status: (x.lardi || []).some((e) => e.status === 'published') ? 'published' : 'new',
        statusReason: 'публікацію зупинено', queuedAt: null, updatedAt: now,
      }));
      if (l && l.statusReason === 'публікацію зупинено') dequeued++;
    }
    await this.log('info', `Публікацію зупинено вручну, знято з черги: ${dequeued}`);
    if (!remove) return { dequeued, removed: 0, failed: 0 };

    const s = await this.getSettings();
    const rows = await this.store.publishedLight();
    const byAcc = new Map(); // account → [[loadId, lardiId]]
    for (const r of rows) for (const e of r.lardi) {
      if (e.id && e.status === 'published') (byAcc.get(e.account) || byAcc.set(e.account, []).get(e.account)).push([r.id, e.id]);
    }
    const ok = new Set(); // `${loadId}:${account}`
    let failed = 0;
    for (const [acc, pairs] of byAcc) {
      const client = this.clientFor(s, acc);
      if (!client) { failed += pairs.length; await this.log('error', `Немає токена акаунта «${this.accName(s, acc)}» — ${pairs.length} заявок не знято`); continue; }
      for (let i = 0; i < pairs.length; i += 50) {
        const part = pairs.slice(i, i + 50);
        try {
          await client.throwToBasket(part.map((x) => x[1]));
          for (const [id] of part) ok.add(`${id}:${acc}`);
        } catch (err) {
          failed += part.length;
          await this.log('error', `Не вдалося зняти з Lardi пакет із ${part.length}: ${err.message}`);
        }
      }
    }
    let removed = 0;
    for (const r of rows) {
      const hit = r.lardi.some((e) => ok.has(`${r.id}:${e.account}`));
      if (!hit) continue;
      removed++;
      await this.store.updateLoad(r.id, (l) => {
        const lardi = (l.lardi || []).map((e) => (ok.has(`${l.id}:${e.account}`) && e.status === 'published'
          ? { ...e, status: 'removed', removedAt: now, error: undefined } : e));
        const still = lardi.some((e) => e.status === 'published');
        return { ...l, lardi, ...(still || l.status === 'deleted' ? {} : { status: 'inactive', inactiveKind: 'manual', statusReason: 'знято вручну (усі)' }), updatedAt: now };
      });
    }
    await this.log('info', `Знято з Lardi всі публікації: ${removed} заявок${failed ? `, помилок: ${failed}` : ''}`);
    return { dequeued, removed, failed };
  },

  async 'lardi.resume'() {
    await this.setSettings({ lardi: { autoPublish: true } });
    await this.log('info', 'Автопублікацію відновлено вручну');
    this.waitUntil(this.runCycle({ forcePoll: true }));
    return { ok: true };
  },

  async 'settings.get'() { return maskSettings(await this.getSettings()); },
  async 'settings.set'(p) { return this.setSettings(p || {}); },
  async 'status.get'() { return this.getStatus(); },

  async 'sync.now'() {
    this.waitUntil(this.runCycle({ forcePoll: true }));
    return { started: true };
  },

  /** Перевірити токен (збережений або переданий, не зберігаючи). Для збереженого — оновлює стан акаунта. */
  async 'lardi.test'({ accountIndex = 0, token } = {}) {
    return this.checkAccount(Number(accountIndex) || 0, token && !isMasked(token) ? String(token).trim() : undefined);
  },

  /** Статистика по кожному акаунту: [{index,name,enabled,state,hasToken,today,live,errors,lastPublishAt,lastError}] */
  async 'lardi.accounts'() { return this.accountsStats(); },

  /**
   * Догін нового акаунта: поставити в чергу актуальні опубліковані заявки, яких на ньому ще немає
   * (не з чорного списку, обрані першими, не більше залишку добового ліміту). Лише в режимі «на всі акаунти».
   */
  async 'lardi.backfill'({ accountIndex, dryRunOnly = false } = {}) {
    const i = Number(accountIndex);
    const s = await this.getSettings();
    const acc = s.lardi.accounts[i];
    if (!acc) throw new Error('акаунт не знайдено');
    if (accountState(acc) !== 'ok') throw new Error('акаунт не підключено або вимкнено — спершу збережіть і перевірте токен');
    if (s.lardi.mode === 'roundrobin') throw new Error('догін працює лише в режимі «На всі акаунти»');
    const today = kyivDay(this.now());
    const counts = await this.getToday(s.lardi.accounts.length);
    const room = s.lardi.dailyLimit ? Math.max(0, s.lardi.dailyLimit - (counts.published[i] || 0) - (counts.dry[i] || 0)) : Infinity;
    const cands = (await this.store.backfillCandidates(i, today)).slice(0, room);
    if (dryRunOnly) return { candidates: cands.length };
    const now = this.now();
    let queued = 0;
    for (const id of cands) {
      const l = await this.store.updateLoad(id, (x) => (x.status !== 'published' ? null : { ...x, status: 'queued', statusReason: `догін на «${acc.name}»`, queuedAt: now, updatedAt: now }));
      if (l && l.status === 'queued') queued++;
    }
    await this.log('info', `Догін «${acc.name}»: поставлено в чергу ${queued} актуальних заявок`);
    if (queued) this.waitUntil(this.runCycle({ skipPoll: true }));
    return { queued };
  },

  // ---------- замовники ----------

  async 'customers.list'({ list } = {}) {
    const l = list === 'black' || list === 'white' ? list : undefined;
    return { items: await this.store.listCustomers(l), hiddenBlack: await this.store.hiddenBlackCount() };
  },

  /** Лише читання — для діалогу підтвердження. */
  async 'customers.preview'(p = {}) {
    const { keys, label } = await this.resolveCustomer(p);
    const s = await this.getSettings();
    const rows = await this.store.loadsByKeys(keys);
    const live = {};
    let liveTotal = 0;
    for (const r of rows) {
      for (const e of r.lardi) {
        if (!e.id || e.status !== 'published') continue;
        const n = this.accName(s, e.account);
        live[n] = (live[n] || 0) + 1;
        liveTotal++;
      }
    }
    const hits = await this.store.customersByKeys(keys);
    return {
      label, keys, weak: weakKeys(keys),
      loads: rows.length,
      queued: rows.filter((r) => r.status === 'queued').length,
      live, liveTotal,
      list: hits.some((h) => h.list === 'black') ? 'black' : hits.some((h) => h.list === 'white') ? 'white' : null,
      customerId: hits.length ? hits[0].customerId : null,
    };
  },

  async 'customers.add'(p = {}) {
    const list = p.list === 'black' ? 'black' : p.list === 'white' ? 'white' : null;
    if (!list) throw new Error('list: black або white');
    const { keys, label } = await this.resolveCustomer(p);
    const s = await this.getSettings();
    const prevLists = await this.store.customersByKeys(keys);
    const prevList = prevLists.some((h) => h.list === 'black') ? 'black' : null;
    const { customer } = await this.store.upsertCustomer(list, keys, { label: p.label, fallbackLabel: label, note: p.note });
    const affected = await this.afterListChange(customer, prevList, s);
    return { customer, affected };
  },

  async 'customers.move'({ id, list } = {}) {
    if (list !== 'black' && list !== 'white') throw new Error('list: black або white');
    const cur = await this.store.getCustomer(id);
    if (!cur) throw new Error('замовника не знайдено');
    const s = await this.getSettings();
    const customer = await this.store.setCustomerList(cur.id, list);
    const affected = await this.afterListChange(customer, cur.list, s);
    return { customer, affected };
  },

  async 'customers.update'({ id, label, note } = {}) {
    const c = await this.store.updateCustomer(id, { label, note });
    if (!c) throw new Error('замовника не знайдено');
    return c;
  },

  async 'customers.remove'({ id } = {}) {
    const c = await this.store.removeCustomer(id);
    if (!c) throw new Error('замовника не знайдено');
    const s = await this.getSettings();
    const r = c.list === 'black' ? await this.restoreUnblocked(s) : { restored: 0, archived: 0 };
    await this.log('info', `${c.list === 'black' ? 'Чорний список' : 'Обрані'}: прибрано «${c.label || c.keys[0]}»${r.restored ? `, повернуто заявок ${r.restored}` : ''}`);
    return r;
  },

  async 'log.list'({ limit = 200 } = {}) { return this.store.listLog(Math.min(2000, Number(limit) || 200)); },
};
