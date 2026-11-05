// remove-guard-ta-lichba: «Прибрати» чорного запису — лише з явним {fromBlack: true} (як add/move);
// «знову видно заявок» — лише ті, що справді стали видимі цією дією (не ті, що ховає інший чорний запис).
// Випадки тестувальника: P1 (panel-dodaty-nazvu-fix — застарілий список + «Прибрати»), V1/V2 (visible-count.qa.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, live, withCompanies, HTML } from './helpers/harness.mjs';
import { asLoggedIn, withCustomers } from './helpers/della-fixtures.mjs';

const A = { code: 'A1', name: 'ТОВ «Альфа»' };
const B = { code: 'B2', name: 'Бета Транс' };
const AB = withCompanies(HTML, (i) => (i % 2 ? B : A)); // 10 заявок Альфи, 6 — Бети

async function collected() {
  const h = setup({ html: AB });
  await live(h);
  await h.engine().runCycle();
  return h;
}
const snapshot = async (h) => ({
  customers: (await h.call('customers.list', {})).items.map((c) => [c.id, c.list, c.keys, c.note]),
  visible: (await h.list({ status: 'all' })).total,
  queued: (await h.list({ status: 'queued' })).total,
});

test('P1: застарілий список — «Прибрати» запису, який інший клієнт уже переніс у чорний, без прапорця — відмова з подробицями, нічого не змінено', async () => {
  const h = await collected();
  // у панелі D — в «Обраних»
  const d = (await h.call('customers.add', { list: 'white', text: 'della:A1', note: 'D: обраний' })).customer;
  // інший клієнт: «Обрані» → чорний (прапорець не потрібен)
  await h.call('customers.move', { id: d.id, list: 'black' });
  const before = await snapshot(h);
  const n = h.calls.lardi.length;
  // панель, не перезавантажившись, тисне «Прибрати» на D, гадаючи, що це обраний
  const r = await h.rpc('customers.remove', { id: d.id });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'fromBlack');
  assert.match(r.error, /зараз у чорному списку/);
  assert.match(r.error, /лише після підтвердження/);
  assert.equal(r.data.action, 'remove');
  assert.equal(r.data.list, null, 'нікуди не переносимо — прибираємо');
  assert.deepEqual(r.data.entries, [{ id: d.id, list: 'black', label: d.label, keys: d.keys }], 'запис, його список, його ключі');
  assert.equal(r.data.loads, 10, 'скільки заявок повернулося б');
  assert.deepEqual(await snapshot(h), before, 'запис на місці, чорний, нотатка ціла; заявки приховані, черга та сама');
  assert.equal(h.calls.lardi.length, n, 'жодного запиту до Lardi');
});

test('remove чорного: прапорець — лише буквальне true (не 1, не "true", не {} …)', async () => {
  const h = await collected();
  const black = (await h.call('customers.add', { list: 'black', text: 'della:A1' })).customer;
  const before = await snapshot(h);
  for (const fromBlack of [1, 'true', 'TRUE', 'yes', {}, [true], null, false, 0]) {
    const r = await h.rpc('customers.remove', { id: black.id, fromBlack });
    assert.equal(r.ok, false, `fromBlack=${JSON.stringify(fromBlack)}`);
    assert.equal(r.code, 'fromBlack');
  }
  assert.deepEqual(await snapshot(h), before);
});

test('remove чорного з fromBlack: true — прибирає і каже правду (restored / archived / queued / visible)', async () => {
  const h = await collected();
  const black = (await h.call('customers.add', { list: 'black', text: 'della:A1' })).customer;
  const own = (await h.list({ customer: black.id, status: 'all' })).items;
  await h.engine().store.updateLoad(own[0].id, (l) => ({ ...l, dateFrom: '2026-09-01', dateTo: undefined }));
  const visibleBefore = (await h.list({ status: 'all' })).total;
  const r = await h.call('customers.remove', { id: black.id, fromBlack: true });
  assert.deepEqual([r.restored, r.archived], [9, 1]);
  assert.equal(r.visible, 10, 'знову видно — і в роботі, і в Архіві');
  assert.equal((await h.list({ status: 'all' })).total, visibleBefore + 10);
  assert.equal(r.queued, (await h.list({ status: 'queued' })).items.filter((l) => l.dellaCompanyId === 'A1').length);
  assert.ok(r.queued > 0);
  assert.equal((await h.call('customers.list', {})).items.length, 0);
});

test('«Прибрати» з «Обраних» — як і було: без прапорця, нічого не повертається', async () => {
  const h = await collected();
  const fav = (await h.call('customers.add', { list: 'white', text: 'della:B2' })).customer;
  const visibleBefore = (await h.list({ status: 'all' })).total;
  const r = await h.call('customers.remove', { id: fav.id });
  assert.deepEqual([r.restored, r.archived, r.queued, r.visible], [0, 0, 0, 0]);
  assert.equal((await h.list({ status: 'all' })).total, visibleBefore);
  assert.equal((await h.call('customers.list', {})).items.length, 0);
});

