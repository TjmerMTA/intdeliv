// IndexedDB: stores loads (keyPath id; индексы seenAt, status), cache, log, meta.
import { newLoad, mergeSeen } from './model.js';

const DB_NAME = 'intdeliv';
const DB_VERSION = 1;
const LOG_MAX = 3000;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('loads')) {
        const s = db.createObjectStore('loads', { keyPath: 'id' });
        s.createIndex('seenAt', 'seenAt');
        s.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('log')) {
        const l = db.createObjectStore('log', { keyPath: 'seq', autoIncrement: true });
        l.createIndex('t', 't');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function tx(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
    Promise.resolve(fn(t)).then((r) => { result = r; }, (e) => { try { t.abort(); } catch {} reject(e); });
  });
}

// ---------- loads ----------

export async function getLoad(id) {
  return tx(['loads'], 'readonly', (t) => reqP(t.objectStore('loads').get(id)));
}

export async function putLoad(load) {
  await tx(['loads'], 'readwrite', (t) => reqP(t.objectStore('loads').put(load)));
  return load;
}

export async function putLoads(loads) {
  if (!loads.length) return;
  await tx(['loads'], 'readwrite', (t) => {
    const s = t.objectStore('loads');
    return Promise.all(loads.map((l) => reqP(s.put(l))));
  });
}

/** Атомарное изменение одной заявки. fn(load) → новая заявка (или null — не менять). */
export async function updateLoad(id, fn) {
  return tx(['loads'], 'readwrite', async (t) => {
    const s = t.objectStore('loads');
    const cur = await reqP(s.get(id));
    if (!cur) return null;
    const next = fn(cur);
    if (!next) return cur;
    await reqP(s.put(next));
    return next;
  });
}

export async function deleteLoadHard(id) {
  await tx(['loads'], 'readwrite', (t) => reqP(t.objectStore('loads').delete(id)));
}

/**
 * Сбор: для каждой разобранной заявки — если есть, обновить только seenAt (mergeSeen),
 * если нет и accept(parsed) === true — вставить как новую.
 * @returns {{inserted: object[], updated: object[]}}
 */
export async function upsertSeen(parsedList, accept, now = Date.now()) {
  const inserted = [];
  const updated = [];
  await tx(['loads'], 'readwrite', async (t) => {
    const s = t.objectStore('loads');
    for (const p of parsedList) {
      const cur = await reqP(s.get(p.id));
      if (cur) {
        const next = mergeSeen(cur, p, now);
        await reqP(s.put(next));
        updated.push({ before: cur, after: next });
      } else if (accept(p)) {
        const l = newLoad(p, now);
        await reqP(s.put(l));
        inserted.push(l);
      }
    }
  });
  return { inserted, updated };
}

export async function loadsByStatus(status) {
  return tx(['loads'], 'readonly', (t) => reqP(t.objectStore('loads').index('status').getAll(status)));
}

export async function countByStatus(statuses) {
  return tx(['loads'], 'readonly', async (t) => {
    const idx = t.objectStore('loads').index('status');
    const out = {};
    for (const s of statuses) out[s] = await reqP(idx.count(s));
    return out;
  });
}

/** Обход по seenAt desc с фильтром; возвращает {items, total}. */
export async function listLoads(match, { limit = 500, offset = 0 } = {}) {
  return tx(['loads'], 'readonly', (t) => new Promise((resolve, reject) => {
    const items = [];
    let total = 0;
    const req = t.objectStore('loads').index('seenAt').openCursor(null, 'prev');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) { resolve({ items, total }); return; }
      const v = cur.value;
      if (match(v)) {
        if (total >= offset && items.length < limit) items.push(v);
        total++;
      }
      cur.continue();
    };
  }));
}

export async function allLoads() {
  return tx(['loads'], 'readonly', (t) => reqP(t.objectStore('loads').getAll()));
}

// ---------- cache (с TTL) ----------

export const cache = {
  async get(key) {
    const row = await tx(['cache'], 'readonly', (t) => reqP(t.objectStore('cache').get(key)));
    if (!row) return undefined;
    if (row.exp && row.exp < Date.now()) return undefined;
    return row.value;
  },
  async set(key, value, ttlMs) {
    await tx(['cache'], 'readwrite', (t) => reqP(t.objectStore('cache').put({ key, value, exp: ttlMs ? Date.now() + ttlMs : 0 })));
  },
};

// ---------- log ----------

let logCount = 0;
export async function addLog(level, msg) {
  const entry = { t: Date.now(), level, msg: String(msg) };
  await tx(['log'], 'readwrite', (t) => reqP(t.objectStore('log').add(entry)));
  if (++logCount % 100 === 0) trimLog().catch(() => {});
  return entry;
}

async function trimLog() {
  await tx(['log'], 'readwrite', async (t) => {
    const s = t.objectStore('log');
    const n = await reqP(s.count());
    if (n <= LOG_MAX) return;
    let toDelete = n - LOG_MAX;
    await new Promise((resolve, reject) => {
      const req = s.openCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const c = req.result;
        if (!c || toDelete <= 0) { resolve(); return; }
        c.delete();
        toDelete--;
        c.continue();
      };
    });
  });
}

export async function listLog(limit = 200) {
  return tx(['log'], 'readonly', (t) => new Promise((resolve, reject) => {
    const out = [];
    const req = t.objectStore('log').openCursor(null, 'prev');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const c = req.result;
      if (!c || out.length >= limit) { resolve(out); return; }
      const { t: time, level, msg } = c.value;
      out.push({ t: time, level, msg });
      c.continue();
    };
  }));
}

// ---------- meta ----------

export async function getMeta(key, dflt) {
  const row = await tx(['meta'], 'readonly', (t) => reqP(t.objectStore('meta').get(key)));
  return row ? row.value : dflt;
}

export async function setMeta(key, value) {
  await tx(['meta'], 'readwrite', (t) => reqP(t.objectStore('meta').put({ key, value })));
  return value;
}
