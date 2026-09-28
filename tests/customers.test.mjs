// Чорний / білий список замовників: ключі, приховування, порядок, черга, зняття з Lardi, міграція.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerKeys, phoneKey, normCompany, parseCustomerInput, weakKeys } from '../extension/lib/model.js';
import { parseDellaSearch } from '../extension/lib/della.js';
import { Store } from '../worker/src/store.js';
import { D1Database } from '../server/d1-sqlite.mjs';
import { setup, live, withCompanies, HTML, SCHEMA, TOK_B } from './helpers/harness.mjs';

const A = { code: 'A1', name: 'ТОВ «Альфа»' }; // 10 заявок фікстури проходять фільтри
const B = { code: 'B2', name: 'Бета Транс' }; // 6 заявок
const AB = withCompanies(HTML, (i) => (i % 2 ? B : A));

// 1
test('customerKeys: телефон, назва, порожньо; request_id ключем не стає', () => {
  for (const p of ['+38 (050) 123-45-67', '0501234567', '380501234567']) assert.deepEqual(customerKeys({ phone: p }), ['tel:380501234567']);
  assert.equal(phoneKey('12345'), '');
  assert.deepEqual(customerKeys({ company: 'ТОВ «Логістик-Плюс»' }), customerKeys({ company: 'логістик-плюс, тов' }));
  assert.deepEqual(customerKeys({ company: 'ТОВ «Логістик-Плюс»' }), ['name:логістик-плюс']);
  assert.equal(normCompany('ТзОВ "Рога і Копита"'), 'рога і копита');
  assert.deepEqual(customerKeys({}), []);
  assert.deepEqual(customerKeys({ company: 'ФОП' }), [], 'загальна назва — не ключ');
  assert.deepEqual(customerKeys({ company: 'Абв' }), [], 'коротша за 4 — не ключ');
  const card = parseDellaSearch(HTML, { now: new Date(2026, 8, 22) })[0];
  assert.ok(card.dellaRequestId);
  assert.deepEqual(customerKeys(card), [], 'анонімна картка Della — без ключів');
  const logged = parseDellaSearch(withCompanies(HTML, () => A), { now: new Date(2026, 8, 22) })[0];
  assert.deepEqual(customerKeys(logged), ['della:A1', 'name:альфа']);
  assert.equal(logged.company, 'ТОВ «Альфа»');
  assert.deepEqual(customerKeys({ edrpou: '12345678', phone: '067 111 22 33', company: 'Нова Пошта', dellaCompanyId: '55' }),
    ['della:55', 'edrpou:12345678', 'tel:380671112233', 'name:нова пошта']);
  assert.equal(weakKeys(['name:альфа']), true);
  assert.equal(weakKeys(['tel:380671112233', 'name:альфа']), false);
  assert.deepEqual(parseCustomerInput('067 111-22-33'), { phone: '067 111-22-33' });
  assert.deepEqual(parseCustomerInput('12345678'), { edrpou: '12345678' });
  assert.deepEqual(parseCustomerInput('Нова Пошта'), { name: 'Нова Пошта' });
});

