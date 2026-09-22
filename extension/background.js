// IntDeliv — service worker: сбор Della → база → очередь публикации на Lardi.
import { parseDellaSearchWithIds, buildPageUrl } from './lib/della.js';
import { applyFilters, isDatePassed, todayIso } from './lib/filters.js';
import { LardiClient, NeedsReviewError } from './lib/lardi.js';
import * as db from './lib/db.js';
import {
  STATUSES, applyPatch, maskToken, isMasked, accountsNeeded, upsertLardiEntry, describe,
} from './lib/model.js';

const VERSION = chrome.runtime.getManifest().version;
const ADMIN_URL = 'https://intdeliv.siteboosty.com/';

export const DEFAULT_SEARCH_URL = 'https://della.com.ua/search/a204bd204eflolz1z21z3z4z51z6z7z8z9y1y2y3y4y5y6h0ilk0m1.html';

export const DEFAULT_SETTINGS = {
  della: { searchUrls: [DEFAULT_SEARCH_URL], pollSeconds: 90, pagesPerPoll: 4 },
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

// ---------------- settings ----------------

const clone = (o) => JSON.parse(JSON.stringify(o));

function mergeDefaults(s) {
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

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeDefaults(settings);
}

function maskSettings(s) {
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

async function setSettings(patch = {}) {
  const cur = await getSettings();
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

  await chrome.storage.local.set({ settings: next });
  if (next.della.pollSeconds !== cur.della.pollSeconds) await ensureAlarms(true);
  if (next.lardi.dryRun !== cur.lardi.dryRun) {
    await log('info', next.lardi.dryRun ? 'Увімкнено DRY RUN — на Lardi нічого не публікується' : 'DRY RUN вимкнено — публікація на Lardi увімкнена');
  }
  broadcast('status', await getStatus());
  return maskSettings(next);
}

// ---------------- log / events ----------------

async function log(level, msg) {
  try {
    await db.addLog(level, msg);
  } catch (e) {
    console.warn('log failed', e);
  }
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)('[IntDeliv]', msg);
}

const ports = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'intdeliv-bridge') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
});

function broadcast(type, data) {
  for (const p of ports) {
    try { p.postMessage({ __intdeliv: 'event', type, data }); } catch { ports.delete(p); }
  }
}

let changedTimer = null;
function notifyChanged(ids) {
  clearTimeout(changedTimer);
  changedTimer = setTimeout(async () => {
    broadcast('loads.changed', { ids: ids || null });
    broadcast('status', await getStatus().catch(() => null));
  }, 200);
}

// ---------------- stats ----------------

async function getToday() {
  const t = await db.getMeta('today', null);
  const date = todayIso();
  if (!t || t.date !== date) return { date, collected: 0, published: [0, 0], dry: [0, 0] };
  return { published: [0, 0], dry: [0, 0], ...t };
}

async function bumpToday(fn) {
  const t = await getToday();
  fn(t);
  await db.setMeta('today', t);
  return t;
}

async function getStatus() {
  const [counts, today, lastPollAt, lastError, lastPollOkAt] = await Promise.all([
    db.countByStatus(STATUSES),
    getToday(),
    db.getMeta('lastPollAt'),
    db.getMeta('lastError'),
    db.getMeta('lastPollOkAt'),
  ]);
  const s = await getSettings();
  const alarm = await chrome.alarms.get('poll');
  return {
    running: !!alarm,
    polling,
    publishing,
    lastPollAt,
    lastPollOkAt,
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

// ---------------- alarms ----------------

async function ensureAlarms(reset = false) {
  const s = await getSettings();
  const period = Math.max(0.5, s.della.pollSeconds / 60);
  const poll = await chrome.alarms.get('poll');
  if (reset || !poll || Math.abs((poll.periodInMinutes || 0) - period) > 0.01) {
    await chrome.alarms.create('poll', { periodInMinutes: period, delayInMinutes: reset ? period : 0.5 });
  }
  if (!(await chrome.alarms.get('publish'))) await chrome.alarms.create('publish', { periodInMinutes: 0.5 });
  if (!(await chrome.alarms.get('stale'))) await chrome.alarms.create('stale', { periodInMinutes: 10 });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'poll') poll().catch((e) => log('error', 'Збір: ' + e.message));
  else if (a.name === 'publish') publishTick().catch((e) => log('error', 'Публікація: ' + e.message));
  else if (a.name === 'stale') staleCheck().catch((e) => log('error', 'Перевірка актуальності: ' + e.message));
});

