// IntDeliv — хмарний рушій: збір Della → D1 → черга публікації на Lardi.
// Порт extension/background.js без chrome.*: замість alarms — cron щохвилини, замість IndexedDB — D1.
import {
  parseDellaSearch, parseDellaSearchWithIds, buildPageUrl, dellaLoginState, contactsCalls, contactsBody, parseDellaContacts,
  CONTACTS_PATH, DELLA_ORIGIN,
} from '../../extension/lib/della.js';
import { applyFilters } from '../../extension/lib/filters.js';
import { LardiClient, NeedsReviewError } from '../../extension/lib/lardi.js';
import {
  STATUSES, applyPatch, isLocalPatch, maskToken, isMasked, accountsNeeded, upsertLardiEntry, describe,
  customerKeys, weakKeys, parseCustomerInput,
} from '../../extension/lib/model.js';
import { Store, MANUAL_QUEUE } from './store.js';

export const VERSION = '1.2.0-worker';

/** Відмова RPC з подробицями для адмінки: {ok:false, error, code, data} (worker/src/index.js). */
export class RpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
export const ARCHIVE_DAYS = 30;
export const MAX_ACCOUNTS = 5;
export const BLACK_REASON = 'чорний список';

export const DEFAULT_SEARCH_URL = 'https://della.com.ua/search/a204bd204eflolz1z21z3z4z51z6z7z8z9y1y2y3y4y5y6h0ilk0m1.html';
/**
 * Галочка «Лише прямий замовник» керує й прапорцем самої Della в адресі пошуку (`z21` — лише прямі, `z2` — усі).
 * Інакше вимкнена галочка нічого не дає: Della за адресою з `z21` непрямих замовників не віддає взагалі.
 * Увімкнена галочка адреси не змінює — непрямих відкидає наш фільтр (extension/lib/filters.js).
 */
export function dellaSearchUrl(url, directOnly) {
  return directOnly ? url : String(url).replace(/z21(?=[a-z.])/, 'z2');
}