// 2, 4
test('чорний список: preview лише читає; після підтвердження — зняття з Lardi на всіх акаунтах і приховування', async () => {
  const h = setup({ html: AB });
  await live(h);
  await h.engine().runCycle();
  const pubA = (await h.list({ status: 'published' })).items.filter((l) => l.dellaCompanyId === 'A1');
  assert.ok(pubA.length > 0, 'є опубліковані заявки Альфи');
  const before = (await h.list({ status: 'all' })).total;
  const anyA = (await h.list({ status: 'all' })).items.find((l) => l.dellaCompanyId === 'A1');

  const pv = await h.call('customers.preview', { loadId: anyA.id });
  assert.deepEqual(pv.keys, ['della:A1', 'name:альфа']);
  assert.equal(pv.loads, 10);
  assert.equal(pv.liveTotal, pubA.length * 2, 'живі публікації на обох акаунтах');
  assert.deepEqual(Object.keys(pv.live).sort(), ['A', 'B']);
  assert.equal(pv.weak, false);
  assert.equal(h.throws().length, 0, 'preview нічого не знімає');
  assert.equal((await h.list({ status: 'all' })).total, before, 'preview нічого не приховує');

  const r = await h.call('customers.add', { list: 'black', loadId: anyA.id });
  assert.equal(r.customer.list, 'black');
  assert.equal(r.affected.hidden, 10);
  assert.equal(r.affected.removed, pubA.length * 2);
  assert.equal(r.affected.failed, 0);
  const thrown = h.throws().flatMap((c) => c.body.cargoIds);
  const lardiIds = pubA.flatMap((l) => l.lardi.map((e) => e.id));
  assert.deepEqual(thrown.sort(), lardiIds.sort(), 'знято саме публікації Альфи, на обох акаунтах');

  for (const st of ['all', 'published', 'needs_review', ['inactive', 'deleted']]) {
    assert.ok((await h.list({ status: st })).items.every((l) => l.dellaCompanyId !== 'A1'), `вкладка ${st}`);
  }
  assert.equal((await h.list({ status: 'all' })).total, 6);
  const own = (await h.list({ customer: r.customer.id, status: 'all' })).items;
  assert.equal(own.length, 10);
  assert.ok(own.every((l) => l.status === 'inactive' && l.inactiveKind === 'blacklist' && l.statusReason === 'чорний список'));
  assert.ok(own.every((l) => l.lardi.every((e) => e.status !== 'published')));
  const st = await h.call('status.get');
  assert.equal(st.counts.inactive, 0, 'лічильники вкладок без прихованих');
  const cl = await h.call('customers.list', {});
  assert.equal(cl.hiddenBlack, 10);
  assert.equal(cl.items[0].loads, 10);

  // черга й публікація: для чорної заявки — жодного запиту до Lardi
  const n = h.calls.lardi.length;
  const e = await h.rpc('loads.publish', { id: anyA.id });
  assert.equal(e.ok, false);
  assert.match(e.error, /чорному списку/);
  const e2 = await h.rpc('loads.update', { id: anyA.id, patch: { status: 'queued' } });
  assert.equal(e2.ok, false);
  assert.equal(h.calls.lardi.length, n, 'відмова — без запитів до Lardi');
  h.clock.t += 60e3;
  await h.engine().publishTick(h.clock.t + 25e3); // публікує лише Бету
  const after = (await h.list({ customer: r.customer.id, status: 'all' })).items;
  assert.ok(after.every((l) => l.status === 'inactive' && l.lardi.every((e) => e.status !== 'published')));
  // гонка: заявка якимось чином у черзі — publishOne її не публікує, а ховає
  await h.engine().store.updateLoad(anyA.id, (l) => ({ ...l, status: 'queued' }));
  const m = h.calls.lardi.length;
  await h.engine().publishOne(anyA.id, 0, await h.engine().getSettings());
  assert.equal(h.calls.lardi.length, m);
  assert.equal((await h.engine().store.getLoad(anyA.id)).status, 'inactive');
});

// 3, 13
test('новий збір: заявки чорного замовника не зберігаються, «чорний список: N» у журналі; ручне додавання за телефоном', async () => {
  const h = setup({ html: AB });
  await h.call('customers.add', { list: 'black', text: 'della:B2', note: 'не платить' });
  await h.engine().runCycle();
  const all = (await h.list({ status: 'all' })).items;
  assert.equal(all.length, 10);
  assert.ok(all.every((l) => l.dellaCompanyId === 'A1'));
  const log = await h.call('log.list', { limit: 20 });
  assert.ok(log.some((x) => /чорний список: 6/.test(x.msg)), log.map((x) => x.msg).join('\n'));

  // замовника ще немає в базі — додаємо за телефоном; наступна заявка з цим телефоном одразу прихована
  const h2 = setup({ html: HTML.replace('двері металеві', 'двері металеві, тел. +38 (067) 555-44-33') });
  await h2.call('customers.add', { list: 'black', text: '0675554433' });
  await h2.engine().runCycle();
  const items = (await h2.list({ status: 'all' })).items;
  assert.ok(items.every((l) => !/555-44-33/.test(l.phone || '')));
});

