// Доступ до D1: заявки, налаштування/мета, кеш, журнал, лічильники.
import { mergeSeen, newLoad } from '../../extension/lib/model.js';

export const LOG_MAX = 5000;

const lc = (v) => String(v ?? '').toLowerCase().replace(/[’ʼ`]/g, "'").trim();
const nn = (v) => (v === undefined ? null : v);

/** Екранування для LIKE ... ESCAPE '\'. */
export const likeEsc = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);

function rowOf(l) {
  const search = [l.id, l.cargo, l.company, l.phone, l.fromCity, l.toCity, l.fromRegion, l.toRegion,
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

  /** Легкі рядки черги: {id, queuedAt, updatedAt, dateLast, lardi[]} */
  async queuedLight(limit = 5000) {
    const { results } = await this.db.prepare(
      "SELECT id, queuedAt, updatedAt, dateLast, lardi FROM loads WHERE status = 'queued' ORDER BY COALESCE(queuedAt, updatedAt) DESC LIMIT ?",
    ).bind(limit).all();
    return (results || []).map((r) => ({ ...r, lardi: parse(r.lardi, []) }));
  }

  /** Легкі рядки з живими публікаціями на Lardi: {id, lardi[]} */
  async publishedLight(limit = 20000) {
    const { results } = await this.db.prepare(
      `SELECT id, lardi FROM loads WHERE lardi LIKE '%"status":"published"%' LIMIT ?`,
    ).bind(limit).all();
    return (results || []).map((r) => ({ ...r, lardi: parse(r.lardi, []) }))
      .filter((r) => r.lardi.some((e) => e.id && e.status === 'published'));
  }

  /** Архів: неактуальні/видалені, не змінювані довше за before — видалити назавжди. */
  async purgeArchive(before) {
    const r = await this.db.prepare("DELETE FROM loads WHERE status IN ('inactive','deleted') AND updatedAt < ?").bind(before).run();
    return Number(r?.meta?.changes ?? r?.changes ?? 0) || 0;
  }

  async countByStatus(statuses) {
    const { results } = await this.db.prepare('SELECT status, COUNT(*) AS n FROM loads GROUP BY status').all();
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
    const { results } = await this.db.prepare(`SELECT data FROM loads ${w} ORDER BY seenAt DESC, id ASC LIMIT ? OFFSET ?`)
      .bind(...args, limit, offset).all();
    return { items: (results || []).map((r) => parse(r.data, null)).filter(Boolean), total: Number(totalRow && totalRow.n) || 0 };
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