export const DEFAULT_SETTINGS = {
  // contacts — питати телефон за «Докладніше» (див. CONTACTS_PATH у della.js): Della вимагає капчу з браузера, тож
  // вимкнено, доки власник не вирішить інакше
  della: { searchUrls: [DEFAULT_SEARCH_URL], pollSeconds: 60, pagesPerPoll: 3, contacts: false },
  filters: {
    minPrice: 8000, directOnly: true, bodies: [], fromRegions: [], toRegions: [], excludeRegions: [],
    stopWords: [], maxAgeHours: 0,
  },
  lardi: {
    accounts: [
      { name: 'Акаунт 1', token: '', enabled: true },
      { name: 'Акаунт 2', token: '', enabled: true },
    ],
    mode: 'both', autoPublish: true, dryRun: true, cashCardOnly: false, intervalSeconds: 60, dailyLimit: 500, note: '',
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

/** Сесія Della в адмінці — лише ознаки, ніколи не значення. */
const NO_SESSION = { set: false, state: 'none', checkedAt: null, updatedAt: null };

export function maskSettings(s, session = NO_SESSION) {
  const m = clone(s);
  m.lardi.accounts = m.lardi.accounts.map((a, i) => ({ ...a, index: i, token: maskToken(a.token), hasToken: !!a.token, state: accountState(a) }));
  m.della.session = { set: !!session.set, state: session.state, checkedAt: session.checkedAt ?? null, updatedAt: session.updatedAt ?? null };
  return m;
}

// ---------- сесія Della (кука залогіненого браузера клієнтки) ----------
// Пароль із сервера не підходить (на вході Della reCAPTCHA v3) — лише кука з браузера, де клієнтка вже увійшла.
// Зберігається тільки в базі (settings: SESSION_KEY), у журнал, відповіді RPC і помилки не потрапляє.

const SESSION_KEY = 'della.session'; // {cookie, updatedAt, id}
const SESSION_META = 'dellaSession'; // meta: {id, state, checkedAt, customerSeen, phoneSeen, message}
const CONTACTS_META = 'dellaContacts'; // meta: {id, refused?, ok?, at} — що Della відповіла на запит контактів цієї сесії
export const CONTACTS_PER_POLL = 10;
const SESSION_STATES = ['none', 'alive', 'blind', 'expired', 'error'];
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Сесія Della, як її вставляють із Chrome DevTools: заголовок цілком («Cookie: a=1; b=2»), лише його значення
 * або одна пара «назва=значення». → рядок для заголовка Cookie; '' — очистити.
 * Голого значення без назви не приймаємо: назви сесійної куки Della ми не знаємо, а вгадувати не можна.
 * Значення в текст помилки не потрапляє.
 */
export function normalizeDellaCookie(raw) {
  let t = String(raw ?? '').trim();
  if (/^(["']).*\1$/s.test(t)) t = t.slice(1, -1).trim();
  t = t.replace(/^cookie\s*:/i, '').trim();
  if (!t) return '';
  if (t.length > 8192) throw new Error('Сесія Della задовга — вставте лише рядок Cookie');
  const out = [];
  for (const part of t.split(/[;\r\n]+/).map((x) => x.trim()).filter(Boolean)) {
    if (/[\u0000-\u001f\u007f]/.test(part)) throw new Error('У сесії Della недопустимі символи — скопіюйте рядок Cookie ще раз');
    const i = part.indexOf('=');
    if (i <= 0 || !COOKIE_NAME.test(part.slice(0, i).trim())) {
      throw new Error('Вставте рядок Cookie з DevTools цілком («назва=значення; …»), а не лише значення');
    }
    out.push(`${part.slice(0, i).trim()}=${part.slice(i + 1).trim()}`);
  }
  return out.join('; ');
}

/**
 * Прибрати з тексту значення куки — усю й кожне її значення окремо — для журналу й помилок.
 * Короткі значення (< 8 символів: lang=uk, agree=true) секретом не є й не нищать решту тексту.
 */
export function scrubSecret(msg, cookie) {
  let m = String(msg ?? '');
  if (!cookie) return m;
  const c = String(cookie);
  const parts = [c, ...c.split(/;\s*/).flatMap((p) => [p, p.slice(p.indexOf('=') + 1)]).filter((x) => x.length >= 8)]
    .sort((a, b) => b.length - a.length);
  for (const x of parts) m = m.split(x).join('•••');
  return m;
}

/** Рядок журналу на зміну стану сесії (раз, а не щоопитування). */
const SESSION_LOG = {
  alive: ['info', () => 'Della: вхід є, замовник у картці видно'],
  blind: ['warn', () => 'Della: вхід є, але замовника в картці не видно — можливо, акаунт Della не верифікований'],
  expired: ['warn', () => 'Della: сесія закінчилась або її не прийнято — Della відповідає як без входу, збір іде без замовника. Вставте нову в «Налаштування → Della»'],
  error: ['warn', (i) => `Della: не вдалося перевірити сесію — ${i.reason || i.message}`],
};

/**
 * Висновок про сторінку Della, взяту з сесією: {state, customerSeen, sample, message, reason?}.
 * Доведено лише ознаки «без входу» (dellaLoginState); «вхід є» = цих ознак немає.
 */
export function judgeDellaPage(html, opts = {}) {
  const none = { customerSeen: false, sample: null, has: null, phoneSeen: null, cards: null };
  const login = dellaLoginState(html);
  if (login === 'out') {
    return { ...none, state: 'expired', message: 'Della відповіла як без входу — сесію не прийнято або вона закінчилась. Вставте нову.' };
  }
  const list = parseDellaSearch(html, opts);
  if (!list.length) {
    const reason = 'карток на сторінці немає — можливо, капча або змінилась верстка';
    return { ...none, state: 'error', reason, message: `Della відповіла, але ${reason}.` };
  }
  const keyed = list.filter((c) => customerKeys(c).length);
  // що саме дає Della — хоч в одній картці сторінки; cards — у скількох картках замовник є взагалі
  const has = hasOf(list);
  const cards = { withCustomer: keyed.length, total: list.length };
  const seen = { has, phoneSeen: has.phone, cards, sample: null };
  if (sessionVerdict(cards) === 'blind') {
    const where = login === 'in' ? 'Вхід є' : 'Ознак виходу немає';
    const tail = login === 'in' ? 'можливо, акаунт Della не верифікований' : 'можливо, акаунт не верифікований або змінилась верстка';
    const message = keyed.length
      ? `${where}, але замовника видно лише в ${keyed.length} з ${list.length} карток — схоже, це дані з тексту заявки, а не від Della; ${tail}.`
      : `${where}, але замовника в картці не видно: у ${list.length} картках немає ні коду чи назви компанії, ні телефону, ні ЄДРПОУ — ${tail}.`;
    return { ...seen, state: 'blind', customerSeen: false, message };
  }
  const c = keyed.find((x) => x.phone) || keyed[0];
  const sample = {
    company: c.company ?? null, phone: c.phone ?? null, edrpou: c.edrpou ?? null, dellaCompanyId: c.dellaCompanyId ?? null, has,
  };
  const who = [c.company, c.phone].filter(Boolean).join(', ') || (c.edrpou && `ЄДРПОУ ${c.edrpou}`) || `код Della ${c.dellaCompanyId}`;
  return { ...seen, state: 'alive', customerSeen: true, sample, message: yieldsMessage(has, who, opts.contactsRefused, cards) };
}

/** Які ідентифікатори є хоч в одній картці: {phone, company, dellaCompanyId, edrpou}. */
const hasOf = (list) => Object.fromEntries(IDS.map(([k]) => [k, list.some((x) => !!x[k])]));

/**
 * «Вхід працює» — лише коли замовника видно щонайменше в третині карток. Справжні дані Della стоять у розмітці
 * кожної картки, а телефон, вписаний у текст заявки, — у поодиноких (H1: 1 з 25 — це не вхід).
 */
export function sessionVerdict({ withCustomer, total }) {
  return withCustomer > 0 && withCustomer * 3 >= total ? 'alive' : 'blind';
}

const IDS = [['phone', 'телефон'], ['company', 'назву компанії'], ['dellaCompanyId', 'код компанії Della'], ['edrpou', 'ЄДРПОУ']];
const listUk = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} і ${xs[xs.length - 1]}` : xs[0] || '');

/** Одне речення для клієнтки: що дає Della і як тоді блокувати (у живому чорному списку — самі телефони). */
function yieldsMessage(has, who, contactsRefused, cards) {
  const yes = IDS.filter(([k]) => has[k]).map(([, t]) => t);
  const eg = ` (замовника видно в ${cards.withCustomer} з ${cards.total} карток${who ? `; приклад: ${who}` : ''})`;
  if (has.phone && has.company) return `Вхід працює: Della дає ${listUk(yes)} — чорний список спрацює і за телефоном, і за назвою${eg}.`;
  if (has.phone) return `Вхід працює: Della дає ${listUk(yes)}, але не назву компанії — блокуйте за телефоном${eg}.`;
  const how = has.company ? 'за назвою' : has.edrpou ? 'за ЄДРПОУ' : 'кнопкою з картки заявки';
  const more = contactsRefused ? ', а за «Докладніше» Della його серверу не віддає (потрібні капча й верифікація)' : '';
  return `Вхід працює, але Della дає лише ${listUk(yes)} — блокуйте ${how}, телефон у картці не видно${more}${eg}.`;
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
    // значення сесій Della, відомі цьому запуску, — вичищаються з журналу й помилок
    this.secrets = new Set(env && env.DELLA_COOKIE ? [String(env.DELLA_COOKIE)] : []);
  }

  scrub(msg) {
    let m = String(msg ?? '');
    for (const c of this.secrets) m = scrubSecret(m, c);
    return m;
  }

  /** Міграція схеми (додає колонку й заповнює її) — перед першим зверненням до заявок. */
  ready() {
    let p = migrations.get(this.env.DB);
    if (!p) {
      p = this.store.migrate().then(async (n) => {
        if (n) console.log(`[IntDeliv] migrate: custKeys для ${n} заявок`);
        if (this.store.nameMigration) await this.logNameMigration(this.store.nameMigration);
      });
      migrations.set(this.env.DB, p);
      p.catch(() => migrations.delete(this.env.DB));
    }
    return p;
  }

  /** Міграція ключів за назвою (Store.migrateNameKeys) + один рядок журналу. → null, якщо вже мігровано. */
  async migrateNameKeys() {
    const r = await this.store.migrateNameKeys();
    if (r) await this.logNameMigration(r);
    return r;
  }

  /** Один рядок: що міграція назв змінила, лишила й не розв'язала — лише лічильники. */
  async logNameMigration(r) {
    if (!(r.changed + r.kept + r.repaired + r.issues.length)) return;
    const by = (k) => r.issues.filter((x) => x.kind === k).length;
    await this.log(r.issues.length ? 'warn' : 'info', `Назви в списках (нові правила порівняння): оновлено ${r.changed}, лишено як було ${r.kept}, `
      + `відновлено з підпису ${r.repaired}; не розв'язано ${r.issues.length} (два записи на одну фірму — ${by('clash')}, `
      + `назва без змісту — ${by('empty')}, без ключа — ${by('keyless')})`
      + `${r.blackWon ? `; спір чорного з білим — на користь чорного: ${r.blackWon}` : ''}; заявок перераховано ${r.loads}`);
  }

  waitUntil(p) {
    const safe = Promise.resolve(p).catch((e) => this.log('error', e.message || String(e)));
    if (this.ctx && this.ctx.waitUntil) this.ctx.waitUntil(safe);
    return safe;
  }

  async log(level, raw) {
    const msg = this.scrub(raw);
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
      if (p.contacts !== undefined) next.della.contacts = !!p.contacts;
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
      if (p.cashCardOnly !== undefined) next.lardi.cashCardOnly = !!p.cashCardOnly;
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
    if (!!next.della.contacts !== !!cur.della.contacts) {
      await this.log('info', next.della.contacts ? 'Della: увімкнено запит телефону за «Докладніше» (до 10 за збір, лише нові заявки)' : 'Della: запит телефону за «Докладніше» вимкнено');
    }
    if (next.lardi.dryRun !== cur.lardi.dryRun) {
      await this.log('info', next.lardi.dryRun ? 'Увімкнено DRY RUN — на Lardi нічого не публікується' : 'DRY RUN вимкнено — публікація на Lardi увімкнена');
    }
    return this.maskedSettings();
  }

  /** Налаштування для адмінки: токени — ••••XXXX, сесія Della — лише {set, state, checkedAt, updatedAt}. */
  async maskedSettings(sIn) {
    const s = sIn || (await this.getSettings());
    const [raw, st] = await Promise.all([this.store.getKV(SESSION_KEY, null), this.dellaSessionState()]);
    const stored = !!(raw && raw.cookie);
    return maskSettings(s, { set: stored, state: st.state, checkedAt: st.checkedAt, updatedAt: stored ? raw.updatedAt || null : null });
  }

  // ---------- сесія Della ----------

  /** Діюча сесія: з адмінки (база) → DELLA_COOKIE → null (без входу). {cookie, id, stored} */
  async dellaSession() {
    const raw = await this.store.getKV(SESSION_KEY, null);
    let sess = null;
    if (raw && raw.cookie) sess = { cookie: String(raw.cookie), id: raw.id || String(raw.updatedAt || ''), stored: true };
    else if (this.env && this.env.DELLA_COOKIE) {
      let cookie = '';
      try { cookie = normalizeDellaCookie(this.env.DELLA_COOKIE); } catch { /* непридатна — як без неї */ }
      if (cookie) sess = { cookie, id: 'env', stored: false };
    }
    if (sess) this.secrets.add(sess.cookie);
    return sess;
  }

  /** Збережений стан сесії без запиту до Della: {state, checkedAt, customerSeen, has, phoneSeen, cards}. */
  async dellaSessionState(sessIn) {
    const sess = sessIn === undefined ? await this.dellaSession() : sessIn;
    const m = sess ? await this.store.getMeta(SESSION_META, null) : null;
    if (!m || m.id !== sess.id || !SESSION_STATES.includes(m.state)) {
      return { state: 'none', checkedAt: null, customerSeen: false, has: null, phoneSeen: null, cards: null };
    }
    return {
      state: m.state, checkedAt: m.checkedAt ?? null, customerSeen: !!m.customerSeen,
      has: m.has || null, phoneSeen: typeof m.phoneSeen === 'boolean' ? m.phoneSeen : null, cards: m.cards || null,
    };
  }

  /**
   * Записати стан сесії (після перевірки чи збору); рядок журналу — лише коли стан змінився.
   * Збір зі старою сесією, що закінчився вже після збереження нової, стану нової не чіпає (id).
   */
  async noteDellaSession(id, info) {
    const cur = await this.dellaSession();
    if (!cur || cur.id !== id) return null;
    const prev = await this.store.getMeta(SESSION_META, null);
    const was = prev && prev.id === id ? prev.state : 'none';
    const noPhone = info.state === 'alive' && info.phoneSeen === false;
    await this.store.setMeta(SESSION_META, {
      id, state: info.state, checkedAt: this.now(), customerSeen: !!info.customerSeen,
      has: info.has || null, phoneSeen: typeof info.phoneSeen === 'boolean' ? info.phoneSeen : null, cards: info.cards || null,
      message: info.message,
    });
    const line = SESSION_LOG[info.state];
    if (was !== info.state && line) await this.log(line[0], line[1](info));
    // у живому чорному списку самі телефони: замовник без телефону = ці записи не спрацюють — сказати раз
    if (noPhone && !(was === 'alive' && prev.phoneSeen === false)) {
      await this.log('warn', 'Della: у картках немає телефону — записи чорного списку за телефоном не спрацюють, додавайте замовника за назвою компанії');
    }
    return info;
  }

  /** Перевірка: ОДНА сторінка першого пошуку з сесією → {state, customerSeen, sample, cards, message}. */
  async checkDellaSession() {
    const sess = await this.dellaSession();
    if (!sess) {
      return { state: 'none', customerSeen: false, sample: null, cards: null, message: 'Сесію Della не задано — збір іде без входу, замовника в заявках не видно.' };
    }
    const s = await this.getSettings();
    const url = buildPageUrl(dellaSearchUrl(s.della.searchUrls[0], s.filters.directOnly), 0);
    let r;
    try {
      const cm = await this.store.getMeta(CONTACTS_META, null);
      const contactsRefused = !!(cm && cm.id === sess.id && cm.refused);
      r = judgeDellaPage(await this.fetchDella(url, sess), { url, now: kyivWall(this.now()), contactsRefused });
    } catch (e) {
      const reason = this.scrub(e.message || e);
      r = { state: 'error', customerSeen: false, sample: null, cards: null, reason, message: `Не вдалося перевірити сесію: ${reason}.` };
    }
    await this.noteDellaSession(sess.id, r);
    return { state: r.state, customerSeen: r.customerSeen, sample: r.sample, cards: r.cards, message: this.scrub(r.message) };
  }

  /** Зберегти (і одразу перевірити) або стерти сесію. → {state} */
  async setDellaSession(raw) {
    const cookie = normalizeDellaCookie(raw);
    const had = await this.store.getKV(SESSION_KEY, null);
    await this.store.setMeta(SESSION_META, null);
    if (!cookie) {
      await this.store.setKV(SESSION_KEY, null);
      // запасна DELLA_COOKIE (секрет репозиторію) лишається в ділі — кажемо це й одразу перевіряємо саме її
      const fallback = await this.dellaSession();
      if (had && had.cookie) {
        await this.log('info', fallback
          ? 'Della: сесію з адмінки видалено — далі вхід із запасної DELLA_COOKIE (секрет репозиторію); прибрати її може лише власник у GitHub'
          : 'Della: сесію видалено — збір іде без входу');
      }
      return { state: fallback ? (await this.checkDellaSession()).state : 'none' };
    }
    this.secrets.add(cookie);
    const now = this.now();
    await this.store.setKV(SESSION_KEY, { cookie, updatedAt: now, id: `${now}-${Math.random().toString(36).slice(2, 8)}` });
    await this.log('info', 'Della: збережено нову сесію — перевіряю');
    return { state: (await this.checkDellaSession()).state };
  }

  /**
   * Стан сесії за сторінками одного збору: усі «без входу» — expired; є картки — alive/blind за замовником;
   * карток немає (капча, верстка) — судити нема з чого, стан не міняємо. pages: [{login, cards, withCustomer}]
   */
  async notePollSession(sess, pages) {
    if (!pages.length) return null;
    const inPages = pages.filter((p) => p.login !== 'out');
    if (!inPages.length) return this.noteDellaSession(sess.id, { state: 'expired', customerSeen: false });
    const cards = { withCustomer: inPages.reduce((n, p) => n + p.withCustomer, 0), total: inPages.reduce((n, p) => n + p.cards, 0) };
    if (!cards.total) return null;
    const has = Object.fromEntries(IDS.map(([k]) => [k, inPages.some((p) => p.has[k])]));
    const state = sessionVerdict(cards);
    return this.noteDellaSession(sess.id, { state, customerSeen: state === 'alive', has, phoneSeen: has.phone, cards });
  }

  /** POST на Della з сесією (запит контактів) → JSON або null (не JSON). */
  async postDella(path, body, sess) {
    const headers = {
      ...BROWSER_HEADERS,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: DELLA_ORIGIN,
      Referer: DELLA_ORIGIN + '/',
      Cookie: sess.cookie,
    };
    let res;
    try {
      res = await this.fetch(DELLA_ORIGIN + path, { method: 'POST', headers, body });
    } catch (e) {
      throw new Error(`Della: ${scrubSecret((e && e.message) || String(e), sess.cookie)} для ${path}`);
    }
    if (!res.ok) throw new Error(`Della ${res.status} для ${path}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return null; }
  }

  /**
   * Телефон за «Докладніше» для НОВИХ заявок без телефону (della.contacts, сесія прийнята). Жорсткі межі: один запит
   * на нову заявку (повторів немає — наступного збору вона вже не нова), не більше CONTACTS_PER_POLL за збір,
   * послідовно; перша відмова Della (капча, доступ, незрозуміла відповідь) зупиняє запити до збереження нової сесії.
   * Чорного замовника, що виявився за телефоном, одразу ховаємо — у чергу він не стає. → {asked, phones, refused}
   */
  async fetchContacts(sess, loads, calls, s) {
    const prev = await this.store.getMeta(CONTACTS_META, null);
    if (prev && prev.id === sess.id && prev.refused) return { asked: 0, phones: 0, refused: prev.refused };
    let asked = 0; let phones = 0; let refused = null;
    for (const l of loads) {
      if (asked >= CONTACTS_PER_POLL) break;
      const call = calls.get(l.dellaRequestId);
      if (!call || customerKeys(l).some((k) => k.startsWith('tel:'))) continue;
      asked++;
      let r;
      try {
        r = parseDellaContacts(await this.postDella(CONTACTS_PATH, contactsBody(call), sess));
      } catch (e) {
        // 403/429/5xx чи мережа — теж відмова: повторювати з сесією клієнтки щозбору не можна
        r = { refused: 'http', desc: this.scrub(e.message || e).slice(0, 200) };
      }
      if (r.refused) { refused = r; break; }
      if (!r.phone && !r.edrpou) continue;
      const next = await this.store.updateLoad(l.id, (x) => ({
        ...x, ...(x.phone ? {} : r.phone ? { phone: r.phone } : {}), ...(x.edrpou ? {} : r.edrpou ? { edrpou: r.edrpou } : {}),
      }));
      if (r.phone) phones++;
      if (await this.isBlackLoad(next)) await this.markInactive(l.id, BLACK_REASON, 'blacklist', s);
    }
    if (refused) {
      const why = {
        captcha: 'Della вимагає капчу з браузера',
        access: `«${refused.desc || 'Обмеження доступу до інформації'}» — потрібна верифікація акаунта`,
        format: 'незрозуміла відповідь',
        http: `помилка запиту: ${refused.desc}`,
      }[refused.refused];
      await this.store.setMeta(CONTACTS_META, { id: sess.id, refused: refused.refused, at: this.now() });
      await this.log('warn', `Della: телефон за «Докладніше» не віддала (${why}) — запити контактів для цієї сесії зупинено; блокуйте за назвою компанії`);
    } else if (phones && !(prev && prev.id === sess.id && prev.ok)) {
      await this.store.setMeta(CONTACTS_META, { id: sess.id, ok: true, at: this.now() });
      await this.log('info', 'Della: телефон за «Докладніше» отримано — чорний список за телефоном працює');
    }
    return { asked, phones, refused: refused ? refused.refused : null };
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
    const [counts, today, lastPollAt, lastError, lastPollOkAt, busy, accounts, sess, custCoverage] = await Promise.all([
      this.store.countByStatus(STATUSES),
      this.getToday(s.lardi.accounts.length),
      this.store.getMeta('lastPollAt', null),
      this.store.getMeta('lastError', null),
      this.store.getMeta('lastPollOkAt', null),
      this.store.lockActive(),
      this.accountsStats(s),
      this.dellaSessionState(),
      this.store.custCoverage(),
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
      // з останньої перевірки чи збору — без запиту до Della (адмінці не треба щоразу кликати check)
      della: {
        session: sess.state, checkedAt: sess.checkedAt, customerSeen: sess.customerSeen,
        has: sess.has, phoneSeen: sess.phoneSeen, cards: sess.cards,
      },
      custCoverage, // {withCustomer, total}: у скількох заявок є замовник — без нього чорний список сліпий
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

  /**
   * Сторінка Della. Сесія (тоді в картках є замовник): з адмінки → DELLA_COOKIE → без входу.
   * sess — уже визначена сесія (один збір — одна сесія на всі сторінки) або null. Значення ніде не логується.
   */
  async fetchDella(url, sessIn) {
    const sess = sessIn === undefined ? await this.dellaSession() : sessIn;
    const headers = sess ? { ...BROWSER_HEADERS, Cookie: sess.cookie } : BROWSER_HEADERS;
    let res;
    try {
      res = await this.fetch(url, { headers, redirect: 'follow' });
    } catch (e) {
      // undici пише значення невірного заголовка в текст помилки — вичищаємо
      throw new Error(`Della: ${scrubSecret((e && e.message) || String(e), sess && sess.cookie)} для ${url}`);
    }
    if (!res.ok) throw new Error(`Della ${res.status} для ${url}`);
    return res.text();
  }

  /** Фільтри + чорний список (isBlack(p) — за будь-яким ключем: код, ЄДРПОУ, телефон чи назва). */
  filterVerdict(p, f, isBlack = () => false) {
    // дата — за Києвом; maxAgeHours рахуємо від реального часу
    const v = applyFilters(p, { ...f, maxAgeHours: 0 }, kyivWall(this.now()));
    if (!v.pass) return v;
    const maxAge = Number(f.maxAgeHours) || 0;
    if (maxAge > 0 && p.postedAt && this.now() - p.postedAt > maxAge * 3600e3) return { pass: false, reason: `старша за ${maxAge} год` };
    if (isBlack(p)) return { pass: false, reason: BLACK_REASON };
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
        for (let page = 0; page < s.della.pagesPerPoll; page++) jobs.push({ url: buildPageUrl(dellaSearchUrl(searchUrl, s.filters.directOnly), page), page });
      }
      const sess = await this.dellaSession();
      const pages = await Promise.allSettled(jobs.map((j) => this.fetchDella(j.url, sess)));
      const byId = new Map();
      const wall = kyivWall(now);
      const sessPages = []; // що показала Della з сесією: [{login, cards, withCustomer, has}]
      const contactCalls = new Map(); // dellaRequestId → поля запиту контактів (лише з сесією й della.contacts)
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
        if (sess) {
          const login = dellaLoginState(r.value);
          const keys = parsed.map((p) => customerKeys(p));
          sessPages.push({ login, cards: parsed.length, withCustomer: keys.filter((k) => k.length).length, has: hasOf(parsed) });
          if (s.della.contacts && login !== 'out') for (const [rid, call] of contactsCalls(r.value)) contactCalls.set(rid, call);
        }
      }
      if (sess) await this.notePollSession(sess, sessPages);
      const parsed = [...byId.values()];
      seen = parsed.length;
      const black = await this.store.keysOfList('black');
      const isBlack = (l) => black.size > 0 && customerKeys(l).some((k) => black.has(k));
      const verdict = new Map();
      for (const p of parsed) verdict.set(p.id, this.filterVerdict(p, s.filters, isBlack));
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
      if (sess && contactCalls.size && inserted) await this.fetchContacts(sess, res.inserted, contactCalls, s);
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
        statusReason: manual ? MANUAL_QUEUE : undefined,
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
      // «Лише готівка/картка»: решта автоматичних чекає в черзі, поставлені вручну — публікуються
      const queued = (await this.store.queuedLight(5000, { cashCardOnly: !!s.lardi.cashCardOnly })).filter((l) => !(l.dateLast && l.dateLast < today));
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
    // чорний список — і до заявок, чий замовник став відомий після збору; їхні живі публікації знімає добір нижче
    await this.catchUpBlack(s);
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
   * Знята публікація стає removed — повторно не знімається. rowsIn — готові рядки {id, lardi[]} (customers.reapply).
   */
  async sweepLardi(s, limit = SWEEP_LIMIT, rowsIn = null) {
    // заявок беремо із запасом: публікації акаунтів без токена пропускаються й не мають забирати ліміт
    const rows = rowsIn || (await this.store.pendingRemovals(limit * 10));
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
    // лише власні обробники: valueOf / constructor / __proto__ з Object.prototype віддали б увесь рушій разом з env
    const h = typeof method === 'string' && Object.hasOwn(this.handlers, method) ? this.handlers[method] : null;
    if (typeof h !== 'function') throw new Error(`невідомий метод ${method}`);
    await this.ready();
    try {
      return await h.call(this, p || {});
    } catch (e) {
      if (e && e.message && this.secrets.size) e.message = this.scrub(e.message);
      throw e;
    }
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

  /**
   * Чорний список: зняти з Lardi живі публікації й приховати заявки. Повторно не знімає вже знятих.
   * rows — готові легкі рядки замість пошуку за keys; remove: false — лише приховати (зніме sweepLardi пакетами).
   */
  async applyBlack(keys, s, { rows, remove = true } = {}) {
    let hidden = 0; let removed = 0; let failed = 0;
    for (const r of rows || (await this.store.loadsByKeys(keys))) {
      const live = remove ? r.lardi.filter((e) => e.id && e.status === 'published') : [];
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

  /**
   * Догін чорного списку (staleCheck): робочі заявки замовника з чорного списку, до яких список не застосовано, —
   * замовник став відомий після збору (з'явилась сесія Della, повторний збір дописав телефон/компанію).
   * Не більше limit за прохід; приховані більше не кандидати — кожна заявка лише раз. Живі публікації знімає
   * sweepLardi тим самим проходом, пакетами.
   */
  async catchUpBlack(s, limit = SWEEP_LIMIT) {
    const rows = await this.store.blackPending({ active: true, limit });
    if (!rows.length) return { hidden: 0 };
    const { hidden } = await this.applyBlack(null, s, { rows, remove: false });
    if (hidden) {
      await this.log('info', `Чорний список: догнано ${hidden} заявок — замовник став відомий після збору${rows.length >= limit ? ` (по ${limit} за прохід, решта — наступним)` : ''}`);
    }
    return { hidden };
  }

  /** Id чорних записів, яким належить хоч один із ключів. */
  async blackIdsOf(keys) {
    return [...new Set((await this.store.customersByKeys(keys)).filter((x) => x.list === 'black').map((x) => x.customerId))].sort((a, b) => a - b);
  }

  /** Усі ключі записів ids. */
  async keysOfCustomers(ids) {
    const keys = [];
    for (const id of ids) keys.push(...((await this.store.getCustomer(id))?.keys || []));
    return [...new Set(keys)];
  }

  /**
   * Скільки з заявок hiddenBefore (id, приховані чорним списком до дії) тепер видно. keys мають їх покривати.
   * Заявку, яку й далі ховає інший чорний запис, не рахуємо — «знову видно» лише те, що справді стало видно.
   */
  async nowVisible(keys, hiddenBefore) {
    if (!hiddenBefore.length) return 0;
    const still = new Set(await this.store.blackIdsByKeys(keys));
    return hiddenBefore.filter((id) => !still.has(id)).length;
  }

  /**
   * Ключі зараз у чорному списку, а запит забирає їх в інший список (зокрема злиттям записів) — лише з
   * {fromBlack: true}. Інакше відмова (unblockRefusal).
   */
  async guardFromBlack(keys, toList, fromBlack, action) {
    if (toList === 'black' || fromBlack === true) return;
    const ids = await this.blackIdsOf(keys);
    if (ids.length) throw await this.unblockRefusal(ids, action, toList, keys);
  }

  /**
   * Відмова RpcError('fromBlack') з тим, що потрібно, аби спитати людину: {action: 'add' | 'move' | 'remove',
   * list: куди ('white'; null — прибрати), entries: [{id, list, label, keys}], loads: скільки заявок знову стало б видно —
   * без тих, що й далі ховав би інший чорний запис}. keys — ключі запиту: у entries лише спільні (без них — усі ключі запису).
   */
  async unblockRefusal(ids, action, toList, keys = null) {
    const entries = await this.blockEntries(ids, keys);
    const all = await this.keysOfCustomers(ids);
    const now = await this.store.blackIdsByKeys(all);
    const after = new Set(await this.store.blackIdsByKeys(all, ids));
    const loads = now.filter((id) => !after.has(id)).length;
    const who = entries.map((e) => `«${e.label || e.keys[0]}»`).join(', ');
    const what = toList ? 'в «Обрані» переносимо' : 'прибираємо з нього';
    return new RpcError(`${who} зараз у чорному списку — ${what} лише після підтвердження (повернеться заявок: ${loads})`,
      'fromBlack', { action, list: toList ?? null, entries, loads });
  }

  /** [{id, list, label, keys}] записів ids; keys — лише спільні з keys (без них — усі ключі запису). */
  async blockEntries(ids, keys = null) {
    const entries = [];
    for (const id of ids) {
      const c = await this.store.getCustomer(id);
      if (c) entries.push({ id: c.id, list: c.list, label: c.label ?? null, keys: keys ? c.keys.filter((k) => keys.includes(k)) : c.keys });
    }
    return entries;
  }

  /**
   * Відмова loads.update, що вивела б заявку з чорного списку: RpcError('fromBlack') з {action: 'edit', list: null,
   * loadId, entries — записи, що зараз її ховають (keys — ключі цієї заявки), loads: 1, outcome — що з нею станеться:
   * 'queued' (у черзі на Lardi) | 'new' (у роботі) | 'archived' (в Архіві, дата минула) | 'inactive' (знята вручну)}.
   */
  async loadRefusal(cur, patch, ids, s) {
    const entries = await this.blockEntries(ids, customerKeys(cur));
    const draft = applyPatch(cur, patch, this.now());
    const last = draft.dateTo || draft.dateFrom;
    const hidden = cur.status === 'inactive' && cur.inactiveKind === 'blacklist';
    const outcome = patch.status === 'inactive' ? 'inactive' : patch.status === 'queued' ? 'queued'
      : !hidden ? cur.status : last && last < kyivDay(this.now()) ? 'archived' : s.lardi.autoPublish ? 'queued' : 'new';
    const then = { queued: 'стане в чергу на Lardi', new: 'повернеться в роботу', archived: 'буде видно в Архіві', inactive: 'буде видно серед знятих' }[outcome] || 'знову буде видно';
    const who = entries.map((e) => `«${e.label || e.keys[0]}»`).join(', ');
    return new RpcError(`Заявку ховає чорний список (${who}); після цієї правки вона з нього вийде і ${then} — зберігаємо лише після підтвердження`,
      'fromBlack', { action: 'edit', list: null, loadId: cur.id, entries, loads: 1, outcome });
  }

  /**
   * Одна заявка, прихована чорним списком, після зняття з нього: актуальна — у new, минула — лишається в архіві.
   * → 'restored' | 'archived' | null (заявку не ховав чорний список — не чіпаємо).
   */
  async restoreLoad(id, today = kyivDay(this.now())) {
    let kind = null;
    await this.store.updateLoad(id, (x) => {
      if (x.status !== 'inactive' || x.inactiveKind !== 'blacklist') return null;
      const last = x.dateTo || x.dateFrom;
      if (last && last < today) {
        kind = 'archived';
        return { ...x, inactiveKind: 'date', statusReason: 'дата завантаження минула', updatedAt: this.now() };
      }
      kind = 'restored';
      const next = { ...x, status: 'new', statusReason: 'замовника прибрано з чорного списку', lardi: (x.lardi || []).filter((e) => e.status !== 'removed'), updatedAt: this.now() };
      delete next.inactiveKind;
      return next;
    });
    return kind;
  }

  /**
   * Після зняття з чорного списку: актуальні — у new (+ черга), минулі — лишаються в архіві. Лише заявки цієї дії
   * (only — id, приховані до неї): залишок, вивільнений колись чимось іншим, не чіпаємо й не рахуємо.
   */
  async restoreUnblocked(s, only) {
    const today = kyivDay(this.now());
    const mine = new Set(only);
    let restored = 0; let archived = 0; let queued = 0;
    for (const id of await this.store.unblockedIds()) {
      if (!mine.has(id)) continue;
      const kind = await this.restoreLoad(id, today);
      if (kind === 'restored') {
        restored++;
        if (s.lardi.autoPublish && (await this.enqueue(id, false))?.status === 'queued') queued++;
      } else if (kind === 'archived') archived++;
    }
    return { restored, archived, queued };
  }

  /** hiddenBefore — id заявок, прихованих чорним списком до дії (для чесного affected.visible). */
  async afterListChange(customer, prevList, s, hiddenBefore = []) {
    if (customer.list === 'black') {
      const a = await this.applyBlack(customer.keys, s);
      await this.log('info', `Чорний список: «${customer.label || customer.keys[0]}» — приховано ${a.hidden}, знято з Lardi ${a.removed}${a.failed ? `, не вдалося зняти ${a.failed}` : ''}`);
      return a;
    }
    if (prevList !== 'black') {
      await this.log('info', `Обрані: «${customer.label || customer.keys[0]}»`);
      return { restored: 0 };
    }
    // навмисний перенос із чорного (fromBlack): правда для адмінки — скільки заявок знову видно і скільки в черзі
    const a = await this.restoreUnblocked(s, hiddenBefore);
    a.visible = await this.nowVisible(customer.keys, hiddenBefore);
    await this.log('info', `Обрані: «${customer.label || customer.keys[0]}» — з чорного списку в «Обрані» (підтверджено): знову видно заявок ${a.visible}, у черзі ${a.queued}`);
    return a;
  }
}

Engine.prototype.handlers = {
  async ping() { return { version: VERSION }; },

  async 'loads.list'(p) { return this.store.listLoads(p); },

  /**
   * Правка заявки. Правка телефону / компанії / ЄДРПОУ, після якої заявку вже не ховав би чорний список, — лише з
   * {fromBlack: true} (буквально true); інакше — відмова loadRefusal (action 'edit'), нічого не записано.
   * З прапорцем — та сама дорога, що й зняття запису (restoreLoad + черга), і відповідь — заявка + affected
   * {visible, restored, archived, queued, entries}. Правка, що з чорного списку не виводить, — як і була.
   */
  async 'loads.update'({ id, patch, fromBlack } = {}) {
    if (!id) throw new Error('id обовʼязковий');
    const s = await this.getSettings();
    const cur = await this.store.getLoad(id);
    if (!cur) throw new Error('заявку не знайдено');
    // лише коментар — тільки в нашу базу: без Lardi, черги й чорного списку
    if (isLocalPatch(patch)) return this.store.updateLoad(id, (l) => ({ ...applyPatch(l, patch, this.now()), updatedAt: l.updatedAt }));
    // ховає зараз чорний список, а після правки вже не ховав би — лише з підтвердженням
    const blockers = await this.blackIdsOf(customerKeys(cur));
    let released = false;
    if (blockers.length && !(await this.isBlackLoad(applyPatch(cur, patch || {}, this.now())))) {
      if (fromBlack !== true) throw await this.loadRefusal(cur, patch || {}, blockers, s);
      released = true;
    }
    let next = await this.store.updateLoad(id, (l) => applyPatch(l, patch || {}, this.now()));
    // правка телефону/компанії/ЄДРПОУ могла ввести заявку в чорний список
    const black = await this.isBlackLoad(next);
    if (black) {
      if (patch && patch.status === 'queued') throw new Error('замовник у чорному списку');
      await this.markInactive(id, BLACK_REASON, 'blacklist', s);
      return this.store.getLoad(id);
    }
    let affected = null;
    if (released) {
      const kind = await this.restoreLoad(id);
      if (patch && patch.status === 'inactive') await this.markInactive(id, 'знято вручну', 'manual', s);
      else if (patch && patch.status === 'queued') await this.enqueue(id, true);
      else if (kind === 'restored' && s.lardi.autoPublish) await this.enqueue(id, false);
      const after = await this.store.getLoad(id);
      affected = {
        visible: 1, restored: kind === 'restored' ? 1 : 0, archived: kind === 'archived' ? 1 : 0,
        queued: after.status === 'queued' ? 1 : 0, entries: await this.blockEntries(blockers, customerKeys(cur)),
      };
      const who = affected.entries.map((e) => `«${e.label || e.keys[0]}»`).join(', ');
      await this.log('info', `Заявка ${describe(after)} вийшла з чорного списку (${who}) правкою — підтверджено${affected.queued ? ', у черзі на Lardi' : ''}`);
    } else if (patch && patch.status === 'inactive') await this.markInactive(id, 'знято вручну', 'manual', s);
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
    return affected ? { ...next, affected } : next; // affected — лише у відповіді, у базу не пишемо
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

  async 'settings.get'() { return this.maskedSettings(); },
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
    // nameKeyIssues — що не розв'язала міграція назв (два записи на одну фірму тощо), щоб адмінка показала
    return { items: await this.store.listCustomers(l), hiddenBlack: await this.store.hiddenBlackCount(), nameKeyIssues: await this.store.nameKeyIssues() };
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
    await this.guardFromBlack(keys, list, p.fromBlack, 'add');
    const s = await this.getSettings();
    const blackIds = await this.blackIdsOf(keys);
    const prevList = blackIds.length ? 'black' : null;
    const hiddenBefore = blackIds.length && list !== 'black' ? await this.store.blackIdsByKeys(await this.keysOfCustomers(blackIds)) : [];
    const { customer } = await this.store.upsertCustomer(list, keys, { label: p.label, fallbackLabel: label, note: p.note });
    const affected = await this.afterListChange(customer, prevList, s, hiddenBefore);
    return { customer, affected };
  },

  async 'customers.move'({ id, list, fromBlack } = {}) {
    if (list !== 'black' && list !== 'white') throw new Error('list: black або white');
    const cur = await this.store.getCustomer(id);
    if (!cur) throw new Error('замовника не знайдено');
    if (cur.list === 'black') await this.guardFromBlack(cur.keys, list, fromBlack, 'move');
    const s = await this.getSettings();
    const hiddenBefore = cur.list === 'black' && list !== 'black' ? await this.store.blackIdsByKeys(cur.keys) : [];
    const customer = await this.store.setCustomerList(cur.id, list);
    const affected = await this.afterListChange(customer, cur.list, s, hiddenBefore);
    return { customer, affected };
  },

  async 'customers.update'({ id, label, note } = {}) {
    const c = await this.store.updateCustomer(id, { label, note });
    if (!c) throw new Error('замовника не знайдено');
    return c;
  },

  /**
   * Застосувати чорний список до всіх заявок, що вже в базі (замовника внесли чи побачили після збору):
   * приховати (applyBlack) і зняти живі публікації пакетами по 50 (sweepLardi) — не по одній, щоб не впертися в час відповіді.
   * Що не вдалося зняти — добере staleCheck.
   */
  async 'customers.reapply'() {
    const s = await this.getSettings();
    const rows = await this.store.blackPending();
    const { hidden } = await this.applyBlack(null, s, { rows, remove: false });
    const { removed, failed } = await this.sweepLardi(s, Infinity, rows);
    await this.log('info', `Чорний список: застосовано до наявних заявок — приховано ${hidden}, знято з Lardi ${removed}${failed ? `, не вдалося зняти ${failed}` : ''}`);
    return { hidden, removed, failed };
  },

  /**
   * Прибрати запис. Чорний — лише з {fromBlack: true} (буквально true): його заявки повертаються в роботу й чергу на Lardi,
   * а клієнт із застарілим списком міг вважати його обраним. Без прапорця — та сама відмова, що й у add/move
   * (action 'remove', list null). Список перевіряємо за базою, не за тим, що думає клієнт. Обраний — як і було.
   */
  async 'customers.remove'({ id, fromBlack } = {}) {
    const cur = await this.store.getCustomer(id);
    if (!cur) throw new Error('замовника не знайдено');
    if (cur.list === 'black' && fromBlack !== true) throw await this.unblockRefusal([cur.id], 'remove', null);
    const hiddenBefore = cur.list === 'black' ? await this.store.blackIdsByKeys(cur.keys) : [];
    const c = await this.store.removeCustomer(cur.id);
    if (!c) throw new Error('замовника не знайдено');
    const s = await this.getSettings();
    const r = c.list === 'black' ? await this.restoreUnblocked(s, hiddenBefore) : { restored: 0, archived: 0, queued: 0 };
    r.visible = c.list === 'black' ? await this.nowVisible(c.keys, hiddenBefore) : 0;
    await this.log('info', `${c.list === 'black' ? 'Чорний список' : 'Обрані'}: прибрано «${c.label || c.keys[0]}»${r.restored ? `, повернуто заявок ${r.restored}` : ''}`);
    return r;
  },

  // ---------- сесія Della ----------

  /** {cookie} — рядок Cookie з DevTools (порожньо — стерти). → {state}. Значення не повертається ніколи. */
  async 'della.session.set'({ cookie } = {}) { return this.setDellaSession(cookie); },

  /** Одна сторінка Della з сесією → {state, customerSeen, sample, message}. */
  async 'della.session.check'() { return this.checkDellaSession(); },

  async 'log.list'({ limit = 200 } = {}) { return this.store.listLog(Math.min(2000, Number(limit) || 200)); },
};