// 5
test('Lardi недоступний під час зняття: заявки приховані, failed > 0, повторне додавання знімає лише залишок', async () => {
  const h = setup({ html: AB });
  await live(h);
  await h.engine().runCycle();
  const pubB = (await h.list({ status: 'published' })).items.filter((l) => l.dellaCompanyId === 'B2');
  assert.ok(pubB.length > 0);
  h.lardiDown = true;
  const r = await h.call('customers.add', { list: 'black', text: 'della:B2' });
  assert.equal(r.affected.removed, 0);
  assert.equal(r.affected.failed, pubB.length * 2);
  assert.ok((await h.list({ status: 'all' })).items.every((l) => l.dellaCompanyId !== 'B2'), 'все одно приховані');
  assert.ok((await h.call('log.list', {})).some((x) => x.level === 'error' && /Не вдалося зняти/.test(x.msg)));

  h.lardiDown = false;
  const n = h.throws().length;
  const r2 = await h.call('customers.add', { list: 'black', text: 'della:B2' });
  assert.equal(r2.affected.removed, pubB.length * 2);
  assert.equal(r2.affected.hidden, 0, 'уже приховані');
  assert.equal(h.throws().length - n, pubB.length * 2);
  const n2 = h.throws().length;
  await h.call('customers.add', { list: 'black', text: 'della:B2' });
  assert.equal(h.throws().length, n2, 'нічого не знімається двічі');
  assert.equal((await h.call('customers.list', {})).items.length, 1, 'дубля немає');
});

// 6
test('зняття з чорного списку: актуальні — знову в роботі й у черзі, минулі — лишаються в архіві', async () => {
  const h = setup({ html: AB });
  await live(h);
  await h.engine().runCycle();
  const { customer } = await h.call('customers.add', { list: 'black', text: 'della:A1' });
  // одна з заявок стала минулою
  const own = (await h.list({ customer: customer.id, status: 'all' })).items;
  const past = own[0];
  await h.engine().store.updateLoad(past.id, (l) => ({ ...l, dateFrom: '2026-09-01', dateTo: undefined }));
  const r = await h.call('customers.remove', { id: customer.id });
  assert.equal(r.restored, 9);
  assert.equal(r.archived, 1);
  const all = (await h.list({ status: 'all' })).items;
  assert.equal(all.filter((l) => l.dellaCompanyId === 'A1').length, 10, 'більше не приховані');
  const back = all.filter((l) => l.dellaCompanyId === 'A1' && l.id !== past.id);
  assert.ok(back.every((l) => l.status === 'queued'), 'автопублікація — одразу в черзі');
  assert.ok(back.every((l) => l.lardi.every((e) => e.status !== 'removed')), 'знятих публікуємо заново');
  const p = all.find((l) => l.id === past.id);
  assert.equal(p.status, 'inactive');
  assert.equal(p.inactiveKind, 'date');
  assert.equal((await h.call('customers.list', {})).items.length, 0);
});