chrome.runtime.onInstalled.addListener(async (d) => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: clone(DEFAULT_SETTINGS) });
  await ensureAlarms(true);
  await log('info', `Розширення ${d.reason === 'install' ? 'встановлено' : 'оновлено'} (v${VERSION}). DRY RUN за замовчуванням увімкнено.`);
  poll().catch((e) => log('error', 'Збір: ' + e.message));
});
chrome.runtime.onStartup.addListener(() => { ensureAlarms().catch(() => {}); });
ensureAlarms().catch(() => {});

// ---------------- poll Della ----------------

let polling = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchDella(url) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'uk-UA,uk;q=0.9' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Della ${res.status} для ${url}`);
  return res.text();
}

async function poll() {
  if (polling) return;
  polling = true;
  broadcast('status', await getStatus().catch(() => null));
  const s = await getSettings();
  const now = Date.now();
  let seen = 0; let inserted = 0; let filtered = 0; let errors = 0;
  const reasons = {};
  const changedIds = [];
  try {
    for (const searchUrl of s.della.searchUrls) {
      for (let page = 0; page < s.della.pagesPerPoll; page++) {
        const url = buildPageUrl(searchUrl, page);
        let html;
        try {
          html = await fetchDella(url);
        } catch (e) {
          errors++;
          await log('warn', e.message);
          break;
        }
        const parsed = await parseDellaSearchWithIds(html, { url, now: new Date() });
        if (!parsed.length) {
          if (page === 0 && !/request_card|search_result/.test(html)) {
            await log('warn', `Della: карток не знайдено (${url}) — можливо, змінилась верстка або капча`);
          }
          break;
        }
        seen += parsed.length;
        const verdict = new Map();
        for (const p of parsed) verdict.set(p.id, applyFilters(p, s.filters, new Date()));
        const res = await db.upsertSeen(parsed, (p) => verdict.get(p.id).pass, now);
        for (const p of parsed) {
          const v = verdict.get(p.id);
          if (!v.pass && !res.updated.some((u) => u.after.id === p.id)) {
            filtered++;
            const key = v.reason.replace(/\d+/g, 'N');
            reasons[key] = (reasons[key] || 0) + 1;
          }
        }
        inserted += res.inserted.length;
        changedIds.push(...res.inserted.map((l) => l.id));
        // заявки, которые пропали/удалены на Della или ожили — обработать
        for (const u of res.updated) {
          if (u.after.dellaDeleted && !u.before.dellaDeleted) {
            await markInactive(u.after.id, 'видалена на Della', 'deleted_on_della', s);
            changedIds.push(u.after.id);
          } else if (u.before.status !== u.after.status) {
            changedIds.push(u.after.id);
          }
        }
        if (s.lardi.autoPublish) {
          const toQueue = [...res.inserted, ...res.updated.filter((u) => u.after.status === 'new' && u.before.status === 'inactive').map((u) => u.after)];
          for (const l of toQueue) await enqueue(l.id, false);
        }
        if (parsed.length < 25) break;
        await sleep(1200 + Math.random() * 800);
      }
    }
    await db.setMeta('lastPollAt', Date.now());
    if (!errors) {
      await db.setMeta('lastPollOkAt', now);
      await db.setMeta('lastError', null);
    } else {
      await db.setMeta('lastError', `Помилки завантаження Della: ${errors}`);
    }
    if (inserted) await bumpToday((t) => { t.collected += inserted; });
    const rs = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join('; ');
    await log('info', `Збір: переглянуто ${seen}, нових ${inserted}, відфільтровано ${filtered}${rs ? ` (${rs})` : ''}`);
  } catch (e) {
    await db.setMeta('lastError', e.message);
    await log('error', 'Збір: ' + e.message);
  } finally {
    polling = false;
    notifyChanged(changedIds);
  }
  if (inserted && s.lardi.autoPublish) publishTick().catch(() => {});
}

// ---------------- queue / publish ----------------

let publishing = false;

async function enqueue(id, manual) {
  return db.updateLoad(id, (l) => {
    if (['deleted'].includes(l.status)) return null;
    if (!manual && l.status !== 'new') return null;
    return {
      ...l,
      status: 'queued',
      statusReason: manual ? 'поставлено в чергу вручну' : undefined,
      lardi: (l.lardi || []).filter((e) => e.status !== 'error' && e.status !== 'removed'),
      queuedAt: Date.now(),
      updatedAt: Date.now(),
    };
  });
}

function clientFor(settings, accountIndex) {
  const acc = settings.lardi.accounts[accountIndex];
  if (!acc || !acc.token) return null;
  return new LardiClient({ token: acc.token, cache: db.cache });
}

/** Любой клиент с токеном — для dry-run сопоставления городов. */
function anyClient(settings, prefer) {
  return clientFor(settings, prefer) || settings.lardi.accounts.map((_, i) => clientFor(settings, i)).find(Boolean) || null;
}

async function publishTick() {
  if (publishing) return;
  publishing = true;
  try {
    const deadline = Date.now() + 25000;
    for (;;) {
      const s = await getSettings();
      const queued = (await db.loadsByStatus('queued'))
        .filter((l) => !isDatePassed(l))
        .sort((a, b) => (a.queuedAt || a.updatedAt) - (b.queuedAt || b.updatedAt));
      if (!queued.length) break;
      const today = await getToday();
      const lastAt = (await db.getMeta('lastPublishAt', {})) || {};
      const rr = (await db.getMeta('rrPointer', 0)) || 0;
      const intervalMs = s.lardi.intervalSeconds * 1000;
      const dry = s.lardi.dryRun;

      // ищем первую пару (заявка, аккаунт), которую можно сделать сейчас или раньше дедлайна
      let best = null;
      for (const l of queued) {
        const accs = accountsNeeded(l, s, rr);
        if (!accs.length) {
          if (!dry) {
            // все аккаунты уже опубликованы — финализируем статус
            await db.updateLoad(l.id, (x) => ({ ...x, status: (x.lardi || []).some((e) => e.status === 'published') ? 'published' : x.status, updatedAt: Date.now() }));
          }
          continue;
        }
        for (const a of accs) {
          const used = (today.published[a] || 0) + (today.dry[a] || 0);
          if (s.lardi.dailyLimit && used >= s.lardi.dailyLimit) continue;
          const at = Math.max(Date.now(), (lastAt[a] || 0) + intervalMs);
          if (!best || at < best.at) best = { load: l, account: a, at };
        }
        if (best && best.at <= Date.now()) break;
      }
      if (!best || best.at > deadline) break;
      if (best.at > Date.now()) await sleep(best.at - Date.now());
      await publishOne(best.load.id, best.account, s);
      lastAt[best.account] = Date.now();
      await db.setMeta('lastPublishAt', lastAt);
      if (s.lardi.mode === 'roundrobin') await db.setMeta('rrPointer', rr + 1);
      if (Date.now() > deadline) break;
    }
  } finally {
    publishing = false;
  }
}

async function publishOne(id, account, s) {
  const load = await db.getLoad(id);
  if (!load || load.status !== 'queued') return;
  const accName = (s.lardi.accounts[account] && s.lardi.accounts[account].name) || `#${account + 1}`;
  const dry = s.lardi.dryRun;

  if (dry) {
    let reason;
    const client = anyClient(s, account);
    if (client) {
      try {
        await client.prepareCargo(load, s);
      } catch (e) {
        if (e instanceof NeedsReviewError || e.needsReview) reason = e.message;
        else await log('warn', `DRY RUN: не вдалося перевірити на Lardi (${e.message})`);
      }
    }
    if (reason) {
      await db.updateLoad(id, (l) => ({ ...l, status: 'needs_review', statusReason: reason, updatedAt: Date.now() }));
      await log('warn', `Потрібна перевірка: ${describe(load)} — ${reason}`);
    } else {
      await db.updateLoad(id, (l) => ({
        ...upsertLardiEntry(l, { account, status: 'dry', error: undefined }),
        statusReason: 'DRY RUN — буде опубліковано після вимкнення тестового режиму',
        updatedAt: Date.now(),
      }));
      await bumpToday((t) => { t.dry[account] = (t.dry[account] || 0) + 1; });
      await log('info', `DRY RUN: would publish → Lardi «${accName}»: ${describe(load)}`);
    }
    notifyChanged([id]);
    return;
  }

  const client = clientFor(s, account);
  if (!client) {
    await db.updateLoad(id, (l) => upsertLardiEntry(l, { account, status: 'error', error: 'немає токена' }));
    return;
  }
  try {
    const { id: lardiId } = await client.addCargo(load, s);
    await db.updateLoad(id, (l) => {
      const next = upsertLardiEntry(l, { account, id: lardiId, status: 'published', error: undefined, publishedAt: Date.now() });
      const remaining = accountsNeeded(next, s);
      return { ...next, status: remaining.length ? 'queued' : 'published', statusReason: undefined, updatedAt: Date.now() };
    });
    await bumpToday((t) => { t.published[account] = (t.published[account] || 0) + 1; });
    await log('info', `Опубліковано на Lardi «${accName}» (id ${lardiId}): ${describe(load)}`);
  } catch (e) {
    if (e instanceof NeedsReviewError || e.needsReview) {
      await db.updateLoad(id, (l) => ({ ...l, status: 'needs_review', statusReason: e.message, updatedAt: Date.now() }));
      await log('warn', `Потрібна перевірка: ${describe(load)} — ${e.message}`);
    } else {
      await db.updateLoad(id, (l) => {
        const next = upsertLardiEntry(l, { account, status: 'error', error: e.message });
        const anyLive = (next.lardi || []).some((x) => x.status === 'published');
        return { ...next, status: anyLive ? 'published' : 'error', statusReason: e.message, updatedAt: Date.now() };
      });
      await log('error', `Lardi «${accName}»: ${e.message} — ${describe(load)}`);
    }
  }
  notifyChanged([id]);
}

