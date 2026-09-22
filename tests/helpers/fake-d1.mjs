// Мінімальний фейк Cloudflare D1 поверх node:sqlite (Node 22+).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const fix = (v) => {
  if (v === undefined) throw new TypeError('D1_TYPE_ERROR: undefined is not a valid bind value');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
};

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.db, this.sql, params.map(fix)); }
  _st() { return this.db.prepare(this.sql); }
  async all() { return { success: true, results: this._st().all(...this.params).map((r) => ({ ...r })), meta: {} }; }
  async first(col) {
    const r = this._st().get(...this.params);
    if (!r) return null;
    return col ? r[col] : { ...r };
  }
  async run() { return this._runSync(); }
  _runSync() {
    const r = this._st().run(...this.params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async raw() { return this._st().all(...this.params).map((r) => Object.values(r)); }
}

export class FakeD1 {
  constructor(schemaPath) {
    this.db = new DatabaseSync(':memory:');
    if (schemaPath) this.db.exec(readFileSync(schemaPath, 'utf8'));
  }
  prepare(sql) { return new Stmt(this.db, sql); }
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
  async exec(sql) { this.db.exec(sql); return { count: 1 }; }
}
