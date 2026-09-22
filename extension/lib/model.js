// Чистая логика модели Load: создание, слияние при повторном сборе, маскирование токенов.

export const STATUSES = ['new', 'queued', 'published', 'needs_review', 'error', 'inactive', 'deleted'];

/** Поля, которые можно менять руками через loads.update. */
export const EDITABLE_FIELDS = [
  'dateFrom', 'dateTo', 'fromCity', 'fromRegion', 'toCity', 'toRegion', 'distanceKm', 'cargo', 'body',
  'weight', 'volume', 'price', 'pricePerKm', 'currency', 'payment', 'tags', 'directCustomer', 'company',
  'phone', 'note',
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
    for (const k of ['phone', 'company', 'postedAt', 'volume', 'distanceKm', 'pricePerKm']) {
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

/** Индексы аккаунтов, которые реально участвуют в публикации. */
export function activeAccounts(settings) {
  const accs = (settings.lardi && settings.lardi.accounts) || [];
  const dry = settings.lardi && settings.lardi.dryRun;
  return accs
    .map((a, i) => ({ ...a, index: i }))
    .filter((a) => a.enabled && (dry || a.token));
}

/** Успешная (живая) публикация на аккаунте. */
export function isLiveOn(load, accountIndex) {
  return (load.lardi || []).some((e) => e.account === accountIndex && e.id && e.status === 'published');
}

/** На какие аккаунты ещё нужно опубликовать заявку в текущем режиме. */
export function accountsNeeded(load, settings, rrPointer = 0) {
  const accs = activeAccounts(settings);
  if (!accs.length) return [];
  const dry = !!settings.lardi.dryRun;
  const done = (i) => (load.lardi || []).some((e) => e.account === i
    && (dry ? (e.status === 'dry' || e.status === 'published') : e.status === 'published'));
  if (settings.lardi.mode === 'roundrobin') {
    if (accs.some((a) => done(a.index))) return [];
    // закреплённый аккаунт, если уже выбирали (например, прошлый dry-run или ошибка)
    const pinned = (load.lardi || []).map((e) => e.account).find((i) => accs.some((a) => a.index === i));
    if (pinned !== undefined) return [pinned];
    return [accs[rrPointer % accs.length].index];
  }
  return accs.filter((a) => !done(a.index)).map((a) => a.index);
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