// 7
test('обрані: ★ завжди вгорі на всіх сторінках, усередині групи — seenAt DESC; фільтр fav', async () => {
  const h = setup({ html: AB });
  await h.engine().runCycle();
  // рознести seenAt, щоб порядок усередині груп був визначений
  const st = h.engine().store;
  const items = (await h.list({ status: 'all' })).items;
  for (let i = 0; i < items.length; i++) await st.updateLoad(items[i].id, (l) => ({ ...l, seenAt: 1000 + i }));
  await h.call('customers.add', { list: 'white', text: 'della:B2' });
  const pages = [];
  for (let off = 0; off < 16; off += 4) pages.push(...(await h.list({ status: 'all', limit: 4, offset: off })).items);
  assert.equal(pages.length, 16);
  assert.ok(pages.slice(0, 6).every((l) => l.fav === true && l.dellaCompanyId === 'B2'), 'перші 6 — обрані, навіть на 2-й сторінці');
  assert.ok(pages.slice(6).every((l) => !l.fav));
  for (const grp of [pages.slice(0, 6), pages.slice(6)]) {
    for (let i = 1; i < grp.length; i++) assert.ok(grp[i - 1].seenAt >= grp[i].seenAt);
  }
  const favs = await h.list({ status: 'all', fav: true });
  assert.equal(favs.total, 6);
});

// 8, 9
test('черга: обрана публікується першою, хоч звичайна новіша; обрані не обходять фільтри', async () => {
  const h = setup({ html: AB });
  await h.call('settings.set', { lardi: { autoPublish: false } });
  await h.engine().runCycle();
  const all = (await h.list({ status: 'all' })).items;
  const fav = all.find((l) => l.dellaCompanyId === 'B2');
  const plain = all.find((l) => l.dellaCompanyId === 'A1');
  await h.call('customers.add', { list: 'white', text: 'della:B2' });
  await live(h, [{ name: 'A', token: 'tokAAAA1111', enabled: true }], { autoPublish: false });
  h.clock.t += 1000;
  await h.engine().enqueue(fav.id, true);
  h.clock.t += 1000;
  await h.engine().enqueue(plain.id, true); // новіша в черзі
  await h.engine().publishTick(h.clock.t + 1000);
  assert.equal(h.posts().length, 1);
  assert.equal((await h.engine().store.getLoad(fav.id)).status, 'published', 'першою — обрана');

  // обраний замовник із ціною < minPrice не збирається
  const h2 = setup({ html: withCompanies(HTML, () => ({ code: 'C3', name: 'Гамма' })) });
  await h2.call('customers.add', { list: 'white', text: 'della:C3' });
  await h2.engine().runCycle();
  const items = (await h2.list({ status: 'all' })).items;
  assert.equal(items.length, 16);
  assert.ok(items.every((l) => l.price >= 8000));
});

// 10
test('ключ не може бути у двох списках: додавання в інший список переносить, дубля немає; move', async () => {
  const h = setup({ html: AB });
  await h.engine().runCycle();
  const w = await h.call('customers.add', { list: 'white', text: '0501234567', label: 'Петро' });
  const b = await h.call('customers.add', { list: 'black', phone: '+38 050 123 45 67' });
  assert.equal(b.customer.id, w.customer.id);
  assert.equal(b.customer.list, 'black');
  assert.equal(b.customer.label, 'Петро');
  const cl = await h.call('customers.list', {});
  assert.equal(cl.items.length, 1);
  // злиття двох записів, що виявились одним замовником
  const c2 = await h.call('customers.add', { list: 'white', text: 'della:A1' });
  const m = await h.call('customers.add', { list: 'white', keys: ['della:A1', 'tel:380501234567'] });
  assert.equal((await h.call('customers.list', {})).items.length, 1);
  assert.deepEqual(m.customer.keys.sort(), ['della:A1', 'tel:380501234567']);
  assert.ok([c2.customer.id, w.customer.id].includes(m.customer.id));
  const mv = await h.call('customers.move', { id: m.customer.id, list: 'black' });
  assert.equal(mv.customer.list, 'black');
  assert.equal(mv.affected.hidden, 10);
  const up = await h.call('customers.update', { id: m.customer.id, note: 'кидав на оплату' });
  assert.equal(up.note, 'кидав на оплату');
});

