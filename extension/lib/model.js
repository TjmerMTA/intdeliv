// Чистая логика модели Load: создание, слияние при повторном сборе, маскирование токенов.

export const STATUSES = ['new', 'queued', 'published', 'needs_review', 'error', 'inactive', 'deleted'];

/** Поля, которые можно менять руками через loads.update. */
export const EDITABLE_FIELDS = [
  'dateFrom', 'dateTo', 'fromCity', 'fromRegion', 'toCity', 'toRegion', 'distanceKm', 'cargo', 'body',
  'weight', 'volume', 'price', 'pricePerKm', 'currency', 'payment', 'tags', 'directCustomer', 'company',
  'phone', 'edrpou', 'note',
];

/** Новая запись из результата парсера (уже с id/fingerprint). */
export function newLoad(parsed, now = Date.now()) {
  return {
    ...parsed,
    status: 'new',
    lardi: [],
    seenAt: now,
    firstSeenAt: now,
    updatedAt: now,
  };
}

/**
 * Повторно увидели заявку в выдаче Della: обновляем только seenAt (и признак удаления на Della).
 * Поля не перезатираем никогда — ни при edited, ни без него (отпечаток и так совпадает).
 * Заявку, помеченную неактуальной только из-за «не видно в Della», возвращаем в работу.
 */
export function mergeSeen(existing, parsed, now = Date.now()) {
  const next = { ...existing, seenAt: now };
  if (!existing.edited && parsed) {
    // заполняем то, чего раньше не было (например, телефон у залогиненной сессии)
    for (const k of ['phone', 'company', 'edrpou', 'dellaCompanyId', 'postedAt', 'volume', 'distanceKm', 'pricePerKm']) {
      if (next[k] === undefined && parsed[k] !== undefined) next[k] = parsed[k];
    }
  }
  if (parsed && parsed.dellaDeleted && !existing.dellaDeleted) next.dellaDeleted = true;
  if (existing.status === 'inactive' && existing.inactiveKind === 'stale' && !(parsed && parsed.dellaDeleted)) {
    next.status = 'new';
    next.statusReason = 'знову з’явилася в Della';
    delete next.inactiveKind;
    next.lardi = (existing.lardi || []).filter((e) => e.status !== 'removed');
    next.updatedAt = now;
  }
  return next;
}

/** Применить ручную правку. */
export function applyPatch(load, patch = {}, now = Date.now()) {
  const next = { ...load };
  let changed = false;
  for (const k of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      next[k] = patch[k];
      changed = true;
    }
  }
  if (changed) {
    next.edited = true;
    if (next.price && next.distanceKm && !Object.prototype.hasOwnProperty.call(patch, 'pricePerKm')) {
      next.pricePerKm = Math.round((next.price / next.distanceKm) * 100) / 100;
    }
  }
  next.updatedAt = now;
  return next;
}

export function maskToken(token) {
  const t = String(token || '');
  if (!t) return '';
  return '••••' + t.slice(-4);
}

export function isMasked(token) {
  return typeof token === 'string' && token.startsWith('••');
}

/**
 * Стабильный id аккаунта Lardi. В записях публикаций (load.lardi[].account) и счётчиках хранится именно он.
 * Старые настройки без id: id = позиция в списке — так прежние записи (account: 0/1) остаются верными.
 */
export function accountId(acc, i) {
  return acc && Number.isInteger(acc.id) ? acc.id : i;
}

/** Аккаунты, которые реально участвуют в публикации: включён, подключён (есть токен) и токен не отклонён. Без токена — «очікує підключення». */
export function activeAccounts(settings) {
  const accs = (settings.lardi && settings.lardi.accounts) || [];
  return accs
    .map((a, i) => ({ ...a, id: accountId(a, i) }))
    .filter((a) => a.enabled && a.token && !a.archived && a.state !== 'invalid'); // invalid — Lardi відхилив токен
}

/** Успешная (живая) публикация на аккаунте. */
export function isLiveOn(load, accId) {
  return (load.lardi || []).some((e) => e.account === accId && e.id && e.status === 'published');
}

/** На какие аккаунты (id) ещё нужно опубликовать заявку в текущем режиме. */
export function accountsNeeded(load, settings, rrPointer = 0) {
  const accs = activeAccounts(settings);
  if (!accs.length) return [];
  const dry = !!settings.lardi.dryRun;
  const done = (id) => (load.lardi || []).some((e) => e.account === id
    && (dry ? (e.status === 'dry' || e.status === 'published') : e.status === 'published'));
  if (settings.lardi.mode === 'roundrobin') {
    if (accs.some((a) => done(a.id))) return [];
    // закреплённый аккаунт, если уже выбирали (например, прошлый dry-run или ошибка)
    const pinned = (load.lardi || []).map((e) => e.account).find((id) => accs.some((a) => a.id === id));
    if (pinned !== undefined) return [pinned];
    return [accs[rrPointer % accs.length].id];
  }
  return accs.filter((a) => !done(a.id)).map((a) => a.id);
}

