// Клиент Lardi-Trans API v2. Без chrome.* на верхнем уровне — тестируется в node.
// Docs: https://api.lardi-trans.com/v2/docs/en/

export const LARDI_BASE = 'https://api.lardi-trans.com/v2';

export class NeedsReviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NeedsReviewError';
    this.needsReview = true;
  }
}

export class LardiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'LardiError';
    this.status = status;
    this.body = body;
  }
}

export const CURRENCY_IDS = { UAH: 2, USD: 4, EUR: 6 };
export const PAYMENT_FORM_IDS = { 'Безнал': 4, 'Готівка': 2, 'Картка': 10 };

// Della-кузов → шаблоны названий в /references/body/types (uk/ru) + запасные id.
// Известные id из документации: 34 — Тент, 25 — Ізотерм, 27 — Контейнер.
export const BODY_RULES = {
  'тент': { patterns: ['тент'], fallback: [34] },
  'крита': { patterns: ['тент', 'ізотерм', 'изотерм', 'цільномет', 'цельномет'], fallback: [34, 25] },
  'будь-яка': { patterns: ['тент', 'ізотерм', 'изотерм', 'рефриж', 'контейнер', 'борт'], fallback: [34, 25, 27] },
  'ізотерм': { patterns: ['ізотерм', 'изотерм'], fallback: [25] },
  'изотерм': { patterns: ['ізотерм', 'изотерм'], fallback: [25] },
  'рефрижератор': { patterns: ['рефриж'], fallback: [] },
  'контейнер': { patterns: ['контейнер'], fallback: [27] },
  'контейнеровоз': { patterns: ['контейнер'], fallback: [27] },
  'відкрита': { patterns: ['борт', 'платформ'], fallback: [] },
  'бортова': { patterns: ['борт'], fallback: [] },
  'платформа': { patterns: ['платформ'], fallback: [] },
  'самоскид': { patterns: ['самоскид', 'самосвал'], fallback: [] },
  'зерновоз': { patterns: ['зерновоз'], fallback: [] },
  'цистерна': { patterns: ['цистерн'], fallback: [] },
  'мікроавтобус': { patterns: ['мікроавт', 'микроавт', 'бус'], fallback: [] },
  'цільномет': { patterns: ['цільномет', 'цельномет'], fallback: [] },
  'трал': { patterns: ['трал', 'негабарит'], fallback: [] },
  'автовоз': { patterns: ['автовоз'], fallback: [] },
  'лісовоз': { patterns: ['лісовоз', 'лесовоз'], fallback: [] },
};