// ---------------- unpublish / stale ----------------

/** Снять опубликованные копии с Lardi. Возвращает обновлённую заявку. */
async function removeFromLardi(id, s) {
  const load = await db.getLoad(id);
  if (!load) return null;
  const live = (load.lardi || []).filter((e) => e.id && e.status === 'published');
  if (!live.length) {
    return db.updateLoad(id, (l) => ({ ...l, lardi: (l.lardi || []).map((e) => (e.status === 'dry' || e.status === 'queued' ? { ...e, status: 'removed' } : e)) }));
  }
  if (s.lardi.dryRun) {
    await log('info', `DRY RUN: would remove from Lardi: ${describe(load)}`);
    return load;
  }
  const results = {};
  for (const e of live) {
    const client = clientFor(s, e.account);
    if (!client) { results[e.account] = 'немає токена'; continue; }
    try {
      await client.throwToBasket([e.id]);
      results[e.account] = null;
    } catch (err) {
      results[e.account] = err.message;
      await log('error', `Не вдалося зняти з Lardi (id ${e.id}): ${err.message}`);
    }
  }
  const updated = await db.updateLoad(id, (l) => ({
    ...l,
    lardi: (l.lardi || []).map((e) => {
      if (!(e.account in results)) return e;
      return results[e.account] === null ? { ...e, status: 'removed', removedAt: Date.now(), error: undefined } : { ...e, error: results[e.account] };
    }),
    updatedAt: Date.now(),
  }));
  const ok = Object.values(results).filter((v) => v === null).length;
  if (ok) await log('info', `Знято з Lardi (${ok}): ${describe(load)}`);
  return updated;
}

