// Міграція ключів «name:…» на нову нормалізацію назв (migrate-namekeys): жоден запис списку не лишається без ключа,
// чужий ключ не перехоплюється, спір чорного з білим вирішується на користь чорного, нерозв'язане — видно адмінці.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerKeys, nameKeyV1 } from '../extension/lib/model.js';
import { NAME_KEYS_V } from '../worker/src/store.js';
import { setup } from './helpers/harness.mjs';

/** База зі «старими» (v1) ключами, як жива до випуску: entries — [{list, label, keys[]}]. */
async function oldDb(entries, { flag = 0 } = {}) {
  const h = setup();
  const e = h.engine();
  await e.ready();
  await e.store.setKV('meta:nameKeysV', flag);
  for (const [i, c] of entries.entries()) {
    await e.store.db.prepare('INSERT INTO customers (id, list, label, note, createdAt, updatedAt) VALUES (?, ?, ?, NULL, 1, 1)').bind(i + 1, c.list, c.label ?? null).run();
    for (const k of c.keys) await e.store.db.prepare('INSERT INTO customer_keys (key, customerId, list) VALUES (?, ?, ?)').bind(k, i + 1, c.list).run();
  }
  return { h, e, st: e.store };
}
const byId = async (st, id) => (await st.getCustomer(id)).keys;
const everyoneKeyed = async (h) => {
  for (const c of (await h.call('customers.list', {})).items) assert.ok(c.keys.length > 0, `«${c.label}» (${c.list}) лишився без ключа`);
};
const logOf = async (h) => (await h.call('log.list', { limit: 200 })).map((x) => x.msg);

test('v1 → нові ключі: дефіс, апостроф, форма власності — записи переходять на нове написання', async () => {
  const { h, e, st } = await oldDb([
    { list: 'black', label: 'ТОВ «Логістик-Плюс»', keys: ['name:логістик-плюс', 'tel:380671112233'] },
    { list: 'white', label: 'Альфа', keys: ['name:альфа'] },
  ]);
  const r = await e.migrateNameKeys();
  assert.equal(r.changed, 1);
  assert.equal(r.kept, 0);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(await byId(st, 1), ['name:логістик плюс', 'tel:380671112233']);
  assert.deepEqual(await byId(st, 2), ['name:альфа'], 'незмінне не чіпаємо');
  await everyoneKeyed(h);
});

test('M1: чорний «Логістик-Плюс» і білий «Логістик Плюс» — після міграції одна фірма: перемагає чорний, білий не лишається без ключа, спір видно', async () => {
  const { h, e, st } = await oldDb([
    { list: 'black', label: 'ТОВ «Логістик-Плюс»', keys: ['name:логістик-плюс'] },
    { list: 'white', label: 'Логістик Плюс', keys: ['name:логістик плюс'] },
  ]);
  const r = await e.migrateNameKeys();
  assert.deepEqual(await byId(st, 1), ['name:логістик плюс'], 'чорному — нове написання');
  assert.ok((await byId(st, 2)).length > 0, 'білий запис не порожній');
  assert.equal(r.blackWon, 1);
  // заявки цієї фірми — чорні, а не обрані
  const load = { id: 'm1', status: 'new', company: 'Логістик Плюс', fromCity: 'Київ', toCity: 'Львів', seenAt: 1, lardi: [] };
  await st.putLoad(load);
  assert.equal(await st.listOfKeys(customerKeys(load)), 'black');
  assert.equal((await st.listLoads({ status: 'all' })).total, 0, 'прихована як чорна');
  assert.equal((await st.listLoads({ status: 'all', fav: true })).total, 0, 'і не в обраних');
  const { nameKeyIssues } = await h.call('customers.list', {});
  assert.deepEqual(nameKeyIssues, [{
    kind: 'clash', key: 'name:логістик плюс', winner: 1,
    entries: [{ id: 1, list: 'black', label: 'ТОВ «Логістик-Плюс»' }, { id: 2, list: 'white', label: 'Логістик Плюс' }],
  }]);
  const log = await logOf(h);
  assert.equal(log.filter((m) => /^Назви в списках/.test(m)).length, 1, 'один рядок');
  assert.match(log.find((m) => /^Назви в списках/.test(m)), /спір чорного з білим — на користь чорного: 1/);
  await everyoneKeyed(h);
});

test('M2: назва, що за новими правилами — лише форма власності, лишає старий ключ і позначена як нерозв\'язана', async () => {
  const { h, e, st } = await oldDb([{ list: 'black', label: 'Приватне підприємство', keys: ['name:приватне підприємство'] }]);
  const r = await e.migrateNameKeys();
  assert.deepEqual(await byId(st, 1), ['name:приватне підприємство'], 'ключ не чіпали');
  assert.equal(r.kept, 1);
  assert.deepEqual((await h.call('customers.list', {})).nameKeyIssues,
    [{ kind: 'empty', key: 'name:приватне підприємство', winner: null, entries: [{ id: 1, list: 'black', label: 'Приватне підприємство' }] }]);
  await everyoneKeyed(h);
});

