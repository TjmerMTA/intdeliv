// IntDeliv — хмарний рушій: збір Della → D1 → черга публікації на Lardi.
// Порт extension/background.js без chrome.*: замість alarms — cron щохвилини, замість IndexedDB — D1.
import { parseDellaSearchWithIds, buildPageUrl } from '../../extension/lib/della.js';
import { applyFilters } from '../../extension/lib/filters.js';
import { LardiClient, NeedsReviewError } from '../../extension/lib/lardi.js';
import {
  STATUSES, applyPatch, maskToken, isMasked, accountsNeeded, upsertLardiEntry, describe,
} from '../../extension/lib/model.js';
import { Store } from './store.js';

export const VERSION = '1.1.0-worker';

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
  if (!Array.isArray(out.lardi.accounts)) out.lardi.accounts = d.lardi.accounts;
  if (!Array.isArray(out.della.searchUrls) || !out.della.searchUrls.length) out.della.searchUrls = d.della.searchUrls;
  return out;
}

export function maskSettings(s) {
  const m = clone(s);
  m.lardi.accounts = m.lardi.accounts.map((a) => ({ ...a, token: maskToken(a.token) }));
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
        next.lardi.accounts = p.accounts.map((a, i) => {
          const prev = cur.lardi.accounts[i] || {};
          let token = a && typeof a.token === 'string' ? a.token.trim() : undefined;
          if (token === undefined || isMasked(token)) token = prev.token || '';
          return {
            name: (a && a.name) || prev.name || `Акаунт ${i + 1}`,
            token,
            enabled: a && a.enabled !== undefined ? !!a.enabled : (prev.enabled ?? true),
          };
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
    if (next.lardi.dryRun !== cur.lardi.dryRun) {
      await this.log('info', next.lardi.dryRun ? 'Увімкнено DRY RUN — на Lardi нічого не публікується' : 'DRY RUN вимкнено — публікація на Lardi увімкнена');
    }
    return maskSettings(next);
  }

  // ---------- stats ----------

  async getToday(accountsCount = 2) {
    const c = await this.store.counters(kyivDay(this.now()));
    const n = Math.max(2, accountsCount);
    const arr = (p) => Array.from({ length: n }, (_, i) => c[`${p}:${i}`] || 0);
    return { date: kyivDay(this.now()), collected: c.collected || 0, published: arr('published'), dry: arr('dry') };
  }

  bump(key, by = 1) { return this.store.bump(kyivDay(this.now()), key, by); }

  async getStatus() {
    const s = await this.getSettings();
    const [counts, today, lastPollAt, lastError, lastPollOkAt, busy] = await Promise.all([
      this.store.countByStatus(STATUSES),
      this.getToday(s.lardi.accounts.length),
      this.store.getMeta('lastPollAt', null),
      this.store.getMeta('lastError', null),
      this.store.getMeta('lastPollOkAt', null),
      this.store.lockActive(),
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
      version: VERSION,
    };
  }

  // ---------- головний цикл (cron) ----------

  /**
   * Один запуск: збір (якщо настав час), публікація, перевірка актуальності.
   * @param {{forcePoll?: boolean, skipPoll?: boolean}} o
   */
  async runCycle(o = {}) {
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
    const res = await this.fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
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
      const verdict = new Map();
      for (const p of parsed) verdict.set(p.id, this.filterVerdict(p, s.filters));
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
        }
      }
      if (s.lardi.autoPublish) {
        const toQueue = [...res.inserted, ...res.updated.filter((u) => u.after.status === 'new' && u.before.status === 'inactive').map((u) => u.after)];
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

  async enqueue(id, manual) {
    const now = this.now();
    return this.store.updateLoad(id, (l) => {
      if (l.status === 'deleted') return null;
      if (!manual && l.status !== 'new') return null;
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
    const accName = (s.lardi.accounts[account] && s.lardi.accounts[account].name) || `#${account + 1}`;

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
    if (s.lardi.dryRun) {
      await this.log('info', `DRY RUN: would remove from Lardi: ${describe(load)}`);
      return load;
    }
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
    const cands = await this.store.staleCandidates(['new', 'queued', 'published', 'needs_review', 'error'], today, seenBefore, 200);
    let n = 0;
    for (const c of cands) {
      if (c.dateLast && c.dateLast < today) await this.markInactive(c.id, 'дата завантаження минула', 'date', s);
      else await this.markInactive(c.id, `не видно в Della понад ${s.staleHours} год`, 'stale', s);
      n++;
    }
    if (n) await this.log('info', `Неактуальні: ${n}`);
    return n;
  }

  // ---------- RPC ----------

  async rpc(method, p = {}) {
    const h = this.handlers[method];
    if (!h) throw new Error(`невідомий метод ${method}`);
    return h.call(this, p || {});
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

  async 'settings.get'() { return maskSettings(await this.getSettings()); },
  async 'settings.set'(p) { return this.setSettings(p || {}); },
  async 'status.get'() { return this.getStatus(); },

  async 'sync.now'() {
    this.waitUntil(this.runCycle({ forcePoll: true }));
    return { started: true };
  },

  async 'lardi.test'({ accountIndex = 0, token } = {}) {
    const s = await this.getSettings();
    const acc = s.lardi.accounts[accountIndex];
    const tok = token && !isMasked(token) ? token : acc && acc.token;
    if (!tok) return { ok: false, error: 'токен не задано' };
    const r = await new LardiClient({ token: tok, cache: this.store.cache, fetch: this.fetch, sleep: this.sleep, maxRetries: 1 }).test();
    await this.log(r.ok ? 'info' : 'warn', `Перевірка токена «${(acc && acc.name) || accountIndex}»: ${r.ok ? r.name : r.error}`);
    return r;
  },

  async 'log.list'({ limit = 200 } = {}) { return this.store.listLog(Math.min(2000, Number(limit) || 200)); },
};