// ---- лічильник «знову видно»: випадки тестувальника V1 / V2 ----
const PAGE = asLoggedIn(withCustomers(HTML, () => ({ name: 'ТОВ «Двічі»', phone: '+38 (067) 111-22-33' })));
async function twoBlacks() {
  const h = setup(); await live(h);
  h.della = (u, hd) => (hd.Cookie ? PAGE : HTML);
  await h.call('della.session.set', { cookie: 'PHPSESSID=QAvisible02' });
  await h.engine().runCycle({ forcePoll: true });
  const a = (await h.call('customers.add', { list: 'black', text: '067 111 22 33' })).customer;
  // окремий чорний запис за назвою (ключі різні) ховає ті самі заявки
  const b = (await h.call('customers.add', { list: 'black', keys: ['name:двічі'] })).customer;
  assert.notEqual(a.id, b.id);
  const hidden = (await h.list({ customer: b.id, status: 'all' })).items.filter((l) => l.inactiveKind === 'blacklist').length;
  assert.ok(hidden > 0, 'передумова: заявки приховані');
  return { h, a, b, hidden };
}
const stillHidden = async (h, b) => (await h.list({ customer: b.id, status: 'all' })).items.filter((l) => l.inactiveKind === 'blacklist').length;

for (const how of ['move', 'remove', 'add']) {
  test(`V1 (${how}): зняти один із ДВОХ чорних записів, що ховають ті самі заявки → visible 0, і відмова без прапорця каже «повернеться 0»`, async () => {
    const { h, a, b, hidden } = await twoBlacks();
    const call = (extra) => (how === 'move' ? h.rpc('customers.move', { id: a.id, list: 'white', ...extra })
      : how === 'remove' ? h.rpc('customers.remove', { id: a.id, ...extra })
        : h.rpc('customers.add', { list: 'white', text: '067 111 22 33', ...extra }));
    const no = await call({});
    assert.equal(no.code, 'fromBlack');
    assert.equal(no.data.loads, 0, 'інший чорний запис їх і далі ховає');
    assert.match(no.error, /повернеться заявок: 0/);
    const r = await call({ fromBlack: true });
    assert.equal(r.ok, true, r.error);
    const aff = how === 'remove' ? r.result : r.result.affected;
    assert.equal(await stillHidden(h, b), hidden, 'передумова: досі приховані іншим записом');
    assert.equal(aff.visible, 0, `affected.visible=${aff.visible}, а ${hidden} заявок досі ховає «${b.label}»`);
    assert.equal(aff.restored, 0);
    assert.equal(aff.queued, 0);
  });
}

test('V2: зняти єдиний чорний запис → visible = скільки справді знову видно', async () => {
  const h = setup(); await live(h);
  h.della = (u, hd) => (hd.Cookie ? PAGE : HTML);
  await h.call('della.session.set', { cookie: 'PHPSESSID=QAvisible01' });
  await h.engine().runCycle({ forcePoll: true });
  const byPhone = (await h.call('customers.add', { list: 'black', text: '067 111 22 33' })).customer;
  await h.call('customers.add', { list: 'black', text: 'ТОВ «Двічі Інша»' }); // стороння назва
  const no = await h.rpc('customers.move', { id: byPhone.id, list: 'white' });
  const r = await h.call('customers.move', { id: byPhone.id, list: 'white', fromBlack: true });
  const own = (await h.list({ customer: byPhone.id, status: 'all' })).items;
  const vis = own.filter((l) => l.inactiveKind !== 'blacklist' && l.status !== 'deleted').length;
  assert.ok(vis > 0);
  assert.equal(r.affected.visible, vis);
  assert.equal(no.data.loads, vis, 'відмова передбачила те саме число');
});

test('злиття в «Обрані» (fromBlack: true): visible — лише ті, що були приховані, не заявки обраного, які й так було видно', async () => {
  const h = await collected();
  await h.call('customers.add', { list: 'black', text: 'della:A1' });
  await h.call('customers.add', { list: 'white', text: 'della:B2' }); // 6 заявок Бети — видно й так
  const no = await h.rpc('customers.add', { list: 'white', keys: ['della:B2', 'della:A1'] });
  assert.equal(no.data.loads, 10);
  const r = await h.call('customers.add', { list: 'white', keys: ['della:B2', 'della:A1'], fromBlack: true });
  assert.equal(r.customer.list, 'white');
  assert.equal(r.affected.visible, 10, 'знову видно лише 10 заявок Альфи, не 16');
});

test('заявки, видалені вручну, у «знову видно» не входять', async () => {
  const h = await collected();
  const black = (await h.call('customers.add', { list: 'black', text: 'della:A1' })).customer;
  const own = (await h.list({ customer: black.id, status: 'all' })).items;
  await h.call('loads.delete', { id: own[0].id, fromLardi: false });
  const r = await h.call('customers.remove', { id: black.id, fromBlack: true });
  assert.equal(r.visible, 9);
});