const normName = (s) => String(s || '').toLowerCase().replace(/[’ʼ`]/g, "'").replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Сопоставить кузов Della со списком типов Lardi. Бросает NeedsReviewError. */
export function resolveBodyIds(body, bodyTypes = []) {
  const b = normName(body);
  if (!b) throw new NeedsReviewError('не вказано тип кузова');
  const types = (bodyTypes || []).map((t) => ({ id: t.id, name: normName(t.name) }));
  // точное совпадение имени
  const exact = types.filter((t) => t.name === b);
  if (exact.length) return exact.map((t) => t.id);
  const rule = BODY_RULES[b] || Object.entries(BODY_RULES).find(([k]) => b.startsWith(k.slice(0, 5)))?.[1]
    || { patterns: [b.slice(0, Math.max(4, b.length - 2))], fallback: [] };
  const ids = [];
  for (const p of rule.patterns) {
    for (const t of types) if (t.name.includes(p) && !ids.includes(t.id)) ids.push(t.id);
  }
  if (ids.length) return ids;
  if (rule.fallback.length) return rule.fallback.slice();
  throw new NeedsReviewError(`не вдалося зіставити кузов «${body}» з Lardi`);
}

const dimsFromLoad = (load) => load.dims || {};

/**
 * Тело POST /proposals/my/add/cargo. Чистая функция.
 * @param {object} load
 * @param {{bodyIds:number[], from:object, to:object, paymentUnitId?:number, note?:string}} ctx
 */
// Ліміти полів Lardi (перевірено 22.09.2026 через помилки валідації)
export const LIMITS = { note: 100, contentName: 50 };
const clip = (str, n) => (str.length <= n ? str : str.slice(0, n - 1).replace(/[\s,.;:–-]+$/, '') + '…');

export function buildCargoBody(load, ctx) {
  if (!load.dateFrom) throw new NeedsReviewError('немає дати завантаження');
  if (!load.price) throw new NeedsReviewError('немає ціни');
  if (!load.weight) throw new NeedsReviewError('немає ваги');
  if (!load.cargo) throw new NeedsReviewError('немає назви вантажу');
  if (!ctx || !ctx.bodyIds || !ctx.bodyIds.length) throw new NeedsReviewError('не визначено тип кузова');
  if (!ctx.from || !ctx.to) throw new NeedsReviewError('не визначено місто');

  const currencyId = CURRENCY_IDS[load.currency || 'UAH'];
  if (!currencyId) throw new NeedsReviewError(`невідома валюта ${load.currency}`);
  const tags = load.tags || [];
  const vat = tags.some((t) => /^пдв$/i.test(String(t).trim()));
  const formId = PAYMENT_FORM_IDS[load.payment];

  const point = (p) => {
    const o = { countrySign: p.countrySign || 'UA', townName: p.townName };
    if (p.townId) o.townId = p.townId;
    if (p.areaId) o.areaId = p.areaId;
    return o;
  };

  const body = {
    dateFrom: load.dateFrom,
    dateTo: load.dateTo || load.dateFrom,
    contentName: clip(String(load.cargo), LIMITS.contentName),
    cargoBodyTypeIds: ctx.bodyIds,
    sizeMass: load.weight,
    paymentValue: load.price,
    paymentPrice: load.price,
    paymentCurrencyId: currencyId,
    waypointListSource: [point(ctx.from)],
    waypointListTarget: [point(ctx.to)],
  };
  if (ctx.paymentUnitId) body.paymentUnitId = ctx.paymentUnitId;
  if (load.volume) body.sizeVolume = load.volume;
  const d = dimsFromLoad(load);
  if (d.length) body.sizeLength = d.length;
  if (d.width) body.sizeWidth = d.width;
  if (d.height) body.sizeHeight = d.height;
  if (formId) body.paymentForms = [{ id: formId, vat }];
  if (tags.some((t) => /^довантаження$/i.test(String(t).trim()))) body.groupage = true;
  const prepay = tags.map((t) => String(t).match(/передоплата:\s*(\d+)\s*%/i)).find(Boolean);
  if (prepay) body.paymentPrepay = parseInt(prepay[1], 10);

  // Lardi приймає примітку до 100 символів: спершу текст із налаштувань і ручна примітка, потім теги Della
  const noteParts = [];
  if (ctx.note) noteParts.push(String(ctx.note).trim());
  if (load.note) noteParts.push(String(load.note).trim());
  const extraTags = tags.filter((t) => !/^(пдв|довантаження)$/i.test(String(t).trim()) && !/^(дов|шир|вис)=/.test(t));
  let note = noteParts.filter(Boolean).join('. ');
  let tagSep = note ? '. ' : '';
  for (const t of extraTags) {
    const next = note + tagSep + t;
    if (next.length > LIMITS.note) break;
    note = next;
    tagSep = ', ';
  }
  if (note) body.note = clip(note, LIMITS.note);
  return body;
}

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

export class LardiClient {
  /**
   * @param {{token:string, fetch?:Function, cache?:{get:Function,set:Function}, sleep?:Function, language?:string, maxRetries?:number}} opts
   * cache.get(key) → value|undefined, cache.set(key, value, ttlMs)
   */
  constructor(opts = {}) {
    this.token = opts.token || '';
    this.fetch = opts.fetch || ((...a) => globalThis.fetch(...a));
    this.cache = opts.cache || null;
    this.sleep = opts.sleep || sleepDefault;
    this.language = opts.language || 'uk';
    this.maxRetries = opts.maxRetries ?? 4;
  }

  async request(method, path, { query = {}, body } = {}) {
    if (!this.token) throw new LardiError('не задано API-токен Lardi', 0);
    const url = new URL(LARDI_BASE + path);
    url.searchParams.set('language', this.language);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.set(k, v);
    }
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await this.fetch(url.toString(), {
          method,
          headers: {
            Authorization: this.token,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (attempt < this.maxRetries) { await this.sleep(backoff(attempt++)); continue; }
        throw new LardiError(`мережа: ${e.message || e}`, 0);
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < this.maxRetries) {
          const ra = parseFloat(res.headers && res.headers.get ? res.headers.get('Retry-After') : '');
          await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60000) : backoff(attempt));
          attempt++;
          continue;
        }
      }
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!res.ok) throw new LardiError(`Lardi ${res.status}: ${errorText(data)}`, res.status, data);
      return data;
    }
  }

  async cached(key, ttlMs, loader) {
    if (this.cache) {
      const v = await this.cache.get(key);
      if (v !== undefined && v !== null) return v;
    }
    const v = await loader();
    if (this.cache && v !== undefined && v !== null) await this.cache.set(key, v, ttlMs);
    return v;
  }

  /** Проверка токена — дешёвый авторизованный запрос. */
  async test() {
    try {
      const data = await this.request('GET', '/proposals/my/cargoes/published', { query: { page: 1, size: 1 } });
      const total = data && data.paginator ? data.paginator.totalSize : undefined;
      return { ok: true, name: total !== undefined ? `токен дійсний, опубліковано вантажів: ${total}` : 'токен дійсний' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  me() { return this.test(); }

  async bodyTypes() {
    return this.cached('lardi:bodyTypes', 7 * 864e5, () => this.request('GET', '/references/body/types'));
  }

  async paymentUnits() {
    return this.cached('lardi:paymentUnits', 7 * 864e5, () => this.request('GET', '/references/payment/units'));
  }

  /** id единицы оплаты «за рейс/за перевезення», если есть в справочнике. */
  async tripPaymentUnitId() {
    try {
      const units = await this.paymentUnits();
      const u = (units || []).find((x) => /рейс|перевез|поїзд|поезд|trip|весь|всю/i.test(x.name || ''));
      return u ? u.id : undefined;
    } catch {
      return undefined;
    }
  }

  async areas() {
    return this.cached('lardi:areas:UA', 30 * 864e5, async () => {
      try {
        return await this.request('GET', '/references/areas', { query: { countrySigns: 'UA' } });
      } catch {
        return [];
      }
    });
  }

  /**
   * Город Della → {townId, townName, areaId, countrySign}. Кэш в IndexedDB через this.cache.
   * Бросает NeedsReviewError, если однозначного совпадения нет.
   */
  async townByName(name, region = '') {
    const clean = normName(name);
    if (clean.length < 3) throw new NeedsReviewError(`назва міста «${name}» коротша за 3 символи`);
    const key = `lardi:town:${clean}|${normName(region)}`;
    return this.cached(key, 90 * 864e5, async () => {
      const list = await this.request('GET', '/references/towns/by/name', {
        query: { query: String(name).trim(), countrySigns: 'UA', limit: 50 },
      });
      const towns = Array.isArray(list) ? list : (list && list.content) || [];
      let cands = towns.filter((t) => normName(t.name) === clean);
      if (!cands.length && towns.length === 1) cands = towns;
      if (!cands.length) throw new NeedsReviewError(`місто «${name}» не знайдено в Lardi`);
      let pick = cands[0];
      if (cands.length > 1 && region) {
        const areas = await this.areas();
        const stem = normName(region).split(/[\s,]+/)[0].slice(0, 5);
        const area = (areas || []).find((a) => normName(a.name).startsWith(stem));
        const byArea = area && cands.find((t) => t.areaId === area.id);
        if (byArea) pick = byArea;
      }
      return { townId: pick.id, townName: pick.name, areaId: pick.areaId, countrySign: pick.countrySign || 'UA' };
    });
  }

  /** Собрать тело заявки: города, кузов, единица оплаты. */
  async prepareCargo(load, settings = {}) {
    const [from, to, types, unitId] = await Promise.all([
      this.townByName(load.fromCity, load.fromRegion),
      this.townByName(load.toCity, load.toRegion),
      this.bodyTypes(),
      this.tripPaymentUnitId(),
    ]);
    const bodyIds = resolveBodyIds(load.body, types);
    const note = settings.lardi && settings.lardi.note;
    return buildCargoBody(load, { bodyIds, from, to, paymentUnitId: unitId, note });
  }

  async addCargo(load, settings) {
    const body = await this.prepareCargo(load, settings);
    const res = await this.request('POST', '/proposals/my/add/cargo', { body });
    if (!res || !res.id) throw new LardiError('Lardi не повернув id заявки', 200, res);
    return { id: res.id, body };
  }

  async updateCargo(id, load, settings, status = 'published') {
    const body = await this.prepareCargo(load, settings);
    return this.request('PUT', `/proposals/my/cargo/${encodeURIComponent(status)}/${encodeURIComponent(id)}`, { body });
  }

  async throwToBasket(cargoIds = []) {
    const ids = cargoIds.filter(Boolean);
    if (!ids.length) return { ok: true };
    return this.request('POST', '/proposals/my/basket/throw', { body: { cargoIds: ids, lorryIds: [] } });
  }

  async listMyPublished(page = 1, size = 100) {
    return this.request('GET', '/proposals/my/cargoes/published', { query: { page, size } });
  }
}

function backoff(attempt) {
  return Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 300);
}

function errorText(data) {
  if (!data) return 'порожня відповідь';
  if (typeof data === 'string') return data.slice(0, 300);
  if (data.message) {
    const list = data.wrongFields || data.details || data.errors;
    const details = Array.isArray(list)
      ? ' — ' + list.map((d) => [d.fieldName || d.field, d.message].filter(Boolean).join(': ') || JSON.stringify(d)).join('; ')
      : '';
    return data.message + details;
  }
  return JSON.stringify(data).slice(0, 300);
}