async function markInactive(id, reason, kind, s) {
  const updated = await db.updateLoad(id, (l) => {
    if (l.status === 'deleted' || l.status === 'inactive') return null;
    return { ...l, status: 'inactive', statusReason: reason, inactiveKind: kind, updatedAt: Date.now() };
  });
  if (updated && updated.status === 'inactive') await removeFromLardi(id, s);
  return updated;
}

async function staleCheck() {
  const s = await getSettings();
  const lastOk = await db.getMeta('lastPollOkAt', 0);
  const staleMs = s.staleHours * 3600e3;
  const changed = [];
  for (const st of ['new', 'queued', 'published', 'needs_review', 'error']) {
    for (const l of await db.loadsByStatus(st)) {
      if (isDatePassed(l)) {
        await markInactive(l.id, 'дата завантаження минула', 'date', s);
        changed.push(l.id);
      } else if (lastOk && lastOk - l.seenAt > staleMs) {
        // только если сбор реально шёл и заявку не видел — иначе браузер просто был выключен
        await markInactive(l.id, `не видно в Della понад ${s.staleHours} год`, 'stale', s);
        changed.push(l.id);
      }
    }
  }
  if (changed.length) {
    await log('info', `Неактуальні: ${changed.length}`);
    notifyChanged(changed);
  }
}

