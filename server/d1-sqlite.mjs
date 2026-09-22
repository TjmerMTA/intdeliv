// D1-сумісний адаптер поверх node:sqlite (Node 22.5+): prepare().bind().first()/all()/run()/raw(), batch(), exec().
// Використовується сервером (server/run.mjs, файл БД) і тестами (':memory:').
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, renameSync, rmSync } from 'node:fs';

const fix = (v) => {
  if (v === undefined) throw new TypeError('D1_TYPE_ERROR: undefined is not a valid bind value');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
};

class Stmt {
  constructor(d1, sql, params = []) { this.d1 = d1; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.d1, this.sql, params.map(fix)); }
  _st() { return this.d1.db.prepare(this.sql); }
  async all() { return { success: true, results: this._st().all(...this.params).map((r) => ({ ...r })), meta: {} }; }
  async first(col) {
    const r = this._st().get(...this.params);
    if (!r) return null;
    return col ? (r[col] ?? null) : { ...r };
  }
  async run() { return this._runSync(); }
  _runSync() {
    const r = this._st().run(...this.params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async raw() { return this._st().all(...this.params).map((r) => Object.values(r)); }
}

export class D1Database {
  /**
   * @param {string} path  шлях до файлу або ':memory:'
   * @param {{schemaPath?: string, wal?: boolean}} o
   */
  constructor(path = ':memory:', o = {}) {
    this.path = path;
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') {
      this.db.exec('PRAGMA busy_timeout = 5000');
      if (o.wal !== false) this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL');
    }
    if (o.schemaPath) this.applySchema(o.schemaPath);
  }

  /** Схема має бути ідемпотентною (CREATE ... IF NOT EXISTS). */
  applySchema(schemaPath) { this.db.exec(readFileSync(schemaPath, 'utf8')); }

  prepare(sql) { return new Stmt(this, sql); }

  // node:sqlite синхронний: транзакція виконується без переривань event loop.
  async batch(stmts) {
    this.db.exec('BEGIN');
    try {
      const out = stmts.map((s) => s._runSync());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async exec(sql) { this.db.exec(sql); return { count: 1, duration: 0 }; }

  /** Узгоджена копія БД у файл (атомарно через тимчасовий файл). */
  snapshot(target) {
    const tmp = target + '.tmp';
    rmSync(tmp, { force: true });
    this.db.prepare('VACUUM INTO ?').run(tmp);
    renameSync(tmp, target);
  }

  checkpoint() {
    if (this.path !== ':memory:') this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close() { this.db.close(); }
}
