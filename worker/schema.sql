-- IntDeliv — схема D1. Застосувати: npx wrangler d1 execute intdeliv --remote --file schema.sql
CREATE TABLE IF NOT EXISTS loads (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  seenAt INTEGER NOT NULL,
  firstSeenAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  queuedAt INTEGER,
  dateLast TEXT,              -- dateTo || dateFrom, для перевірки актуальності
  fromCity TEXT, toCity TEXT, fromRegion TEXT, toRegion TEXT, phone TEXT,
  -- копії в нижньому регістрі (SQLite LOWER() не знає кирилиці — регістр зводимо в JS)
  fromCityLc TEXT, toCityLc TEXT, fromRegionLc TEXT, toRegionLc TEXT,
  phoneDigits TEXT,
  search TEXT,                -- id, вантаж, компанія, телефон, міста, id Lardi — lowercase
  lardi TEXT,                 -- JSON масиву публікацій (легкий, для черги)
  data TEXT NOT NULL          -- JSON повного Load
);
CREATE INDEX IF NOT EXISTS loads_status ON loads(status);
CREATE INDEX IF NOT EXISTS loads_seenAt ON loads(seenAt);
CREATE INDEX IF NOT EXISTS loads_status_queued ON loads(status, queuedAt);
CREATE INDEX IF NOT EXISTS loads_fromCity ON loads(fromCityLc);
CREATE INDEX IF NOT EXISTS loads_toCity ON loads(toCityLc);
CREATE INDEX IF NOT EXISTS loads_fromRegion ON loads(fromRegionLc);
CREATE INDEX IF NOT EXISTS loads_toRegion ON loads(toRegionLc);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT                      -- JSON
);

CREATE TABLE IF NOT EXISTS cache (
  k TEXT PRIMARY KEY,
  v TEXT,                     -- JSON
  t INTEGER                   -- момент закінчення (ms), 0 — без терміну
);

CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  level TEXT NOT NULL,
  msg TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS log_t ON log(t);

CREATE TABLE IF NOT EXISTS counters (
  day TEXT NOT NULL,          -- YYYY-MM-DD за Києвом
  key TEXT NOT NULL,          -- collected | published:0 | dry:1 ...
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);
