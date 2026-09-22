// Локальные фильтры заявок. Чистые функции — без chrome.*.

const norm = (s) => String(s || '').toLowerCase().replace(/[’ʼ`]/g, "'").replace(/\s+/g, ' ').trim();

/** Основа названия области: «Київська обл.» → «київськ», «Київ обл.» → «київ». */
export function regionStem(s) {
  const word = norm(s)
    .split(/[\s,]+/)
    .filter((t) => t && !/^(обл\.?|область|р-н|район|м\.)$/.test(t))[0] || '';
  return word.replace(/\.$/, '').replace(/(ська|цька|зька|ський|ка|ий|а)$/u, '');
}

export function regionMatches(region, list) {
  if (!list || !list.length) return false;
  const r = regionStem(region);
  if (!r) return false;
  return list.some((x) => {
    const s = regionStem(x);
    return s && (r.startsWith(s) || s.startsWith(r));
  });
}

export function todayIso(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Дата погрузки уже прошла? (dateTo, иначе dateFrom, строго меньше сегодняшней) */
export function isDatePassed(load, now = new Date()) {
  const last = load.dateTo || load.dateFrom;
  return !!last && last < todayIso(now);
}

/**
 * @returns {{pass: boolean, reason?: string}}
 */
export function applyFilters(load, filters = {}, now = new Date()) {
  const f = filters || {};
  if (load.dellaDeleted) return { pass: false, reason: 'видалена на Della' };
  if (isDatePassed(load, now)) return { pass: false, reason: 'дата завантаження минула' };

  const minPrice = Number(f.minPrice) || 0;
  if (minPrice > 0) {
    if (!load.price) return { pass: false, reason: 'без ціни' };
    if ((load.currency || 'UAH') === 'UAH' && load.price < minPrice) {
      return { pass: false, reason: `ціна ${load.price} < ${minPrice}` };
    }
  }
  if (f.directOnly && !load.directCustomer) return { pass: false, reason: 'не прямий замовник' };

  if (Array.isArray(f.bodies) && f.bodies.length) {
    const b = norm(load.body);
    const ok = f.bodies.some((x) => {
      const y = norm(x);
      return y && (b === y || b.includes(y) || y.includes(b));
    });
    if (!ok) return { pass: false, reason: `кузов «${load.body}» не в списку` };
  }
  if (Array.isArray(f.fromRegions) && f.fromRegions.length && !regionMatches(load.fromRegion, f.fromRegions)) {
    return { pass: false, reason: `область завантаження «${load.fromRegion}» не в списку` };
  }
  if (Array.isArray(f.toRegions) && f.toRegions.length && !regionMatches(load.toRegion, f.toRegions)) {
    return { pass: false, reason: `область розвантаження «${load.toRegion}» не в списку` };
  }
  if (Array.isArray(f.excludeRegions) && f.excludeRegions.length) {
    if (regionMatches(load.fromRegion, f.excludeRegions)) return { pass: false, reason: `виключена область «${load.fromRegion}»` };
    if (regionMatches(load.toRegion, f.excludeRegions)) return { pass: false, reason: `виключена область «${load.toRegion}»` };
  }
  if (Array.isArray(f.stopWords) && f.stopWords.length) {
    const hay = norm([load.cargo, ...(load.tags || [])].join(' '));
    const hit = f.stopWords.map(norm).find((w) => w && hay.includes(w));
    if (hit) return { pass: false, reason: `стоп-слово «${hit}»` };
  }
  const maxAge = Number(f.maxAgeHours) || 0;
  if (maxAge > 0 && load.postedAt) {
    const t = now instanceof Date ? now.getTime() : Number(now);
    if (t - load.postedAt > maxAge * 3600e3) return { pass: false, reason: `старша за ${maxAge} год` };
  }
  return { pass: true };
}
