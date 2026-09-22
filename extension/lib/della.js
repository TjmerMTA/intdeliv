// Разбор HTML выдачи Della строками/regex (в service worker нет DOMParser).
// Модуль не трогает chrome.* — импортируется и в node-тестах.

export const DELLA_ORIGIN = 'https://della.com.ua';

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', hellip: '…', rsquo: '’', lsquo: '‘', times: '×', deg: '°', sup3: '³',
};

export function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Текст без тегов, entities раскодированы, пробелы схлопнуты. */
export function textOf(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '))
    .replace(/[\s ]+/g, ' ')
    .trim();
}

function attrClassRe(cls) {
  return new RegExp(`class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>([\\s\\S]*?)</(?:div|span|a)>`, 'i');
}

/** Внутренний HTML первого простого (без вложенных div) элемента с классом. */
function inner(html, cls) {
  const m = html.match(attrClassRe(cls));
  return m ? m[1] : '';
}

export function parseNumber(s) {
  if (s == null) return undefined;
  const t = String(s).replace(/[\s ]/g, '').replace(',', '.');
  const m = t.match(/-?\d+(?:\.\d+)?/);
  if (!m) return undefined;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** '22.09' → 'YYYY-MM-DD' с выводом года относительно now. */
export function inferDate(dd, mm, now = new Date()) {
  const d = parseInt(dd, 10);
  const m = parseInt(mm, 10);
  if (!d || !m) return undefined;
  const curM = now.getMonth() + 1;
  let y = now.getFullYear();
  if (m < curM - 6) y += 1;          // январь при текущем сентябре → следующий год
  else if (m > curM + 6) y -= 1;     // декабрь при текущем январе → прошлый год
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export function parseDateRange(raw, now = new Date()) {
  const t = decodeEntities(raw).replace(/\s+/g, '');
  const ms = [...t.matchAll(/(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/g)];
  if (!ms.length) return {};
  const toIso = (m) => {
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
      return `${y}-${pad2(m[2])}-${pad2(m[1])}`;
    }
    return inferDate(m[1], m[2], now);
  };
  const dateFrom = toIso(ms[0]);
  let dateTo = ms[1] ? toIso(ms[1]) : undefined;
  // диапазон через Новый год: 28.12–03.01
  if (dateTo && dateTo < dateFrom) dateTo = `${parseInt(dateTo.slice(0, 4), 10) + 1}${dateTo.slice(4)}`;
  return { dateFrom, dateTo };
}

/** Из title «Рівненський р-н, Рівненська обл.» — часть, оканчивающаяся на «обл.», иначе весь title. */
export function regionFromTitle(title) {
  const t = decodeEntities(title || '').trim();
  const parts = t.split(',').map((p) => p.trim()).filter(Boolean);
  const obl = parts.find((p) => /обл\.?$/i.test(p));
  return obl || t;
}

const PAYMENT_RULES = [
  // порядок важен: «Безготівковий» содержит «готівк»
  { re: /безгот|безнал|б\/н|безготівк/i, value: 'Безнал' },
  { re: /картк|на карту|карта/i, value: 'Картка' },
  { re: /готівк|наличн|готівка|нал\b/i, value: 'Готівка' },
];

export function paymentFromTag(tag) {
  for (const r of PAYMENT_RULES) if (r.re.test(tag)) return r.value;
  return undefined;
}

const CURRENCY_RE = /(\d[\d\s]*(?:[.,]\d+)?)\s*(грн|uah|usd|eur|\$|€)/gi;

export function parsePrice(priceHtml) {
  // убираем всплывающие подсказки («Вартість фрахту збільшена на 1000 грн») целиком
  let h = String(priceHtml || '').replace(/<div class="tooltip[\s\S]*?<\/div>/gi, ' ');
  // «20<span style="color:#FFFFFF;">&nbsp;</span>000» — тег-разделитель тысяч склеиваем без пробела
  h = h.replace(/<span[^>]*>\s*(?:&nbsp;|\s)\s*<\/span>/gi, ' ');
  const text = decodeEntities(h.replace(/<[^>]*>/g, '\n')).replace(/ /g, ' ');
  let last = null;
  for (const m of text.matchAll(CURRENCY_RE)) last = m;
  if (!last) return {};
  const price = parseNumber(last[1]);
  const c = last[2].toLowerCase();
  const currency = c === 'usd' || c === '$' ? 'USD' : c === 'eur' || c === '€' ? 'EUR' : 'UAH';
  return { price, currency };
}

/** Ищем все карточки: возвращает [{start, end, html, tail}] */
function splitCards(html) {
  const re = /<div class="request_card(\s[^"]*)?"\s+data-request_id="([^"]*)"/g;
  const starts = [];
  let m;
  while ((m = re.exec(html))) starts.push({ index: m.index, cls: m[1] || '', rid: m[2] });
  return starts.map((s, i) => {
    const next = i + 1 < starts.length ? starts[i + 1].index : html.length;
    const seg = html.slice(s.index, next);
    const cut = seg.indexOf('requests_cards_delimiter');
    return {
      cls: s.cls,
      rid: s.rid,
      html: cut > 0 ? seg.slice(0, cut) : seg,
      tail: cut > 0 ? seg.slice(cut) : '',
    };
  });
}

function parseAgoSeconds(txt) {
  const t = textOf(txt).toLowerCase();
  const m = t.match(/(\d+)\s*(сек|хв|мин|год|час|дн|день|доб)/);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  const u = m[2];
  if (u.startsWith('сек')) return n;
  if (u === 'хв' || u === 'мин') return n * 60;
  if (u === 'год' || u === 'час') return n * 3600;
  return n * 86400;
}

/**
 * Разбор страницы выдачи. Возвращает частичные Load (без id/status/lardi/seen*),
 * плюс служебные поля: dellaDeleted, postedAt, dellaRequestId.
 */
export function parseDellaSearch(html, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const dellaUrl = opts.url;
  const out = [];
  for (const card of splitCards(String(html || ''))) {
    const c = card.html;
    const { dateFrom, dateTo } = parseDateRange(inner(c, 'date_add'), now);

    // маршрут
    const routeStart = c.indexOf('class="request_route"');
    let routeHtml = '';
    if (routeStart >= 0) {
      const routeEnd = c.indexOf('request_text_n_tags', routeStart);
      routeHtml = c.slice(routeStart, routeEnd > 0 ? routeEnd : undefined);
    }
    const points = [...routeHtml.matchAll(/<span title="([^"]*)">\s*<span class="locality">([\s\S]*?)<\/span>\s*(?:\(([A-Z]{2})\))?/g)]
      .map((m) => ({ region: regionFromTitle(m[1]), city: textOf(m[2]), country: m[3] || 'UA' }));
    const citiesM = routeHtml.match(/cities=([\d,]+)/);
    const cityIds = citiesM ? citiesM[1].split(',').filter(Boolean) : [];
    const distM = routeHtml.match(/class="distance"[^>]*>([\s\S]*?)<\/a>/);
    const distanceKm = distM ? parseNumber(textOf(distM[1])) : undefined;

    const from = points[0] || {};
    const to = points.length > 1 ? points[points.length - 1] : {};

    // груз
    const textBlock = (c.match(/class="request_text">([\s\S]*?)<\/div>/) || [])[1] || '';
    const cargo = textOf(inner(c, 'cargo_type'));
    const dimsText = textOf(textBlock.replace(/<span class="cargo_type">[\s\S]*?<\/span>/, ''))
      .replace(/\s*=\s*/g, '=').replace(/^\(|\)$/g, '').trim();
    const dims = {};
    for (const m of dimsText.matchAll(/(дов|шир|вис)=([\d.,]+)/g)) {
      dims[{ дов: 'length', шир: 'width', вис: 'height' }[m[1]]] = parseNumber(m[2]);
    }

    // теги: request_tags + price_tags; оплата выделяется отдельно
    const tags = [];
    let payment;
    const tagHtml = (c.match(/class="request_tags">([\s\S]*?<\/div>)\s*<\/div>/) || [])[1] || '';
    const priceTagsHtml = (c.match(/class="price_tags">([\s\S]*?<\/div>)\s*<\/div>/) || [])[1] || '';
    for (const src of [tagHtml, priceTagsHtml]) {
      for (const m of src.matchAll(/<div class="tag">([\s\S]*?)<\/div>/g)) {
        const t = textOf(m[1]);
        if (!t) continue;
        const p = paymentFromTag(t) || (src === priceTagsHtml && /^будь-як/i.test(t) ? 'Будь-яка' : undefined);
        if (p && !payment) { payment = p; continue; }
        if (p) continue;
        if (!tags.includes(t)) tags.push(t);
      }
    }
    if (dimsText && /=/.test(dimsText)) tags.push(dimsText);
    if (points.length > 2) tags.push('Через: ' + points.slice(1, -1).map((p) => p.city).join(', '));

    // цена
    const pmStart = c.indexOf('class="price_main"');
    let priceHtml = '';
    if (pmStart >= 0) {
      const endCandidates = ['class="price_additional"', 'class="price_tags"', 'class="request_info_show"']
        .map((k) => c.indexOf(k, pmStart)).filter((i) => i > 0);
      priceHtml = c.slice(pmStart + 'class="price_main"'.length, endCandidates.length ? Math.min(...endCandidates) : undefined);
    }
    const { price, currency } = parsePrice(priceHtml);
    const ppkText = textOf(inner(c, 'price_additional'));
    let pricePerKm = /км/.test(ppkText) ? parseNumber(ppkText) : undefined;
    if (pricePerKm === undefined && price && distanceKm) pricePerKm = Math.round((price / distanceKm) * 100) / 100;

    const weight = parseNumber(textOf(inner(c, 'weight')));
    const cubeText = textOf(inner(c, 'cube'));
    let volume = /м(?:³|3)/.test(cubeText) ? parseNumber(cubeText) : undefined;
    if (volume === undefined) {
      const vm = textOf(textBlock).match(/(\d+(?:[.,]\d+)?)\s*м(?:³|3)(?![\d])/);
      if (vm) volume = parseNumber(vm[1]);
    }

    // время добавления
    let postedAt;
    const du = card.tail.match(/dateup="(\d{9,})"/);
    if (du) postedAt = parseInt(du[1], 10) * 1000;
    else {
      const ago = parseAgoSeconds(inner(c, 'time_string') || (c.match(/class="time_string[^"]*">([\s\S]*?)<\/div>/) || [])[1]);
      if (ago !== undefined) postedAt = now.getTime() - ago * 1000;
    }

    // компания/телефон — видны только в залогиненной сессии (вёрстка может отличаться)
    const company = textOf(inner(c, 'company_name') || inner(c, 'firm_name')) || undefined;
    const phoneM = textOf(c).match(/\+?38\s?\(?0\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/);

    const load = {
      source: 'della',
      dateFrom,
      dateTo: dateTo && dateTo !== dateFrom ? dateTo : undefined,
      fromCity: from.city || '',
      fromRegion: from.region || '',
      fromCityId: cityIds[0],
      toCity: to.city || '',
      toRegion: to.region || '',
      toCityId: cityIds.length > 1 ? cityIds[cityIds.length - 1] : undefined,
      distanceKm,
      cargo,
      body: textOf(inner(c, 'truck_type')).toLowerCase(),
      weight,
      volume,
      price,
      pricePerKm,
      currency: currency || 'UAH',
      payment,
      tags,
      directCustomer: /is_zirka_img/.test(c),
      company,
      phone: phoneM ? phoneM[0] : undefined,
      dellaUrl,
      dellaRequestId: card.rid ? card.rid.slice(0, 32) : undefined,
      dellaDeleted: /\bdeleted\b/.test(card.cls),
      postedAt,
      dims: Object.keys(dims).length ? dims : undefined,
    };
    for (const k of Object.keys(load)) if (load[k] === undefined) delete load[k];
    load.fingerprint = fingerprintOf(load);
    out.push(load);
  }
  return out;
}

export function fingerprintOf(load) {
  const norm = (v) => (v === undefined || v === null ? '' : String(v).trim().toLowerCase());
  return [load.fromCityId || norm(load.fromCity), load.toCityId || norm(load.toCity), norm(load.cargo),
    norm(load.weight), norm(load.price), norm(load.dateFrom)].join('|');
}

export async function sha1Hex(str) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('crypto.subtle недоступний');
  const buf = await subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Добавляет fingerprint и id ('d_' + sha1). */
export async function withIdentity(load) {
  const fingerprint = load.fingerprint || fingerprintOf(load);
  return { ...load, fingerprint, id: 'd_' + (await sha1Hex(fingerprint)) };
}

export async function parseDellaSearchWithIds(html, opts = {}) {
  return Promise.all(parseDellaSearch(html, opts).map(withIdentity));
}

/** Страница N (с 0): суффикс r{offset}l25 перед .html; существующий rNlN заменяется. */
export function buildPageUrl(searchUrl, pageIndex = 0) {
  const u = String(searchUrl || '').trim();
  const m = u.match(/^(.*?)(r\d+l\d+)?\.html((?:[?#].*)?)$/);
  if (!m) return u;
  const offset = Math.max(0, pageIndex | 0) * 25;
  return `${m[1]}${offset > 0 ? `r${offset}l25` : ''}.html${m[3] || ''}`;
}
