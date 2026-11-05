// guard-black-to-white: ключ із чорного списку не йде в інший список без явного {fromBlack: true};
// відмова каже, який запис, у якому він списку і які ключі збіглися; навмисний перенос звітує, що зробив.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, live, withCompanies, HTML } from './helpers/harness.mjs';

const A = { code: 'A1', name: 'ТОВ «Альфа»' };
const B = { code: 'B2', name: 'Бета Транс' };
const AB = withCompanies(HTML, (i) => (i % 2 ? B : A)); // 10 заявок Альфи, 6 — Бети

/** Зібрано й опубліковано, Альфа — у чорному списку (її заявки приховані й зняті з Lardi). */
async function blackAlpha() {
  const h = setup({ html: AB });
  await live(h);
  await h.engine().runCycle();
  const { customer } = await h.call('customers.add', { list: 'black', text: 'della:A1' });
  const anyA = (await h.list({ customer: customer.id, status: 'all' })).items[0];
  return { h, black: customer, anyA };
}
const snapshot = async (h) => ({
  customers: (await h.call('customers.list', {})).items.map((c) => [c.id, c.list, c.keys]),
  visible: (await h.list({ status: 'all' })).total,
  queued: (await h.list({ status: 'queued' })).total,
});
const refused = (r, black, keys) => {
  assert.equal(r.ok, false);
  assert.equal(r.code, 'fromBlack');
  assert.match(r.error, /зараз у чорному списку/);
  assert.equal(r.data.list, 'white', 'куди хотіли');
  assert.deepEqual(r.data.entries, [{ id: black.id, list: 'black', label: black.label, keys }], 'який запис, де він, які ключі');
  assert.equal(r.data.loads, 10, 'скільки заявок повернулося б');
};

test('add у «Обрані» за ключем із чорного списку — відмова з подробицями, нічого не змінено (текст, ключі, заявка, поля)', async () => {
  const { h, black, anyA } = await blackAlpha();
  const before = await snapshot(h);
  const n = h.calls.lardi.length;
  for (const p of [{ text: 'della:A1' }, { keys: ['della:A1'] }, { loadId: anyA.id }, { dellaId: 'A1' }]) {
    const r = await h.rpc('customers.add', { list: 'white', ...p });
    refused(r, black, ['della:A1']);
  }
  // fromBlack лише true, не «truthy»
  for (const fromBlack of [1, 'true', 'yes', {}]) refused(await h.rpc('customers.add', { list: 'white', text: 'della:A1', fromBlack }), black, ['della:A1']);
  assert.deepEqual(await snapshot(h), before, 'записи, видимі заявки й черга — як були');
  assert.equal(h.calls.lardi.length, n, 'жодного запиту до Lardi');
});

test('злиття записів, серед яких чорний: в «Обрані» — відмова, чорний цілий; у чорний — можна без прапорця', async () => {
  const { h, black } = await blackAlpha();
  const fav = (await h.call('customers.add', { list: 'white', text: 'della:B2' })).customer;
  const before = await snapshot(h);
  const r = await h.rpc('customers.add', { list: 'white', keys: ['della:B2', 'della:A1'] });
  refused(r, black, ['della:A1']);
  assert.deepEqual(await snapshot(h), before, 'нічого не злито');
  // у чорний — білий зливається в чорний, чорний не губиться
  const m = await h.call('customers.add', { list: 'black', keys: ['della:B2', 'della:A1'] });
  assert.equal(m.customer.list, 'black');
  assert.deepEqual(m.customer.keys.sort(), ['della:A1', 'della:B2']);
  assert.deepEqual((await h.call('customers.list', {})).items.map((c) => c.id), [m.customer.id]);
  assert.ok([black.id, fav.id].includes(m.customer.id));
});

test('customers.move з чорного в «Обрані» — відмова без прапорця; update списку не міняє', async () => {
  const { h, black } = await blackAlpha();
  const before = await snapshot(h);
  refused(await h.rpc('customers.move', { id: black.id, list: 'white' }), black, black.keys);
  await h.call('customers.update', { id: black.id, label: 'Альфа', list: 'white' });
  const after = await snapshot(h);
  assert.deepEqual(after, before, 'update змінив лише підпис');
  assert.equal((await h.engine().store.getCustomer(black.id)).list, 'black');
});

test('навмисно (fromBlack: true): move і add переносять і кажуть правду — скільки заявок знову видно і скільки стало в чергу', async () => {
  for (const how of ['move', 'add']) {
    const { h, black } = await blackAlpha();
    const own = (await h.list({ customer: black.id, status: 'all' })).items;
    assert.equal(own.length, 10);
    // одна стала минулою: її знову видно (в Архіві), але в роботу й чергу вона не повертається
    await h.engine().store.updateLoad(own[0].id, (l) => ({ ...l, dateFrom: '2026-09-01', dateTo: undefined }));
    const visibleBefore = (await h.list({ status: 'all' })).total;
    const r = how === 'move'
      ? await h.call('customers.move', { id: black.id, list: 'white', fromBlack: true })
      : await h.call('customers.add', { list: 'white', text: 'della:A1', fromBlack: true });
    assert.equal(r.customer.list, 'white', how);
    assert.equal(r.affected.visible, 10, `${how}: знову видно`);
    assert.equal((await h.list({ status: 'all' })).total, visibleBefore + 10);
    const queuedNow = (await h.list({ customer: r.customer.id, status: 'queued' })).total;
    assert.equal(r.affected.queued, queuedNow, `${how}: стало в чергу`);
    assert.ok(queuedNow > 0);
    assert.deepEqual([r.affected.restored, r.affected.archived], [9, 1], `${how}: у роботі 9, в архіві 1`);
    assert.ok((await h.call('log.list', {})).some((x) => /з чорного списку в «Обрані» \(підтверджено\)/.test(x.msg)), 'у журналі');
  }
});

test('у чорний список — як і було, без прапорця; «Прибрати» чорного — лише з fromBlack: true, звітує ті самі лічильники', async () => {
  const h = setup({ html: AB });
  await live(h);
  await h.engine().runCycle();
  const w = (await h.call('customers.add', { list: 'white', text: 'della:A1' })).customer;
  const mv = await h.call('customers.move', { id: w.id, list: 'black' });
  assert.equal(mv.customer.list, 'black');
  assert.equal(mv.affected.hidden, 10);
  const no = await h.rpc('customers.remove', { id: w.id });
  assert.equal(no.code, 'fromBlack', 'без прапорця — відмова (remove-guard-ta-lichba)');
  const rm = await h.call('customers.remove', { id: w.id, fromBlack: true });
  assert.equal(rm.visible, 10);
  assert.equal(rm.restored + rm.archived, 10);
  assert.equal(typeof rm.queued, 'number');
});
