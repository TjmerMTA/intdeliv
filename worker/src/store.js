// Доступ до D1: заявки, налаштування/мета, кеш, журнал, лічильники.
import { mergeSeen, newLoad, custKeysColumn } from '../../extension/lib/model.js';

export const LOG_MAX = 5000;

const lc = (v) => String(v ?? '').toLowerCase().replace(/[’ʼ`]/g, "'").trim();
const nn = (v) => (v === undefined ? null : v);

/** Екранування для LIKE ... ESCAPE '\'. */
export const likeEsc = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);

export const LISTS = ['black', 'white'];
/** SQL-умова «заявка loads належить замовнику зі списку list» (ключі — у customer_keys). */
const inList = (list) => `(loads.custKeys <> '' AND EXISTS (SELECT 1 FROM customer_keys ck WHERE ck.list = '${list}' AND instr(loads.custKeys, '|' || ck.key || '|') > 0))`;
export const IS_BLACK = inList('black');
export const IS_WHITE = inList('white');
const OF_CUSTOMER = "(loads.custKeys <> '' AND EXISTS (SELECT 1 FROM customer_keys ck WHERE ck.customerId = ? AND instr(loads.custKeys, '|' || ck.key || '|') > 0))";

function rowOf(l) {
  const search = [l.id, l.cargo, l.company, l.phone, l.edrpou, l.fromCity, l.toCity, l.fromRegion, l.toRegion,
    l.dellaRequestId, ...(l.lardi || []).map((e) => e.id)].filter((x) => x !== undefined && x !== null).join(' ');
  return {
    id: l.id,
    status: l.status || 'new',
    seenAt: l.seenAt || 0,
    firstSeenAt: l.firstSeenAt || l.seenAt || 0,
    updatedAt: l.updatedAt || 0,
    queuedAt: nn(l.queuedAt) ?? null,
    dateLast: l.dateTo || l.dateFrom || null,
    fromCity: l.fromCity || null,
    toCity: l.toCity || null,
    fromRegion: l.fromRegion || null,
    toRegion: l.toRegion || null,
    phone: l.phone || null,
    fromCityLc: lc(l.fromCity),
    toCityLc: lc(l.toCity),
    fromRegionLc: lc(l.fromRegion),
    toRegionLc: lc(l.toRegion),
    phoneDigits: String(l.phone || '').replace(/\D/g, ''),
    search: lc(search),
    lardi: JSON.stringify(l.lardi || []),
    data: JSON.stringify(l),
    custKeys: custKeysColumn(l),
  };
}

const COLS = Object.keys(rowOf({ id: 'x' }));
const UPSERT_SQL = `INSERT INTO loads (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})
  ON CONFLICT(id) DO UPDATE SET ${COLS.filter((c) => c !== 'id').map((c) => `${c}=excluded.${c}`).join(',')}`;

const parse = (s, dflt) => {
  if (s === null || s === undefined) return dflt;
  try { return JSON.parse(s); } catch { return dflt; }
};

export class Store {
  constructor(db, now = () => Date.now()) {
    this.db = db;
    this.now = now;
  }

  // ---------- міграція (лише додає — наявні дані не змінюються) ----------

  /** Стара база: колонка loads.custKeys + її заповнення з data. Ідемпотентно. Повертає кількість заповнених рядків. */
  async migrate() {
    const { results } = await this.db.prepare('PRAGMA table_info(loads)').all();
    if (!(results || []).some((c) => c.name === 'custKeys')) {
      await this.db.prepare('ALTER TABLE loads ADD COLUMN custKeys TEXT').run();
    }
    let n = 0;
    for (;;) {
      const { results: rows } = await this.db.prepare('SELECT id, data FROM loads WHERE custKeys IS NULL LIMIT 500').all();
      if (!rows || !rows.length) break;
      await this.db.batch(rows.map((r) => this.db.prepare('UPDATE loads SET custKeys = ? WHERE id = ?')
        .bind(custKeysColumn(parse(r.data, null) || {}), r.id)));
      n += rows.length;
    }
    return n;
  }

  // ---------- loads ----------

  putStmt(load) {
    const r = rowOf(load);
    return this.db.prepare(UPSERT_SQL).bind(...COLS.map((c) => r[c]));
  }

  async putLoad(load) {
    await this.putStmt(load).run();
    return load;
  }

  async getLoad(id) {
    const row = await this.db.prepare('SELECT data FROM loads WHERE id = ?').bind(String(id)).first();
    return row ? parse(row.data, null) : null;
  }

  /** fn(load) → нова заявка або null (не змінювати). */
  async updateLoad(id, fn) {
    const cur = await this.getLoad(id);
    if (!cur) return null;
    const next = fn(cur);
    if (!next) return cur;
    await this.putLoad(next);
    return next;
  }

  async getMany(ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const { results } = await this.db.prepare(`SELECT data FROM loads WHERE id IN (${part.map(() => '?').join(',')})`)
        .bind(...part).all();
      for (const r of results || []) {
        const l = parse(r.data, null);
        if (l) out.set(l.id, l);
      }
    }
    return out;
  }

  /** Як db.upsertSeen у розширенні: існуючі — mergeSeen, нові — лише якщо accept(). */
  async upsertSeen(parsedList, accept, now) {
    const existing = await this.getMany(parsedList.map((p) => p.id));
    const inserted = [];
    const updated = [];
    const stmts = [];
    for (const p of parsedList) {
      const cur = existing.get(p.id);
      if (cur) {
        const next = mergeSeen(cur, p, now);
        stmts.push(this.putStmt(next));
        updated.push({ before: cur, after: next });
      } else if (accept(p)) {
        const l = newLoad(p, now);
        stmts.push(this.putStmt(l));
        inserted.push(l);
      }
    }
    for (let i = 0; i < stmts.length; i += 50) await this.db.batch(stmts.slice(i, i + 50));
    return { inserted, updated };
  }

  /** Легкі рядки черги: {id, queuedAt, updatedAt, dateLast, lardi[], fav}. Обрані замовники — першими, чорний список — ні. */
  async queuedLight(limit = 5000, { withBlack = false } = {}) {
    const { results } = await this.db.prepare(
      `SELECT id, queuedAt, updatedAt, dateLast, lardi, ${IS_WHITE} AS fav FROM loads WHERE status = 'queued'
       ${withBlack ? '' : `AND NOT ${IS_BLACK}`} ORDER BY fav DESC, COALESCE(queuedAt, updatedAt) DESC LIMIT ?`,
    ).bind(limit).all();
    return (results || []).map((r) => ({ ...r, fav: !!r.fav, lardi: parse(r.lardi, []) }));
  }

  /** Легкі рядки з живими публікаціями на Lardi: {id, lardi[]} */
  async publishedLight(limit = 20000) {
    const { results } = await this.db.prepare(
      `SELECT id, lardi FROM loads WHERE lardi LIKE '%"status":"published"%' LIMIT ?`,
    ).bind(limit).all();
    return (results || []).map((r) => ({ ...r, lardi: parse(r.lardi, []) }))
      .filter((r) => r.lardi.some((e) => e.id && e.status === 'published'));
  }

  /**
   * Добір зняття: неактуальні та чорні (не видалені) заявки, у яких лишилися живі публікації на Lardi
   * (зняття раніше не вдалося). Найдавніше змінені — першими. {id, lardi[]}
   */
  async pendingRemovals(limit = 100) {
    const { results } = await this.db.prepare(
      `SELECT id, lardi FROM loads WHERE lardi LIKE '%"status":"published"%' AND status <> 'deleted'
       AND (status = 'inactive' OR ${IS_BLACK}) ORDER BY updatedAt ASC LIMIT ?`,
    ).bind(limit).all();
    return (results || []).map((r) => ({ ...r, lardi: parse(r.lardi, []) }))
      .filter((r) => r.lardi.some((e) => e.id && e.status === 'published'));
  }

  /** Архів: неактуальні/видалені, не змінювані довше за before — видалити назавжди. */
  async purgeArchive(before) {
    const r = await this.db.prepare("DELETE FROM loads WHERE status IN ('inactive','deleted') AND updatedAt < ?").bind(before).run();
    return Number(r?.meta?.changes ?? r?.changes ?? 0) || 0;
  }

  /** Живі публікації за акаунтами: {accountId: n}. */
  async liveByAccount() {
    const { results } = await this.db.prepare(
      `SELECT json_extract(j.value, '$.account') AS acc, COUNT(*) AS n FROM loads, json_each(loads.lardi) j
       WHERE loads.lardi LIKE '%"published"%' AND json_extract(j.value, '$.status') = 'published'
       AND json_extract(j.value, '$.id') IS NOT NULL GROUP BY acc`,
    ).all();
    const out = {};
    for (const r of results || []) out[r.acc] = Number(r.n) || 0;
    return out;
  }

  /** Помилки публікації за акаунтами (записи lardi[].status='error' у невидалених заявках): {accountIndex: n}. */
  async errorsByAccount() {
    const { results } = await this.db.prepare(
      `SELECT json_extract(j.value, '$.account') AS acc, COUNT(*) AS n FROM loads, json_each(loads.lardi) j
       WHERE loads.lardi LIKE '%"error"%' AND loads.status <> 'deleted' AND json_extract(j.value, '$.status') = 'error' GROUP BY acc`,
    ).all();
    const out = {};
    for (const r of results || []) out[r.acc] = Number(r.n) || 0;
    return out;
  }

  /** Лічильники за статусами — без заявок замовників із чорного списку (їх не показуємо). */
  async countByStatus(statuses) {
    const { results } = await this.db.prepare(`SELECT status, COUNT(*) AS n FROM loads WHERE NOT ${IS_BLACK} GROUP BY status`).all();
    const out = {};
    for (const s of statuses) out[s] = 0;
    for (const r of results || []) out[r.status] = Number(r.n) || 0;
    return out;
  }

  /** Кандидати на «неактуальні»: дата минула або не бачили з seenBefore. */
  async staleCandidates(statuses, today, seenBefore, limit = 200) {
    const { results } = await this.db.prepare(
      `SELECT id, dateLast, seenAt FROM loads WHERE status IN (${statuses.map(() => '?').join(',')})
       AND ((dateLast IS NOT NULL AND dateLast < ?) OR seenAt < ?) ORDER BY seenAt ASC LIMIT ?`,
    ).bind(...statuses, today, seenBefore, limit).all();
    return results || [];
  }

  /** Фільтри адмінки в SQL. p: {fromCity,toCity,fromRegion,toRegion,q,status,limit,offset} */
  async listLoads(p = {}) {
    const where = [];
    const args = [];
    const like = (col, v) => {
      where.push(`${col} LIKE ? ESCAPE '\\'`);
      args.push(`%${likeEsc(lc(v))}%`);
    };
    if (p.fromCity) like('fromCityLc', p.fromCity);
    if (p.toCity) like('toCityLc', p.toCity);
    if (p.fromRegion) like('fromRegionLc', p.fromRegion);
    if (p.toRegion) like('toRegionLc', p.toRegion);
    const PAY = { cashless: 'Безнал', cash: 'Готівка', card: 'Картка' };
    if (PAY[p.payment]) { where.push("json_extract(data, '$.payment') = ?"); args.push(PAY[p.payment]); }
    if (p.payment === 'vat') where.push(`data LIKE '%"ПДВ"%'`);
    if (p.payment === 'novat') where.push(`data LIKE '%"Без ПДВ"%'`);
    // Lardi: акаунт N (жива публікація саме там) або 'none' — ніде не опубліковано
    const LIVE_ON = "EXISTS (SELECT 1 FROM json_each(loads.lardi) j WHERE json_extract(j.value, '$.status') = 'published'";
    if (p.account === 'none') where.push(`NOT ${LIVE_ON})`);
    else if (p.account !== undefined && p.account !== null && p.account !== '' && Number.isInteger(Number(p.account))) {
      where.push(`${LIVE_ON} AND json_extract(j.value, '$.account') = ?)`);
      args.push(Number(p.account));
    }
    if (p.fav) where.push(IS_WHITE);
    // заявки конкретного замовника (вкладка «Замовники») — навіть із чорного списку; інакше чорний список приховано
    if (p.customer) { where.push(OF_CUSTOMER); args.push(Number(p.customer)); } else where.push(`NOT ${IS_BLACK}`);
    if (p.status && p.status !== 'all') {
      const sts = (Array.isArray(p.status) ? p.status : [p.status]).map(String);
      where.push(`status IN (${sts.map(() => '?').join(',')})`);
      args.push(...sts);
    } else {
      where.push("status <> 'deleted'"); // як у розширенні: і без статусу, і 'all' — без видалених
    }
    if (p.q && String(p.q).trim()) {
      const q = lc(p.q);
      const digits = q.replace(/\D/g, '');
      if (digits.length >= 4) {
        where.push("(search LIKE ? ESCAPE '\\' OR phoneDigits LIKE ?)");
        args.push(`%${likeEsc(q)}%`, `%${digits}%`);
      } else {
        where.push("search LIKE ? ESCAPE '\\'");
        args.push(`%${likeEsc(q)}%`);
      }
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(5000, Math.max(1, Number(p.limit) || 500));
    const offset = Math.max(0, Number(p.offset) || 0);
    const totalRow = await this.db.prepare(`SELECT COUNT(*) AS n FROM loads ${w}`).bind(...args).first();
    // обрані замовники — завжди вгорі
    const { results } = await this.db.prepare(`SELECT data, ${IS_WHITE} AS fav FROM loads ${w} ORDER BY fav DESC, seenAt DESC, id ASC LIMIT ? OFFSET ?`)
      .bind(...args, limit, offset).all();
    const items = [];
    for (const r of results || []) {
      const l = parse(r.data, null);
      if (!l) continue;
      if (r.fav) l.fav = true;
      items.push(l);
    }
    return { items, total: Number(totalRow && totalRow.n) || 0 };
  }

  // ---------- замовники: чорний / білий список ----------

  async keysOf(customerId) {
    const { results } = await this.db.prepare('SELECT key FROM customer_keys WHERE customerId = ? ORDER BY key').bind(Number(customerId)).all();
    return (results || []).map((r) => r.key);
  }

  async getCustomer(id) {
    const c = await this.db.prepare('SELECT * FROM customers WHERE id = ?').bind(Number(id)).first();
    return c ? { ...c, keys: await this.keysOf(c.id) } : null;
  }

  /** Список із лічильниками: loads — заявок у базі (крім видалених), live — з живими публікаціями на Lardi. */
  async listCustomers(list) {
    const { results } = await this.db.prepare(`SELECT * FROM customers ${list ? 'WHERE list = ?' : ''} ORDER BY list, createdAt DESC`)
      .bind(...(list ? [list] : [])).all();
    const out = [];
    for (const c of results || []) {
      const row = await this.db.prepare(
        `SELECT COUNT(*) AS n, SUM((SELECT COUNT(*) FROM json_each(loads.lardi) j WHERE json_extract(j.value, '$.status') = 'published'
           AND json_extract(j.value, '$.id') IS NOT NULL)) AS live
         FROM loads WHERE ${OF_CUSTOMER} AND status <> 'deleted'`,
      ).bind(c.id).first();
      out.push({ ...c, keys: await this.keysOf(c.id), loads: Number(row && row.n) || 0, live: Number(row && row.live) || 0 });
    }
    return out;
  }

  /** Скільки заявок зараз приховано чорним списком. */
  async hiddenBlackCount() {
    const row = await this.db.prepare(`SELECT COUNT(*) AS n FROM loads WHERE status <> 'deleted' AND ${IS_BLACK}`).first();
    return Number(row && row.n) || 0;
  }

  /** Записи, яким належить хоч один із ключів: [{customerId, list}] */
  async customersByKeys(keys) {
    if (!keys.length) return [];
    const { results } = await this.db.prepare(
      `SELECT DISTINCT customerId, list FROM customer_keys WHERE key IN (${keys.map(() => '?').join(',')})`,
    ).bind(...keys).all();
    return results || [];
  }

  /** Список, у якому замовник заявки: 'black' | 'white' | null (чорний важливіший). */
  async listOfKeys(keys) {
    const hits = await this.customersByKeys(keys);
    return hits.some((h) => h.list === 'black') ? 'black' : hits.some((h) => h.list === 'white') ? 'white' : null;
  }

  async keysOfList(list) {
    const { results } = await this.db.prepare('SELECT key FROM customer_keys WHERE list = ?').bind(list).all();
    return new Set((results || []).map((r) => r.key));
  }

  /**
   * Додати замовника в список. Записи зі спільними ключами зливаються в один і переходять у list —
   * ключ не може бути у двох списках, дубль не створюється.
   */
  async upsertCustomer(list, keys, { label, fallbackLabel, note } = {}) {
    const now = this.now();
    const ids = [...new Set((await this.customersByKeys(keys)).map((h) => h.customerId))].sort((a, b) => a - b);
    const olds = [];
    for (const id of ids) { const c = await this.getCustomer(id); if (c) olds.push(c); }
    const lbl = (label && String(label).trim()) || olds.map((c) => c.label).find(Boolean) || (fallbackLabel && String(fallbackLabel).trim()) || null;
    const nt = (note && String(note).trim()) || olds.map((c) => c.note).find(Boolean) || null;
    let id = olds[0] && olds[0].id;
    const stmts = [];
    if (id) {
      stmts.push(this.db.prepare('UPDATE customers SET list = ?, label = ?, note = ?, updatedAt = ? WHERE id = ?').bind(list, lbl, nt, now, id));
      for (const o of olds.slice(1)) stmts.push(this.db.prepare('DELETE FROM customers WHERE id = ?').bind(o.id));
    } else {
      const r = await this.db.prepare('INSERT INTO customers (list, label, note, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
        .bind(list, lbl, nt, now, now).run();
      id = Number(r.meta.last_row_id);
    }
    const all = [...new Set([...olds.flatMap((c) => c.keys), ...keys])];
    for (const oid of ids) stmts.push(this.db.prepare('DELETE FROM customer_keys WHERE customerId = ?').bind(oid));
    for (const k of all) stmts.push(this.db.prepare('INSERT OR REPLACE INTO customer_keys (key, customerId, list) VALUES (?, ?, ?)').bind(k, id, list));
    await this.db.batch(stmts);
    return { customer: await this.getCustomer(id), merged: olds.length, before: olds };
  }

  async setCustomerList(id, list) {
    await this.db.batch([
      this.db.prepare('UPDATE customers SET list = ?, updatedAt = ? WHERE id = ?').bind(list, this.now(), Number(id)),
      this.db.prepare('UPDATE customer_keys SET list = ? WHERE customerId = ?').bind(list, Number(id)),
    ]);
    return this.getCustomer(id);
  }

  async updateCustomer(id, { label, note } = {}) {
    const sets = [];
    const args = [];
    if (label !== undefined) { sets.push('label = ?'); args.push(String(label || '').trim().slice(0, 200) || null); }
    if (note !== undefined) { sets.push('note = ?'); args.push(String(note || '').trim().slice(0, 500) || null); }
    if (sets.length) {
      await this.db.prepare(`UPDATE customers SET ${sets.join(', ')}, updatedAt = ? WHERE id = ?`).bind(...args, this.now(), Number(id)).run();
    }
    return this.getCustomer(id);
  }

  async removeCustomer(id) {
    const c = await this.getCustomer(id);
    if (!c) return null;
    await this.db.batch([
      this.db.prepare('DELETE FROM customer_keys WHERE customerId = ?').bind(c.id),
      this.db.prepare('DELETE FROM customers WHERE id = ?').bind(c.id),
    ]);
    return c;
  }

  /** Легкі рядки заявок із будь-яким із ключів (для попереднього перегляду й застосування списку). */
  async loadsByKeys(keys, statuses) {
    if (!keys.length) return [];
    const cond = keys.map(() => "instr(custKeys, '|' || ? || '|') > 0").join(' OR ');
    const st = statuses ? ` AND status IN (${statuses.map(() => '?').join(',')})` : " AND status <> 'deleted'";
    const { results } = await this.db.prepare(`SELECT id, status, dateLast, lardi FROM loads WHERE custKeys <> '' AND (${cond})${st}`)
      .bind(...keys, ...(statuses || [])).all();
    return (results || []).map((r) => ({ ...r, lardi: parse(r.lardi, []) }));
  }

  /** Догін: актуальні опубліковані заявки без живого запису на акаунті account; обрані першими, чорні — ні. */
  async backfillCandidates(account, today) {
    const { results } = await this.db.prepare(
      `SELECT id, lardi, ${IS_WHITE} AS fav FROM loads WHERE status = 'published' AND (dateLast IS NULL OR dateLast >= ?)
       AND NOT ${IS_BLACK} ORDER BY fav DESC, seenAt DESC`,
    ).bind(today).all();
    return (results || []).filter((r) => !parse(r.lardi, []).some((e) => e.account === account && e.status === 'published')).map((r) => r.id);
  }

  /** Заявки, приховані чорним списком, чий замовник уже не в чорному списку. */
  async unblockedIds() {
    const { results } = await this.db.prepare(
      `SELECT id FROM loads WHERE status = 'inactive' AND json_extract(data, '$.inactiveKind') = 'blacklist' AND NOT ${IS_BLACK}`,
    ).all();
    return (results || []).map((r) => r.id);
  }

  // ---------- settings / meta ----------

  async getKV(k, dflt) {
    const row = await this.db.prepare('SELECT v FROM settings WHERE k = ?').bind(k).first();
    return row ? (parse(row.v, dflt) ?? dflt) : dflt;
  }

  async setKV(k, v) {
    await this.db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .bind(k, JSON.stringify(v === undefined ? null : v)).run();
    return v;
  }

  getMeta(k, dflt) { return this.getKV('meta:' + k, dflt); }
  setMeta(k, v) { return this.setKV('meta:' + k, v); }

  /** Замок від накладання запусків. true — захопили. */
  async acquireLock(owner, ttlMs = 55000) {
    const now = this.now();
    const res = await this.db.prepare(
      `INSERT INTO settings (k, v) VALUES ('lock', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v
       WHERE COALESCE(json_extract(settings.v, '$.until'), 0) < ?`,
    ).bind(JSON.stringify({ owner, until: now + ttlMs }), now).run();
    return !!(res && res.meta && res.meta.changes > 0);
  }

  async releaseLock(owner) {
    await this.db.prepare("DELETE FROM settings WHERE k = 'lock' AND json_extract(v, '$.owner') = ?").bind(owner).run();
  }

  async lockActive() {
    const l = await this.getKV('lock', null);
    return !!(l && l.until > this.now());
  }

  // ---------- cache (інтерфейс для LardiClient) ----------

  get cache() {
    return {
      get: async (k) => {
        const row = await this.db.prepare('SELECT v, t FROM cache WHERE k = ?').bind(k).first();
        if (!row) return undefined;
        if (row.t && row.t < this.now()) return undefined;
        return parse(row.v, undefined);
      },
      set: async (k, v, ttlMs) => {
        await this.db.prepare('INSERT INTO cache (k, v, t) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t')
          .bind(k, JSON.stringify(v), ttlMs ? this.now() + ttlMs : 0).run();
      },
    };
  }

  // ---------- log ----------

  async addLog(level, msg) {
    await this.db.prepare('INSERT INTO log (t, level, msg) VALUES (?, ?, ?)').bind(this.now(), level, String(msg)).run();
  }

  async trimLog() {
    await this.db.prepare('DELETE FROM log WHERE id <= (SELECT MAX(id) FROM log) - ?').bind(LOG_MAX).run();
  }

  async listLog(limit = 200) {
    const { results } = await this.db.prepare('SELECT t, level, msg FROM log ORDER BY id DESC LIMIT ?').bind(limit).all();
    return results || [];
  }

  // ---------- counters ----------

  async bump(day, key, by = 1) {
    await this.db.prepare('INSERT INTO counters (day, key, n) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET n = n + excluded.n')
      .bind(day, key, by).run();
  }

  async counters(day) {
    const { results } = await this.db.prepare('SELECT key, n FROM counters WHERE day = ?').bind(day).all();
    const out = {};
    for (const r of results || []) out[r.key] = Number(r.n) || 0;
    return out;
  }
}
