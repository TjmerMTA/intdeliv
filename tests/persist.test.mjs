// server/persist.sh: save → restore проти локального bare-репозиторію (PERSIST_REMOTE), ключ DB_KEY — одноразовий.
// Скрипт запускається в тимчасовому робочому репозиторії, тож справжній репозиторій і гілка data не зачіпаються.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Database } from '../server/d1-sqlite.mjs';
import { Store } from '../worker/src/store.js';

const PERSIST = fileURLToPath(new URL('../server/persist.sh', import.meta.url));
const SCHEMA = fileURLToPath(new URL('../worker/schema.sql', import.meta.url));
const KEY = 'throwaway-key-for-tests-only';
const NEW = 'intdeliv.sqlite.gz.enc';
const OLD = 'intdeliv.sqlite.enc';
const T0 = Date.parse('2026-10-13T10:00:00Z');
const H = 3600e3;

function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...o });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function ok(cmd, args, o) {
  const r = run(cmd, args, o);
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}\n${r.out}`);
  return r.out;
}

/** Тимчасовий «GitHub»: bare-репозиторій + робочий репозиторій, з якого запускається persist.sh. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'intdeliv-persist-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  ok('git', ['init', '-q', '--bare', remote]);
  ok('git', ['init', '-q', work]);
  const env = { PATH: process.env.PATH, HOME: dir, DB_KEY: KEY, PERSIST_REMOTE: remote, PERSIST_RETRY_SLEEP: '0', GIT_CONFIG_NOSYSTEM: '1' };
  const persist = (args, extra = {}) => run('bash', [PERSIST, ...args], { cwd: work, env: { ...env, ...extra } });
  const git = (...args) => ok('git', ['--git-dir', remote, ...args]).trim();
  return {
    dir, remote, work, env, persist, git,
    db: (name) => join(dir, name),
    tree: () => git('ls-tree', '--name-only', 'refs/heads/data').split('\n').filter(Boolean).sort(),
    head: () => git('rev-parse', 'refs/heads/data'),
    commits: () => Number(git('rev-list', '--count', 'refs/heads/data')),
    /** Покласти файли в гілку data одним комітом — так, як це робить будь-яка версія persist.sh. */
    push(files) {
      const src = mkdtempSync(join(dir, 'src-'));
      ok('git', ['init', '-q', src]);
      for (const [name, make] of Object.entries(files)) make(join(src, name));
      ok('git', ['-C', src, 'add', '-A', '.']);
      ok('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'data']);
      ok('git', ['-C', src, 'push', '-q', '-f', remote, 'HEAD:refs/heads/data']);
    },
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** База зі справжньою схемою рушія; loads: [[id, firstSeenAt, seenAt]]. */
async function makeDb(path, loads) {
  const db = new D1Database(path, { schemaPath: SCHEMA });
  const store = new Store(db);
  for (const [id, firstSeenAt, seenAt] of loads) {
    await store.putLoad({ id, status: 'new', fromCity: 'Київ', toCity: 'Львів', cargo: 'вантаж ' + id, lardi: [], firstSeenAt, seenAt, updatedAt: seenAt });
  }
  await store.setKV('settings', { marker: path });
  db.checkpoint();
  db.close();
  return path;
}
function ids(path) {
  const db = new D1Database(path, { wal: false });
  try { return db.db.prepare('SELECT id FROM loads ORDER BY id').all().map((r) => r.id); } finally { db.close(); }
}
/** Файл старого формату — тією ж командою, якою його писав попередній persist.sh (без gzip). */
const oldFormat = (dbPath) => (target) => ok('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt', '-pass', 'env:DB_KEY', '-in', dbPath, '-out', target], { env: { PATH: process.env.PATH, DB_KEY: KEY } });
const newFormat = (dbPath) => (target) => ok('bash', ['-c', 'set -o pipefail; gzip -c "$1" | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:DB_KEY -out "$2"', '_', dbPath, target], { env: { PATH: process.env.PATH, DB_KEY: KEY } });
const text = (s) => (target) => writeFileSync(target, s);
const leftovers = (dir) => readdirSync(dir).filter((f) => /restore|\.part$|\.tmp$/.test(f));

test('persist: новий формат — save → restore, один коміт у гілці, api.json на місці, розміри в журналі', async () => {
  const s = sandbox();
  try {
    assert.match(s.persist(['restore'], { DB_PATH: s.db('none.sqlite') }).out, /збереженої бази немає — старт з нуля/);
    assert.equal(existsSync(s.db('none.sqlite')), false);

    const src = await makeDb(s.db('a.sqlite'), [['a1', T0, T0 + H], ['a2', T0 + H, T0 + 2 * H]]);
    const pub = s.persist(['publish-url', 'https://example-one.trycloudflare.com']);
    assert.equal(pub.status, 0, pub.out);
    const save = s.persist(['save'], { DB_PATH: src });
    assert.equal(save.status, 0, save.out);
    assert.match(save.out, /розмір бази \d+ → gzip \d+ → зашифровано \d+ байт/);
    assert.doesNotMatch(save.out, /::error::/);
    assert.deepEqual(s.tree(), ['api.json', NEW]);

    // друге збереження й нова адреса: гілка не росте, сусідній файл не зникає
    const db = new D1Database(src); await new Store(db).putLoad({ id: 'a3', status: 'new', lardi: [], firstSeenAt: T0 + 2 * H, seenAt: T0 + 3 * H, updatedAt: T0 + 3 * H }); db.close();
    assert.equal(s.persist(['save'], { DB_PATH: src }).status, 0);
    assert.equal(s.persist(['publish-url', 'https://example-two.trycloudflare.com']).status, 0);
    assert.deepEqual(s.tree(), ['api.json', NEW]);
    assert.equal(s.commits(), 1);
    assert.match(s.git('show', 'refs/heads/data:api.json'), /example-two\.trycloudflare\.com/);

    const back = s.db('restored/b.sqlite');
    const res = s.persist(['restore'], { DB_PATH: back });
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, new RegExp(`базу відновлено з ${NEW.replace(/\./g, '\\.')}`));
    assert.deepEqual(ids(back), ['a1', 'a2', 'a3']);
    assert.deepEqual(leftovers(join(s.dir, 'restored')), []);
    // у зашифрованому файлі бази відкритим текстом немає
    assert.doesNotMatch(s.git('cat-file', '-p', `refs/heads/data:${NEW}`), /SQLite format 3|вантаж/);
  } finally { s.clean(); }
});

test('persist: у гілці лише старий формат — restore читає його, наступний save переводить на новий', async () => {
  const s = sandbox();
  try {
    const src = await makeDb(s.db('old.sqlite'), [['o1', T0, T0 + H], ['o2', T0, T0 + H]]);
    s.push({ [OLD]: oldFormat(src), 'api.json': text('{"url":"https://example-old.trycloudflare.com"}\n') });
    assert.deepEqual(s.tree(), ['api.json', OLD]);

    const back = s.db('back.sqlite');
    const res = s.persist(['restore'], { DB_PATH: back });
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /базу відновлено з intdeliv\.sqlite\.enc /);
    assert.deepEqual(ids(back), ['o1', 'o2']);

    assert.equal(s.persist(['save'], { DB_PATH: back }).status, 0);
    assert.deepEqual(s.tree(), ['api.json', NEW], 'старий файл прибрано, адреса лишилась');
    const again = s.db('again.sqlite');
    assert.equal(s.persist(['restore'], { DB_PATH: again }).status, 0);
    assert.deepEqual(ids(again), ['o1', 'o2']);
  } finally { s.clean(); }
});

test('persist: у гілці обидва формати — старий записано пізніше, береться він', async () => {
  const s = sandbox();
  try {
    // запуск зі старим кодом продовжив ту саму базу: у ній є все з нової і ще заявка
    const fresh = await makeDb(s.db('new.sqlite'), [['n1', T0, T0 + H], ['n2', T0 + H, T0 + 2 * H]]);
    const later = await makeDb(s.db('old.sqlite'), [['n1', T0, T0 + 5 * H], ['n2', T0 + H, T0 + 5 * H], ['n3', T0 + 4 * H, T0 + 5 * H]]);
    s.push({ [NEW]: newFormat(fresh), [OLD]: oldFormat(later) });

    const back = s.db('back.sqlite');
    const res = s.persist(['restore'], { DB_PATH: back });
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /::warning::persist: у гілці обидва формати — беру intdeliv\.sqlite\.enc/);
    assert.deepEqual(ids(back), ['n1', 'n2', 'n3']);

    assert.equal(s.persist(['save'], { DB_PATH: back }).status, 0);
    assert.deepEqual(s.tree(), [NEW]);
    const again = s.db('again.sqlite');
    assert.equal(s.persist(['restore'], { DB_PATH: again }).status, 0);
    assert.deepEqual(ids(again), ['n1', 'n2', 'n3']);
  } finally { s.clean(); }
});

test('persist: обидва формати, але старий — база «з нуля» після нової: вона не затирає справжню', async () => {
  const s = sandbox();
  try {
    const real = await makeDb(s.db('new.sqlite'), [['n1', T0, T0 + H], ['n2', T0 + H, T0 + 2 * H]]);
    // старий код нового формату не побачив, стартував порожнім і зібрав лише свіже
    const scratch = await makeDb(s.db('old.sqlite'), [['z9', T0 + 3 * H, T0 + 4 * H]]);
    s.push({ [NEW]: newFormat(real), [OLD]: oldFormat(scratch) });
    const back = s.db('back.sqlite');
    const res = s.persist(['restore'], { DB_PATH: back });
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /::error::persist: у гілці обидва формати, але intdeliv\.sqlite\.enc — база «з нуля»/);
    assert.deepEqual(ids(back), ['n1', 'n2']);

    // те саме, якщо стара база зовсім без заявок
    const empty = await makeDb(s.db('empty.sqlite'), []);
    s.push({ [NEW]: newFormat(real), [OLD]: oldFormat(empty) });
    const back2 = s.db('back2.sqlite');
    assert.equal(s.persist(['restore'], { DB_PATH: back2 }).status, 0);
    assert.deepEqual(ids(back2), ['n1', 'n2']);
  } finally { s.clean(); }
});

test('persist: restore не стартує з нуля й не лишає обрізаного файла, коли базу не вдалося прочитати', async () => {
  const s = sandbox();
  try {
    const src = await makeDb(s.db('a.sqlite'), [['a1', T0, T0 + H]]);
    assert.equal(s.persist(['save'], { DB_PATH: src }).status, 0);

    mkdirSync(join(s.dir, 'r'));
    const back = join(s.dir, 'r', 'db.sqlite');
    const wrongKey = s.persist(['restore'], { DB_PATH: back, DB_KEY: 'not-the-key' });
    assert.notEqual(wrongKey.status, 0);
    assert.match(wrongKey.out, /::error::persist: не вдалося розшифрувати/);
    assert.deepEqual(readdirSync(join(s.dir, 'r')), [], 'ні бази, ні тимчасових файлів');

    // обрізаний файл у гілці (наприклад, зіпсований push) — теж помилка, а не половина бази
    const enc = join(s.dir, 'full.enc');
    newFormat(src)(enc);
    s.push({ [NEW]: (target) => ok('bash', ['-c', 'head -c "$(( $(wc -c < "$1") / 2 ))" "$1" > "$2"', '_', enc, target]) });
    const cut = s.persist(['restore'], { DB_PATH: back });
    assert.notEqual(cut.status, 0);
    assert.match(cut.out, /::error::persist/);
    assert.deepEqual(readdirSync(join(s.dir, 'r')), []);

    // «GitHub не відповів» ≠ «гілки немає»: раніше це мовчки давало порожню базу, яку наступний save записав би поверх справжньої
    const down = s.persist(['restore'], { DB_PATH: back, PERSIST_REMOTE: join(s.dir, 'no-such-remote.git') });
    assert.notEqual(down.status, 0);
    assert.match(down.out, /::error::persist: гілку data не вдалося прочитати/);
    assert.doesNotMatch(down.out, /старт з нуля/);
    assert.equal(existsSync(back), false);
  } finally { s.clean(); }
});

test('persist: save, що зламався посередині, нічого не пушить — у гілці лишається попередня ціла база', async () => {
  const s = sandbox();
  try {
    const src = await makeDb(s.db('a.sqlite'), [['a1', T0, T0 + H]]);
    assert.equal(s.persist(['save'], { DB_PATH: src }).status, 0);
    const before = s.head();
    const db = new D1Database(src); await new Store(db).putLoad({ id: 'a2', status: 'new', lardi: [], firstSeenAt: T0 + H, seenAt: T0 + 2 * H, updatedAt: T0 + 2 * H }); db.close();

    const real = ok('bash', ['-c', 'command -v openssl']).trim();
    const shim = (body) => {
      const bin = mkdtempSync(join(s.dir, 'bin-'));
      writeFileSync(join(bin, 'openssl'), `#!/bin/bash\nfor a in "$@"; do if [ "$a" = "-d" ]; then exec "${real}" "$@"; fi; done\n${body}\n`);
      chmodSync(join(bin, 'openssl'), 0o755);
      return { PATH: `${bin}:${process.env.PATH}` };
    };
    const outArg = 'out=""; prev=""; for a in "$@"; do if [ "$prev" = "-out" ]; then out="$a"; fi; prev="$a"; done';

    // 1) шифрування впало, встигнувши записати шматок файла
    const crashed = s.persist(['save'], { DB_PATH: src, ...shim(`${outArg}\nprintf 'Salted__half' > "$out"\nexit 1`) });
    assert.notEqual(crashed.status, 0);
    assert.match(crashed.out, /::error::persist: save перервано з кодом/);
    assert.equal(s.head(), before);

    // 2) шифрування «вдалося», але файл обрізаний — це ловить перевірка розшифруванням
    const truncated = s.persist(['save'], { DB_PATH: src, ...shim(`${outArg}\n"${real}" "$@" || exit 1\nhead -c 64 "$out" > "$out.cut" && mv "$out.cut" "$out"`) });
    assert.notEqual(truncated.status, 0);
    assert.match(truncated.out, /::error::persist: зашифрований файл не розшифровується назад/);
    assert.equal(s.head(), before);

    // 3) push відхилено (як GitHub відхиляє файл понад 100 МіБ) — код ≠ 0 і пояснення
    writeFileSync(join(s.remote, 'hooks', 'pre-receive'), '#!/bin/bash\necho "remote: error: File is too large" >&2\nexit 1\n');
    chmodSync(join(s.remote, 'hooks', 'pre-receive'), 0o755);
    const rejected = s.persist(['save'], { DB_PATH: src });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.out, /::error::persist: базу НЕ збережено: push у гілку data не вдався/);
    assert.equal(s.head(), before);
    rmSync(join(s.remote, 'hooks', 'pre-receive'));

    const back = s.db('back.sqlite');
    assert.equal(s.persist(['restore'], { DB_PATH: back }).status, 0);
    assert.deepEqual(ids(back), ['a1'], 'попередня база ціла');
    // і звичайний save після збоїв працює
    assert.equal(s.persist(['save'], { DB_PATH: src }).status, 0);
    assert.equal(s.persist(['restore'], { DB_PATH: back }).status, 0);
    assert.deepEqual(ids(back), ['a1', 'a2']);
  } finally { s.clean(); }
});

test('persist: файл понад поріг — гучна анотація ::error::, а не тиха відмова', async () => {
  const s = sandbox();
  try {
    const src = await makeDb(s.db('a.sqlite'), [['a1', T0, T0 + H]]);
    const big = s.persist(['save'], { DB_PATH: src, PERSIST_WARN_BYTES: '1000' });
    assert.equal(big.status, 0, big.out);
    assert.match(big.out, /::error::persist: файл бази \d+ байт — більше за 1000/);
    assert.match(big.out, /базу збережено/);
    // стиснений файл помітно менший за базу
    const plain = statSync(src).size;
    const enc = Number(s.git('cat-file', '-s', `refs/heads/data:${NEW}`));
    assert.ok(enc < plain / 2, `enc ${enc} < plain ${plain} / 2`);
  } finally { s.clean(); }
});
