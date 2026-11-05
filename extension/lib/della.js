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

const PHONE_RE = /\+?38\s?\(?0\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g;

/**
 * Чи віддала Della сторінку як залогіненому: 'out' | 'in' | 'unknown'.
 * Доведено лише ознаки «без входу» (анонімна видача, tests/fixtures/della-search.html, і жива 05.11.2026):
 * у шапці <div id="unlogged_div" style="display:block;"> із кнопкою «Вхід», а «Докладніше» в картці —
 * onclick="register();". Залогіненої сторінки ми не бачили, тож 'in' — це «блок без входу є, але схований»;
 * якщо немає жодної з ознак — 'unknown' (верстку змінили, капча тощо), а не здогадка.
 */
export function dellaLoginState(html) {
  const h = String(html || '');
  const head = h.match(/<div\b[^>]*\bid=["']unlogged_div["'][^>]*>/i);
  if (head) {
    const style = (head[0].match(/\bstyle=["']([^"']*)["']/i) || [])[1] || '';
    return /display\s*:\s*none/i.test(style) ? 'in' : 'out';
  }
  if (/class=["']show_request_info_btn["'][^>]*\bonclick=["']\s*register\(/i.test(h)) return 'out';
  return 'unknown';
}

/**
 * Код і назва компанії поза карткою: JS Della («сховати компанію», hideRequestOrCompany, живий 05.11.2026) бере їх
 * з елемента #hide_request_or_company_hidden_<request_code> атрибутами data-company-code / data-company-name;
 * request_code = data-request_id картки. На анонімній сторінці цих елементів немає. → Map(request_code → {code, name})
 */
function hiddenCompanies(html) {
  const out = new Map();
  for (const m of html.matchAll(/<[a-z]+\b[^>]*\bid=["']hide_request_or_company_hidden_([^"']+)["'][^>]*>/gi)) {
    const code = (m[0].match(/data-company-code=["']([\w-]+)["']/i) || [])[1];
    const name = (m[0].match(/data-company-name="([^"]*)"/i) || m[0].match(/data-company-name='([^']*)'/i) || [])[1];
    if (code || name) out.set(m[1], { code, name });
  }
  return out;
}

/** Що йде одразу після списку карток (фікстура й жива сторінка 05.11.2026; усередині карток не трапляється). */
const AFTER_LIST = ['is_subscription_pending', 'id="deny_info"', 'class="pages"', 'class="footer'];

/** Ищем все карточки: возвращает [{start, end, html, tail}] */
function splitCards(html) {
  const re = /<div class="request_card(\s[^"]*)?"\s+data-request_id="([^"]*)"/g;
  const starts = [];
  let m;
  while ((m = re.exec(html))) starts.push({ index: m.index, cls: m[1] || '', rid: m[2] });
  return starts.map((s, i) => {
    const next = i + 1 < starts.length ? starts[i + 1].index : html.length;
    const seg = html.slice(s.index, next);
    let cut = seg.indexOf('requests_cards_delimiter');
    // остання картка без роздільника: інакше до неї потрапив би низ сторінки (телефони, data-company-* інших карток)
    if (cut < 0 && i === starts.length - 1) cut = Math.min(...AFTER_LIST.map((k) => seg.indexOf(k)).filter((x) => x > 0), seg.length);
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
  const page = String(html || '');
  const hidden = page.includes('hide_request_or_company_hidden_') ? hiddenCompanies(page) : new Map();
  for (const card of splitCards(page)) {
    const c = card.html;
    const hid = hidden.get(card.rid) || {};
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
    const cardText = textOf(c);
    const company = textOf(inner(c, 'company_name') || inner(c, 'firm_name')).slice(0, 200) || undefined;
    // усі телефони картки (у чорному списку здебільшого телефони — кожен має стати ключем)
    const phones = [...new Set([...cardText.matchAll(PHONE_RE)].map((m) => m[0]))].slice(0, 5);
    // стабільний id компанії та ЄДРПОУ — для чорного/білого списку замовників (якщо Della їх показала)
    // у залогіненій сесії картка має data-company-code / data-company-name (ними ж працює «сховати компанію» Della)
    // і посилання на профіль /company/<code>/ — перевірено по JS Della 28.09.2026, на анонімній видачі їх немає
    // (живу залогінену картку не бачили — лапки атрибутів приймаємо будь-які, решту не вгадуємо)
    // точний збіг за request_code — першим
    const firmM = (hid.code ? [null, hid.code] : null) || c.match(/data-company-code=["']([\w-]+)["']/i)
      || c.match(/href=["'][^"']*\/company\/([\w-]+)\/?["']/i);
    const firmNameM = (hid.name ? [null, hid.name] : null) || c.match(/data-company-name="([^"]*)"/i) || c.match(/data-company-name='([^']*)'/i);
    const edrpouM = cardText.match(/(?:ЄДРПОУ|ЕДРПОУ|ІПН)\s*:?\s*(\d{8}(?:\d{2})?)(?!\d)/i);

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
      phone: phones.length ? phones.join(', ') : undefined,
      dellaCompanyId: firmM ? firmM[1] : undefined,
      company: company || (firmNameM ? decodeEntities(firmNameM[1]).trim().slice(0, 200) || undefined : undefined),
      edrpou: edrpouM ? edrpouM[1] : undefined,
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

// ---------- контакти «Докладніше» (лише з входом) ----------
// Доказ — JS самої Della (живий, 05.11.2026, /script/combined/39070d1e824110454b9d5bfa2730403749c3c73c.js):
//   companyDrawContacts(modes, em, fromSearch, isInList, neCfp, neE, neIs, cC, rC, rL, ri, shouldCheckByHCaptcha)
//   → POST /ajax_private_list_card.php {modes[], token, botdResponse, from_search, is_in_list, ne_cfp, ne_e, ne_is,
//     c_c, r_c, r_l, ri, em, is_hcaptcha_loaded}; token — СВІЖИЙ токен reCAPTCHA v3 (дія «companyDrawContactsAction»)
//     або BotD + hCaptcha, з браузера. Відповідь: {error} — капча не пройшла («Сталася помилка! Будь ласка, оновіть
//     сторінку»); {contact_error_alert, error_desc} — «Обмеження доступу до інформації»; {contact_modules: {id: html}}.
//   Контакти Della показує лише верифікованому акаунту: вікно toshowcontactsveriffmwnd («щоб переглянути контактну
//   інформацію, потрібно пройти верифікацію» — документ + веб-камера; Дія.ID / BankID / ЕЦП / Veriff),
//   showPrivateListDenyInfoWnd — ще й підписка/оплата.
// Сервер токена капчі не має і обходити капчу не буде — запит іде з порожнім token, Della вправі відмовити.
// Де саме в залогіненій картці стоїть виклик companyDrawContacts і з якими аргументами — не бачили (сесії немає):
// шукаємо вбудований виклик у картці; немає — запиту немає.

export const CONTACTS_PATH = '/ajax_private_list_card.php';
/** Номер України в довільному записі: +38 (067) 111-22-33, +380 67 111 22 33, 067 111 22 33, 0671112233. */
const UA_PHONE_RE = /(?<![\d+])(?:\+?38[\s(.-]*)?\(?0\s?\d{2}\)?[\s.-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}(?!\d)/g;
const CONTACT_ARGS = ['modes', 'em', 'from_search', 'is_in_list', 'ne_cfp', 'ne_e', 'ne_is', 'c_c', 'r_c', 'r_l', 'ri'];

/** Аргументи виклику JS з простих літералів (рядки, числа, true/false/!0/!1, null, масиви). Вираз — null, не здогадка. */
export function parseJsArgs(src) {
  const s = String(src);
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const val = () => {
    ws();
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      let out = '';
      for (i++; i < s.length && s[i] !== ch; i++) out += s[i] === '\\' ? s[++i] ?? '' : s[i];
      if (s[i] !== ch) throw new Error('рядок');
      i++;
      return out;
    }
    if (ch === '[') {
      const arr = [];
      i++;
      ws();
      if (s[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(val());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return arr; }
        throw new Error('масив');
      }
    }
    if (ch === '!' && (s[i + 1] === '0' || s[i + 1] === '1')) { i += 2; return s[i - 1] === '0'; }
    const m = s.slice(i).match(/^(?:-?\d+(?:\.\d+)?|true|false|null|undefined)(?![\w$])/);
    if (!m) throw new Error('вираз');
    i += m[0].length;
    if (m[0] === 'true' || m[0] === 'false') return m[0] === 'true';
    return m[0] === 'null' || m[0] === 'undefined' ? null : Number(m[0]);
  };
  try {
    const out = [];
    ws();
    if (i >= s.length) return out;
    for (;;) {
      out.push(val());
      ws();
      if (i >= s.length) return out;
      if (s[i] !== ',') return null;
      i++;
    }
  } catch {
    return null;
  }
}

/** Вбудований виклик companyDrawContacts(...) у HTML картки → поля запиту {modes, em, from_search, …} або null. */
export function contactsCallOf(cardHtml) {
  const h = String(cardHtml || '');
  const at = h.indexOf('companyDrawContacts(');
  if (at < 0) return null;
  let i = at + 'companyDrawContacts('.length;
  const start = i;
  let depth = 0;
  let q = '';
  for (; i < h.length; i++) {
    const ch = h[i];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = ''; continue; }
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === ')') { if (!depth) break; depth--; }
  }
  if (i >= h.length) return null;
  const args = parseJsArgs(decodeEntities(h.slice(start, i)));
  if (!args || args.length < CONTACT_ARGS.length || !Array.isArray(args[0]) || !args[0].length) return null;
  return Object.fromEntries(CONTACT_ARGS.map((k, n) => [k, args[n]]));
}

/** Виклики контактів на сторінці: Map(dellaRequestId → поля запиту). */
export function contactsCalls(html) {
  const out = new Map();
  for (const card of splitCards(String(html || ''))) {
    const call = contactsCallOf(card.html);
    if (call && card.rid) out.set(card.rid.slice(0, 32), call);
  }
  return out;
}

/** Тіло POST, як його будує jQuery ($.param): масив — modes[]=…; token порожній — капчі сервер не має. */
export function contactsBody(p, token = '') {
  const fields = {
    modes: p.modes, token, botdResponse: '', from_search: p.from_search, is_in_list: p.is_in_list, ne_cfp: p.ne_cfp,
    ne_e: p.ne_e, ne_is: p.ne_is, c_c: p.c_c, r_c: p.r_c, r_l: p.r_l, ri: p.ri, em: p.em, is_hcaptcha_loaded: false,
  };
  const out = [];
  const add = (k, v) => out.push(`${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : String(v))}`);
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const x of v) add(`${k}[]`, x);
    else add(k, v);
  }
  return out.join('&').replace(/%20/g, '+');
}

/**
 * Відповідь /ajax_private_list_card.php → {phone?, edrpou?} або {refused: 'captcha'|'access'|'format', desc?}.
 * Формат HTML блоків контактів не бачили: телефон — будь-який номер України (10 цифр з 0 або 12 з 380) у тексті
 * чи в href="tel:…".
 */
export function parseDellaContacts(r) {
  if (!r || typeof r !== 'object') return { refused: 'format' };
  if (r.error) return { refused: 'captcha' };
  if (r.contact_error_alert) return { refused: 'access', desc: textOf(r.error_desc || '').slice(0, 200) || undefined };
  const mods = r.contact_modules;
  if (!mods || typeof mods !== 'object') return { refused: 'format' };
  const html = Object.values(mods).map((x) => String(x ?? '')).join(' ');
  const text = textOf(html);
  const raw = [...[...text.matchAll(UA_PHONE_RE)].map((m) => m[0]),
    ...[...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map((m) => decodeEntities(m[1]))];
  const phones = [];
  const seen = new Set();
  for (const x of raw) {
    const d = x.replace(/\D/g, '');
    if (!((d.length === 10 && d[0] === '0') || (d.length === 12 && d.startsWith('380')))) continue;
    if (seen.has(d.slice(-9))) continue;
    seen.add(d.slice(-9));
    phones.push(x.trim());
  }
  const edrpouM = text.match(/(?:ЄДРПОУ|ЕДРПОУ|ІПН)\s*:?\s*(\d{8}(?:\d{2})?)(?!\d)/i);
  const out = { phone: phones.slice(0, 5).join(', ') || undefined, edrpou: edrpouM ? edrpouM[1] : undefined };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}