export function upsertLardiEntry(load, entry) {
  const list = (load.lardi || []).filter((e) => e.account !== entry.account);
  const prev = (load.lardi || []).find((e) => e.account === entry.account) || {};
  list.push({ ...prev, ...entry });
  list.sort((a, b) => a.account - b.account);
  return { ...load, lardi: list };
}

/** Короткое описание заявки для логов. */
export function describe(load) {
  const price = load.price ? `${load.price} ${load.currency === 'UAH' ? 'грн' : load.currency}` : 'без ціни';
  return `${load.fromCity} → ${load.toCity}, ${load.cargo || '—'}, ${load.weight ?? '?'} т, ${price}, ${load.dateFrom}`;
}

// ---------- замовник: ключі для чорного / білого списку ----------
// Анонімна видача Della не показує замовника (S0, 28.09.2026). Ключі беруться з того, що є в заявці:
// код компанії Della (лише з сесією DELLA_COOKIE) → ЄДРПОУ/ІПН → телефон → назва (у т. ч. вписані вручну).
// Заявка належить замовнику, якщо збігся хоч один ключ. data-request_id / fingerprint ключами не бувають.

const LEGAL_FORMS = new Set(['тов', 'тзов', 'пп', 'фоп', 'флп', 'спд', 'прат', 'пат', 'ат', 'дп', 'кп', 'тдв', 'пф',
  'ооо', 'зао', 'оао', 'чп', 'ип', 'llc', 'ltd']);
/** Назви, які нічого не кажуть про конкретного замовника. */
const NAME_STOP = new Set(['фоп', 'приватна особа', 'частное лицо', 'фізична особа', 'физическое лицо', 'транспортна компанія',
  'транспортная компания', 'логістика', 'логистика', 'замовник', 'заказчик', 'компанія', 'компания']);

/** «ТОВ «Логістик-Плюс»» і «логістик-плюс, тов» → «логістик-плюс». */
export function normCompany(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[’ʼ`]/g, "'").replace(/["«»„“”]/g, ' ')
    .split(/[^\p{L}\p{N}'-]+/u).map((t) => t.replace(/^['-]+|['-]+$/g, ''))
    .filter((t) => t && !LEGAL_FORMS.has(t)).join(' ');
}

/** Телефон України → 380XXXXXXXXX (12 цифр): +38 (050) 123-45-67, 0501234567, 380501234567, 501234567. */
export function phoneKey(s) {
  const d = String(s || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('380')) return d;
  if (d.length === 10 && d.startsWith('0')) return '38' + d;
  if (d.length === 9) return '380' + d;
  return '';
}

/** ЄДРПОУ (8 цифр) або ІПН ФОП (10 цифр). */
export function edrpouKey(s) {
  const d = String(s || '').replace(/\D/g, '');
  return d.length === 8 || d.length === 10 ? d : '';
}

/** Ключ за назвою (найслабший): ≥ 4 символів і не з переліку загальних назв. */
export function nameKey(s) {
  const n = normCompany(s);
  return n.replace(/[\s'-]/g, '').length >= 4 && !NAME_STOP.has(n) ? n : '';
}

/**
 * Ключі замовника від найнадійнішого до найслабшого.
 * c — заявка ({dellaCompanyId, edrpou, phone, company}) або запис списку ({dellaId, edrpou, phone, name}).
 */
export function customerKeys(c = {}) {
  const keys = [];
  const add = (k) => { if (!keys.includes(k)) keys.push(k); };
  const did = String(c.dellaCompanyId ?? c.dellaId ?? '').trim();
  if (/^[\w-]+$/.test(did)) add('della:' + did);
  const e = edrpouKey(c.edrpou);
  if (e) add('edrpou:' + e);
  for (const p of String(c.phone || '').split(/[,;]/)) {
    const k = phoneKey(p);
    if (k) add('tel:' + k);
  }
  const n = nameKey(c.company ?? c.name);
  if (n) add('name:' + n);
  return keys;
}

/** Ключ лише за назвою — може збігтися з іншою компанією (UI попереджає). */
export const weakKeys = (keys) => keys.length > 0 && keys.every((k) => k.startsWith('name:'));

/** Ручне введення на вкладці «Замовники»: одне поле → телефон / ЄДРПОУ / код Della / назва. */
export function parseCustomerInput(text) {
  const t = String(text || '').trim();
  const d = t.replace(/\D/g, '');
  if (/^della:/i.test(t)) return { dellaId: t.slice(6).trim() };
  if (/^[\d\s()+-]+$/.test(t)) {
    if (phoneKey(t) && !(d.length === 8 || (d.length === 10 && !d.startsWith('0')))) return { phone: t };
    if (edrpouKey(t)) return { edrpou: d };
    return {};
  }
  return { name: t };
}

/** Значення колонки loads.custKeys: «|tel:380…|name:…|» — пошук через instr(custKeys, '|' || key || '|'). */
export function custKeysColumn(load) {
  const keys = customerKeys(load);
  return keys.length ? '|' + keys.join('|') + '|' : '';
}