// ---------------- bridge methods ----------------

function matchesQuery(l, p) {
  const has = (v, q) => String(v || '').toLowerCase().includes(String(q).toLowerCase().trim());
  if (p.fromCity && !has(l.fromCity, p.fromCity)) return false;
  if (p.toCity && !has(l.toCity, p.toCity)) return false;
  if (p.fromRegion && !has(l.fromRegion, p.fromRegion)) return false;
  if (p.toRegion && !has(l.toRegion, p.toRegion)) return false;
  if (p.status && p.status !== 'all') {
    const sts = Array.isArray(p.status) ? p.status : [p.status];
    if (!sts.includes(l.status)) return false;
  } else if (l.status === 'deleted') return false;
  if (p.q) {
    const q = String(p.q).toLowerCase().trim();
    const digits = q.replace(/\D/g, '');
    const hay = [l.id, l.cargo, l.company, l.phone, l.fromCity, l.toCity, l.dellaRequestId,
      ...(l.lardi || []).map((e) => e.id)].join(' ').toLowerCase();
    const phoneDigits = String(l.phone || '').replace(/\D/g, '');
    if (!hay.includes(q) && !(digits.length >= 4 && phoneDigits.includes(digits))) return false;
  }
  return true;
}

const handlers = {
  async ping() { return { version: VERSION }; },

  async 'loads.list'(p = {}) {
    const limit = Math.min(5000, Math.max(1, Number(p.limit) || 500));
    const offset = Math.max(0, Number(p.offset) || 0);
    return db.listLoads((l) => matchesQuery(l, p), { limit, offset });
  },

  async 'loads.update'({ id, patch } = {}) {
    if (!id) throw new Error('id обовʼязковий');
    const s = await getSettings();
    const cur = await db.getLoad(id);
    if (!cur) throw new Error('заявку не знайдено');
    let next = await db.updateLoad(id, (l) => applyPatch(l, patch || {}));
    if (patch && patch.status === 'inactive') {
      await markInactive(id, 'знято вручну', 'manual', s);
    } else if (patch && patch.status === 'queued') {
      await enqueue(id, true);
    }
    next = await db.getLoad(id);
    // если опубликована — PUT на Lardi
    const live = (next.lardi || []).filter((e) => e.id && e.status === 'published');
    if (live.length && !s.lardi.dryRun) {
      for (const e of live) {
        const client = clientFor(s, e.account);
        if (!client) continue;
        try {
          await client.updateCargo(e.id, next, s);
          next = await db.updateLoad(id, (l) => upsertLardiEntry(l, { account: e.account, error: undefined, updatedOnLardiAt: Date.now() }));
          await log('info', `Оновлено на Lardi (id ${e.id}): ${describe(next)}`);
        } catch (err) {
          next = await db.updateLoad(id, (l) => upsertLardiEntry(l, { account: e.account, error: 'оновлення: ' + err.message }));
          await log('error', `Не вдалося оновити на Lardi (id ${e.id}): ${err.message}`);
        }
      }
    } else if (next.status === 'needs_review') {
      // после правки — снова в очередь (город/кузов могли исправить)
      await enqueue(id, true);
      next = await db.getLoad(id);
    }
    notifyChanged([id]);
    return next;
  },

  async 'loads.delete'({ id, fromLardi = true } = {}) {
    if (!id) throw new Error('id обовʼязковий');
    const s = await getSettings();
    if (fromLardi) await removeFromLardi(id, s);
    await db.updateLoad(id, (l) => ({ ...l, status: 'deleted', statusReason: 'видалено вручну', updatedAt: Date.now() }));
    notifyChanged([id]);
    return { ok: true };
  },

  async 'loads.publish'({ id } = {}) {
    if (!id) throw new Error('id обовʼязковий');
    const l = await enqueue(id, true);
    if (!l) throw new Error('заявку не знайдено');
    notifyChanged([id]);
    publishTick().catch(() => {});
    return db.getLoad(id);
  },

  async 'loads.unpublish'({ id } = {}) {
    if (!id) throw new Error('id обовʼязковий');
    const s = await getSettings();
    await removeFromLardi(id, s);
    const l = await db.updateLoad(id, (x) => ({ ...x, status: 'inactive', inactiveKind: 'manual', statusReason: 'знято вручну', updatedAt: Date.now() }));
    if (!l) throw new Error('заявку не знайдено');
    notifyChanged([id]);
    return l;
  },

  async 'settings.get'() { return maskSettings(await getSettings()); },
  async 'settings.set'(p) { return setSettings(p || {}); },
  async 'status.get'() { return getStatus(); },

  async 'sync.now'() {
    poll().catch((e) => log('error', 'Збір: ' + e.message));
    return { started: true };
  },

  async 'lardi.test'({ accountIndex = 0, token } = {}) {
    const s = await getSettings();
    const acc = s.lardi.accounts[accountIndex];
    const tok = token && !isMasked(token) ? token : acc && acc.token;
    if (!tok) return { ok: false, error: 'токен не задано' };
    const r = await new LardiClient({ token: tok, cache: db.cache, maxRetries: 1 }).test();
    await log(r.ok ? 'info' : 'warn', `Перевірка токена «${(acc && acc.name) || accountIndex}»: ${r.ok ? r.name : r.error}`);
    return r;
  },

  async 'log.list'({ limit = 200 } = {}) { return db.listLog(Math.min(2000, Number(limit) || 200)); },

  async 'admin.open'() { await chrome.tabs.create({ url: ADMIN_URL }); return { ok: true }; },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.__intdeliv !== 'req' || typeof msg.method !== 'string') return false;
  if (sender && sender.id && sender.id !== chrome.runtime.id) return false;
  const h = handlers[msg.method];
  if (!h) {
    sendResponse({ ok: false, error: `невідомий метод ${msg.method}` });
    return false;
  }
  Promise.resolve()
    .then(() => h(msg.params || {}))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});