test('спір у межах одного списку і білий проти вже чорного: ключ не перехоплюється, старий лишається, спір записано', async () => {
  const { h, e, st } = await oldDb([
    { list: 'black', label: 'Альфа-Транс', keys: ['name:альфа-транс'] },
    { list: 'black', label: 'Альфа Транс', keys: ['name:альфа транс'] },
    { list: 'white', label: 'Бета-Плюс', keys: ['name:бета-плюс'] },
    { list: 'black', label: 'Бета Плюс', keys: ['name:бета плюс'] },
  ]);
  const r = await e.migrateNameKeys();
  assert.deepEqual(await byId(st, 1), ['name:альфа-транс']);
  assert.deepEqual(await byId(st, 2), ['name:альфа транс']);
  assert.deepEqual(await byId(st, 3), ['name:бета-плюс'], 'білий не забирає ключ у чорного');
  assert.deepEqual(await byId(st, 4), ['name:бета плюс']);
  assert.equal(r.kept, 2);
  assert.equal(r.blackWon, 0);
  const issues = (await h.call('customers.list', {})).nameKeyIssues;
  assert.deepEqual(issues.map((x) => [x.kind, x.key, x.winner, x.entries.map((y) => y.id)]), [
    ['clash', 'name:альфа транс', null, [1, 2]],
    ['clash', 'name:бета плюс', 4, [3, 4]],
  ]);
  await everyoneKeyed(h);
});

test('чесне джерело — підпис запису: якщо з нього вийшов старий ключ, новий береться з підпису (апостроф ‘ не губиться)', async () => {
  const label = 'Мар‘яна-Транс'; // U+2018: стара нормалізація розрізала слово
  assert.equal(nameKeyV1(label), 'мар яна-транс');
  const { e, st } = await oldDb([
    { list: 'black', label, keys: ['name:мар яна-транс'] },
    { list: 'black', label: 'Петро, не платить', keys: ['name:гамма-сервіс'] }, // підпис — не назва: беремо з ключа
  ]);
  await e.migrateNameKeys();
  assert.deepEqual(await byId(st, 1), ["name:мар'яна транс"]);
  assert.deepEqual(await byId(st, 2), ['name:гамма сервіс']);
});

test('запис без жодного ключа (після першої версії міграції) — відновлюється з підпису; якщо не вийшло — це видно', async () => {
  const { h, e, st } = await oldDb([
    { list: 'black', label: 'ТОВ «Логістик-Плюс»', keys: [] },
    { list: 'black', label: '067 111 22 33', keys: [] },
    { list: 'white', label: 'Омега', keys: ['name:омега'] },
    { list: 'black', label: 'Омега', keys: [] },
    { list: 'black', label: null, keys: [] },
  ], { flag: 2 }); // база, яку вже обробила перша версія міграції
  const r = await e.migrateNameKeys();
  assert.equal(r.repaired, 2);
  assert.deepEqual(await byId(st, 1), ['name:логістик плюс']);
  assert.deepEqual(await byId(st, 2), ['tel:380671112233']);
  assert.deepEqual(await byId(st, 3), ['name:омега'], 'чужий ключ не перехоплено');
  assert.deepEqual(await byId(st, 4), []);
  const issues = (await h.call('customers.list', {})).nameKeyIssues;
  assert.deepEqual(issues.map((x) => [x.kind, x.key, x.entries.map((y) => y.id)]), [['keyless', 'name:омега', [3, 4]], ['keyless', null, [5]]]);
});

test('двічі поспіль і на вже мігрованій базі: другий прохід нічого не змінює, спори ті самі; позначка версії не пускає третій', async () => {
  const { h, e, st } = await oldDb([
    { list: 'black', label: 'ТОВ «Логістик-Плюс»', keys: ['name:логістик-плюс'] },
    { list: 'white', label: 'Логістик Плюс', keys: ['name:логістик плюс'] },
    { list: 'black', label: 'Приватне підприємство', keys: ['name:приватне підприємство'] },
    { list: 'black', label: 'Альфа-Транс', keys: ['name:альфа-транс'] },
    { list: 'black', label: 'Альфа Транс', keys: ['name:альфа транс'] },
  ]);
  const keys = async () => (await h.call('customers.list', {})).items.map((c) => [c.id, c.list, c.keys]).sort((a, b) => a[0] - b[0]);
  await e.migrateNameKeys();
  const once = { keys: await keys(), issues: (await h.call('customers.list', {})).nameKeyIssues };
  assert.equal(await e.migrateNameKeys(), null, 'позначка версії — прохід не йде');
  await st.setKV('meta:nameKeysV', 0);
  const r2 = await e.migrateNameKeys();
  assert.equal(r2.changed, 0);
  assert.equal(r2.blackWon, 0);
  assert.deepEqual(await keys(), once.keys);
  assert.deepEqual((await h.call('customers.list', {})).nameKeyIssues, once.issues);
  assert.equal(await st.getKV('meta:nameKeysV', 0), NAME_KEYS_V);
  await everyoneKeyed(h);
});

test('спір зникає з nameKeyIssues, щойно клієнтка прибрала зайвий запис', async () => {
  const { h, e } = await oldDb([
    { list: 'black', label: 'Альфа-Транс', keys: ['name:альфа-транс'] },
    { list: 'black', label: 'Альфа Транс', keys: ['name:альфа транс'] },
  ]);
  await e.migrateNameKeys();
  assert.equal((await h.call('customers.list', {})).nameKeyIssues.length, 1);
  await h.call('customers.remove', { id: 1, fromBlack: true }); // чорний — навмисно
  assert.deepEqual((await h.call('customers.list', {})).nameKeyIssues, []);
});