// 11, 12
test('ручна правка телефону/компанії: заявка підхоплює список і виходить з нього; без ключів — зрозуміла помилка', async () => {
  const h = setup();
  await h.engine().runCycle();
  const [l] = (await h.list({ status: 'all' })).items;
  const noKeys = await h.rpc('customers.add', { list: 'black', loadId: l.id });
  assert.equal(noKeys.ok, false);
  assert.match(noKeys.error, /Немає даних про замовника/);

  await h.call('customers.add', { list: 'black', text: '067 777 66 55' });
  await h.call('loads.update', { id: l.id, patch: { phone: '0677776655' } });
  assert.ok(!(await h.list({ status: 'all' })).items.some((x) => x.id === l.id), 'підхопила чорний список');
  const got = await h.engine().store.getLoad(l.id);
  assert.equal(got.inactiveKind, 'blacklist');
  await h.call('loads.update', { id: l.id, patch: { phone: '0670000000' } });
  const back = (await h.list({ status: 'all' })).items.find((x) => x.id === l.id);
  assert.ok(back, 'знову видно');
  assert.ok(['new', 'queued'].includes(back.status));

  await h.call('customers.add', { list: 'white', text: 'Нова Пошта' });
  await h.call('loads.update', { id: l.id, patch: { company: 'ТОВ "Нова Пошта"' } });
  const top = (await h.list({ status: 'all' })).items[0];
  assert.equal(top.id, l.id);
  assert.equal(top.fav, true);
  const pv = await h.call('customers.preview', { text: 'Нова Пошта' });
  assert.equal(pv.weak, true, 'лише за назвою — попередження');
  const bad = await h.rpc('customers.add', { list: 'black', text: '12' });
  assert.equal(bad.ok, false);
});

// 14
test('міграція: стара схема без custKeys і таблиць замовників — без втрат, повторно — no-op', async () => {
  const OLD = `CREATE TABLE loads (id TEXT PRIMARY KEY, status TEXT NOT NULL, seenAt INTEGER NOT NULL, firstSeenAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL, queuedAt INTEGER, dateLast TEXT, fromCity TEXT, toCity TEXT, fromRegion TEXT, toRegion TEXT, phone TEXT,
    fromCityLc TEXT, toCityLc TEXT, fromRegionLc TEXT, toRegionLc TEXT, phoneDigits TEXT, search TEXT, lardi TEXT, data TEXT NOT NULL);
    CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT);`;
  const db = new D1Database(':memory:');
  db.db.exec(OLD);
  const ins = db.db.prepare('INSERT INTO loads (id, status, seenAt, firstSeenAt, updatedAt, lardi, data) VALUES (?, ?, 1, 1, 1, ?, ?)');
  for (let i = 0; i < 1234; i++) {
    const data = { id: 'd' + i, status: 'published', lardi: [{ account: 0, id: i, status: 'published' }], ...(i % 10 === 0 ? { phone: '067 111 22 ' + String(i % 100).padStart(2, '0') } : {}) };
    ins.run('d' + i, 'published', JSON.stringify(data.lardi), JSON.stringify(data));
  }
  const dump = () => db.db.prepare('SELECT id, status, lardi, data FROM loads ORDER BY id').all().map((r) => ({ ...r }));
  const before = dump();
  db.applySchema(SCHEMA); // як server/run.mjs при старті
  const st = new Store(db);
  assert.equal(await st.migrate(), 1234);
  assert.deepEqual(dump(), before, 'наявні дані не змінено');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM loads WHERE custKeys = '|tel:380671112200|'").first()).n, 13);
  assert.equal(await st.migrate(), 0, 'повторно — нічого');
  // стара база працює з новим кодом
  await st.upsertCustomer('black', ['tel:380671112200']);
  assert.equal((await st.listLoads({ status: 'all', limit: 5000 })).total, 1234 - 13);
  const fresh = new D1Database(':memory:', { schemaPath: SCHEMA });
  assert.equal(await new Store(fresh).migrate(), 0, 'порожня нова база');
});

// 15
test('добір зняття: 503 на одному акаунті — другий знято одразу, решту знімає наступний прохід staleCheck, без дублів', async () => {
  const h = setup({ html: AB });
  await live(h);
  await h.engine().runCycle();
  const pubB = (await h.list({ status: 'published' })).items.filter((l) => l.dellaCompanyId === 'B2');
  assert.ok(pubB.length > 0);
  const idsOn = (acc) => pubB.flatMap((l) => l.lardi.filter((e) => e.account === acc).map((e) => e.id)).sort();
  h.lardiDownFor.add(TOK_B);
  const r = await h.call('customers.add', { list: 'black', text: 'della:B2' });
  assert.equal(r.affected.removed, pubB.length, 'акаунт A знято');
  assert.equal(r.affected.failed, pubB.length, 'акаунт B — 503');
  const black = () => h.call('customers.list', { list: 'black' }).then((x) => x.items[0]);
  assert.equal((await black()).live, pubB.length, 'на Lardi ще N — лише публікації B');

  // B досі лежить: прохід пробує лише B, A повторно не знімає
  let n = h.throws().length;
  await h.engine().staleCheck();
  assert.ok(h.throws().length > n, 'спроба була');
  assert.ok(h.throws().slice(n).every((c) => c.token === TOK_B), 'A не чіпаємо');
  assert.equal((await black()).live, pubB.length);
  assert.ok((await h.call('log.list', {})).some((x) => x.level === 'error' && /Добір зняття: «B»/.test(x.msg)));

  // B піднявся: наступний прохід знімає залишок
  h.lardiDownFor.clear();
  n = h.throws().length;
  await h.engine().staleCheck();
  const done = h.throws().slice(n);
  assert.ok(done.every((c) => c.token === TOK_B));
  assert.deepEqual(done.flatMap((c) => c.body.cargoIds).sort(), idsOn(1), 'знято саме залишок на B, по одному разу');
  assert.equal((await black()).live, 0);
  const own = (await h.list({ customer: (await black()).id, status: 'all' })).items;
  assert.ok(own.every((l) => l.lardi.every((e) => e.status !== 'published' && !e.error)));
  assert.ok((await h.call('log.list', {})).some((x) => /Добір зняття з Lardi: знято/.test(x.msg)));

  n = h.throws().length;
  await h.engine().staleCheck();
  assert.equal(h.throws().length, n, 'нічого не знімається двічі');
});

// 16
test('добір зняття: ліміт за прохід, неактуальні (не чорні) теж, видалені — ні', async () => {
  const h = setup({ html: AB });
  await live(h);
  await h.engine().runCycle();
  const pub = (await h.list({ status: 'published' })).items;
  const [manual, gone] = pub.filter((l) => l.dellaCompanyId === 'B2');
  h.lardiDown = true;
  await h.call('customers.add', { list: 'black', text: 'della:A1' });
  await h.call('loads.unpublish', { id: manual.id });
  await h.call('loads.delete', { id: gone.id });
  h.lardiDown = false;
  const pubA = pub.filter((l) => l.dellaCompanyId === 'A1');
  const want = [...pubA, manual].flatMap((l) => l.lardi.map((e) => e.id)).sort();

  const e = h.engine();
  await e.ready();
  const s = await e.getSettings();
  const got = [];
  for (let pass = 0; pass < 20; pass++) {
    const n = h.throws().length;
    const r = await e.sweepLardi(s, 3);
    const ids = h.throws().slice(n).flatMap((c) => c.body.cargoIds);
    assert.ok(ids.length <= 3, `прохід ${pass}: не більше ліміту`);
    assert.equal(r.removed, ids.length);
    got.push(...ids);
    if (!ids.length) break;
  }
  assert.deepEqual(got.sort(), want, 'усі чорні й неактуальні, кожна рівно раз');
  assert.ok(!got.some((id) => gone.lardi.some((x) => x.id === id)), 'видалену без зняття не чіпаємо');
});
