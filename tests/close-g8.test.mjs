// close-g8: правка заявки (телефон / компанія / ЄДРПОУ), що вивела б її з чорного списку, — лише з явним {fromBlack: true};
// без нього — відмова того ж вигляду, що й у customers.* (action 'edit'). Правка, що з чорного списку не виводить, — як була.
// І: restored / queued у customers.add / move / remove — лише заявки цієї дії, не залишки чогось іншого.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, live, withCompanies, HTML } from './helpers/harness.mjs';
import { asLoggedIn, withCustomers } from './helpers/della-fixtures.mjs';

const PAGE = asLoggedIn(withCustomers(HTML, () => ({ name: 'ТОВ «Двічі»', phone: '+38 (067) 111-22-33', edrpou: '12345678' })));
const BY = {
  phone: { add: { text: '067 111 22 33' }, patch: { phone: '050 999 00 00' } },
  company: { add: { name: 'ТОВ «Двічі»' }, patch: { company: 'ТОВ «Інша»' } },
  edrpou: { add: { edrpou: '12345678' }, patch: { edrpou: '87654321' } },
};

/** Зібрано з входом у Della; замовника заблоковано за одним ключем by; l — одна прихована актуальна заявка. */
async function blocked(by = 'phone', { autoPublish = true } = {}) {
  const h = setup(); await live(h, undefined, { autoPublish });
  h.della = (u, hd) => (hd.Cookie ? PAGE : HTML);
  await h.call('della.session.set', { cookie: 'PHPSESSID=QAcloseg8' });
  await h.engine().runCycle({ forcePoll: true });
  const black = (await h.call('customers.add', { list: 'black', ...BY[by].add })).customer;
  const own = (await h.list({ customer: black.id, status: 'all' })).items;
  const l = own.find((x) => x.inactiveKind === 'blacklist');
  assert.ok(l, 'передумова: заявку приховано чорним списком');
  return { h, black, l, patch: BY[by].patch };
}
const state = async (h, id) => ({
  load: await h.engine().store.getLoad(id),
  customers: (await h.call('customers.list', {})).items.map((c) => [c.id, c.list, c.keys]),
  visible: (await h.list({ status: 'all' })).total,
  queued: (await h.list({ status: 'queued' })).total,
  lardi: h.calls.lardi.length,
});
const refusal = (r, black, l, outcome) => {
  assert.equal(r.ok, false, 'має бути відмова');
  assert.equal(r.code, 'fromBlack');
  assert.match(r.error, /чорн/);
  assert.match(r.error, /лише після підтвердження/);
  assert.deepEqual(r.data, {
    action: 'edit', list: null, loadId: l.id,
    entries: [{ id: black.id, list: 'black', label: black.label, keys: black.keys }],
    loads: 1, outcome,
  });
};

for (const by of Object.keys(BY)) {
  test(`G8 (${by}): правка, що вивела б заявку з чорного списку, без прапорця — відмова; нічого не записано, нічого не пішло на Lardi`, async () => {
    const { h, black, l, patch } = await blocked(by);
    const before = await state(h, l.id);
    refusal(await h.rpc('loads.update', { id: l.id, patch }), black, l, 'queued');
    // те саме зі status: 'queued' в тій самій правці — колись одразу ставило в чергу вручну
    refusal(await h.rpc('loads.update', { id: l.id, patch: { ...patch, status: 'queued' } }), black, l, 'queued');
    refusal(await h.rpc('loads.update', { id: l.id, patch: { ...patch, status: 'inactive' } }), black, l, 'inactive');
    refusal(await h.rpc('loads.update', { id: l.id, patch: { ...patch, price: 12345, edited: true } }), black, l, 'queued');
    assert.deepEqual(await state(h, l.id), before, 'заявка байт у байт, списки, видимі, черга, Lardi — як були');
  });
}

test('G8: прапорець — лише буквальне true', async () => {
  const { h, black, l, patch } = await blocked();
  const before = await state(h, l.id);
  for (const fromBlack of [1, 'true', 'TRUE', 'yes', {}, [true], null, false, 0]) {
    refusal(await h.rpc('loads.update', { id: l.id, patch, fromBlack }), black, l, 'queued');
  }
  assert.deepEqual(await state(h, l.id), before);
});

test('G8: відмова каже, що станеться: без автопублікації — «new», минула — «archived»', async () => {
  const off = await blocked('phone', { autoPublish: false });
  refusal(await off.h.rpc('loads.update', { id: off.l.id, patch: off.patch }), off.black, off.l, 'new');
  refusal(await off.h.rpc('loads.update', { id: off.l.id, patch: { ...off.patch, status: 'queued' } }), off.black, off.l, 'queued');
  const past = await blocked();
  await past.h.engine().store.updateLoad(past.l.id, (x) => ({ ...x, dateFrom: '2026-09-01', dateTo: undefined }));
  const l = await past.h.engine().store.getLoad(past.l.id);
  refusal(await past.h.rpc('loads.update', { id: l.id, patch: past.patch }), past.black, l, 'archived');
});

test('G8 навмисно (fromBlack: true): правка проходить і каже правду — що вивільнено і що стало в чергу', async () => {
  const { h, black, l, patch } = await blocked();
  const r = await h.call('loads.update', { id: l.id, patch, fromBlack: true });
  assert.equal(r.phone, patch.phone);
  assert.equal(r.status, 'queued');
  assert.equal(r.inactiveKind, undefined);
  assert.deepEqual(r.affected, { visible: 1, restored: 1, archived: 0, queued: 1, entries: [{ id: black.id, list: 'black', label: black.label, keys: black.keys }] });
  const saved = await h.engine().store.getLoad(l.id);
  assert.equal(saved.affected, undefined, 'affected — лише у відповіді, не в базі');
  assert.ok((await h.list({ status: 'queued' })).items.some((x) => x.id === l.id), 'у черзі на Lardi');
  assert.equal((await h.engine().store.getCustomer(black.id)).list, 'black', 'сам запис лишився в чорному списку');
  assert.ok((await h.call('log.list', {})).some((x) => /вийшла з чорного списку.*підтверджено/.test(x.msg)), 'у журналі');
});

test('G8 навмисно: без автопублікації — у роботі, не в черзі; зі status: queued — у черзі вручну; зі status: inactive — знята; минула — в Архіві', async () => {
  const a = await blocked('phone', { autoPublish: false });
  const ra = await a.h.call('loads.update', { id: a.l.id, patch: a.patch, fromBlack: true });
  assert.equal(ra.status, 'new');
  assert.deepEqual([ra.affected.visible, ra.affected.restored, ra.affected.archived, ra.affected.queued], [1, 1, 0, 0]);

  const b = await blocked('phone', { autoPublish: false });
  const rb = await b.h.call('loads.update', { id: b.l.id, patch: { ...b.patch, status: 'queued' }, fromBlack: true });
  assert.equal(rb.status, 'queued');
  assert.equal(rb.affected.queued, 1);

  const c = await blocked();
  const rc = await c.h.call('loads.update', { id: c.l.id, patch: { ...c.patch, status: 'inactive' }, fromBlack: true });
  assert.equal(rc.status, 'inactive');
  assert.equal(rc.inactiveKind, 'manual');
  assert.deepEqual([rc.affected.visible, rc.affected.queued], [1, 0]);

  const d = await blocked();
  await d.h.engine().store.updateLoad(d.l.id, (x) => ({ ...x, dateFrom: '2026-09-01', dateTo: undefined }));
  const rd = await d.h.call('loads.update', { id: d.l.id, patch: d.patch, fromBlack: true });
  assert.equal(rd.status, 'inactive');
  assert.equal(rd.inactiveKind, 'date');
  assert.deepEqual([rd.affected.visible, rd.affected.restored, rd.affected.archived, rd.affected.queued], [1, 0, 1, 0]);
});

test('правка, що з чорного списку НЕ виводить (ціна, коментар, той самий телефон інакше, другий чорний ключ) — без прапорця й питання, заявка лишається прихованою', async () => {
  const { h, black, l } = await blocked();
  const n = h.calls.lardi.length;
  const p = await h.rpc('loads.update', { id: l.id, patch: { price: 4321, edited: true } });
  assert.equal(p.ok, true, p.error);
  assert.equal(p.result.price, 4321);
  assert.equal(p.result.affected, undefined);
  const c = await h.rpc('loads.update', { id: l.id, patch: { comment: 'дзвонила' } });
  assert.equal(c.ok, true, c.error);
  assert.equal(c.result.comment, 'дзвонила');
  const same = await h.rpc('loads.update', { id: l.id, patch: { phone: '+380671112233' } });
  assert.equal(same.ok, true, same.error);
  // ще один чорний запис — за назвою: телефон змінено, але назва й далі ховає
  await h.call('customers.add', { list: 'black', name: 'ТОВ «Двічі»' });
  const other = await h.rpc('loads.update', { id: l.id, patch: { phone: '050 999 00 00' } });
  assert.equal(other.ok, true, other.error);
  const got = await h.engine().store.getLoad(l.id);
  assert.deepEqual([got.status, got.inactiveKind, got.price, got.comment, got.phone], ['inactive', 'blacklist', 4321, 'дзвонила', '050 999 00 00']);
  assert.ok(!(await h.list({ status: 'all' })).items.some((x) => x.id === l.id), 'прихована');
  assert.equal(h.calls.lardi.length, n, 'на Lardi нічого');
  assert.equal((await h.engine().store.getCustomer(black.id)).list, 'black');
});

test('правка, що вводить заявку в чорний список, — як і була, без прапорця', async () => {
  const h = setup(); await live(h);
  h.della = (u, hd) => (hd.Cookie ? PAGE : HTML);
  await h.call('della.session.set', { cookie: 'PHPSESSID=QAcloseg8' });
  await h.engine().runCycle({ forcePoll: true });
  await h.call('customers.add', { list: 'black', text: '050 999 00 00' });
  const [l] = (await h.list({ status: 'all' })).items;
  const r = await h.rpc('loads.update', { id: l.id, patch: { phone: '050 999 00 00' } });
  assert.equal(r.ok, true, r.error);
  assert.equal((await h.engine().store.getLoad(l.id)).inactiveKind, 'blacklist');
});

// ---- restored / queued — лише цієї дії ----
const A = { code: 'A1', name: 'ТОВ «Альфа»' };
const B = { code: 'B2', name: 'Бета Транс' };
const AB = withCompanies(HTML, (i) => (i % 2 ? B : A)); // 10 заявок Альфи, 6 — Бети

for (const how of ['remove', 'move', 'add']) {
  test(`restored / queued (${how}): лише заявки цього запису; залишок «прихована, але вже не чорна» від чогось іншого — не чіпаємо й не рахуємо`, async () => {
    const h = setup({ html: AB }); await live(h);
    await h.engine().runCycle();
    const black = (await h.call('customers.add', { list: 'black', text: 'della:A1' })).customer;
    // залишок: заявка Бети, прихована «чорним списком», хоча Бети в ньому немає (давнє недороблене зняття)
    const left = (await h.list({ status: 'all' })).items.find((x) => x.dellaCompanyId === 'B2');
    await h.engine().store.updateLoad(left.id, (x) => ({ ...x, status: 'inactive', inactiveKind: 'blacklist', statusReason: 'чорний список' }));
    const r = how === 'remove' ? await h.call('customers.remove', { id: black.id, fromBlack: true })
      : how === 'move' ? (await h.call('customers.move', { id: black.id, list: 'white', fromBlack: true })).affected
        : (await h.call('customers.add', { list: 'white', text: 'della:A1', fromBlack: true })).affected;
    const queuedA = (await h.list({ status: 'queued' })).items.filter((x) => x.dellaCompanyId === 'A1').length;
    assert.deepEqual([r.restored, r.archived, r.visible], [10, 0, 10]);
    assert.equal(r.queued, queuedA);
    const still = await h.engine().store.getLoad(left.id);
    assert.deepEqual([still.status, still.inactiveKind], ['inactive', 'blacklist'], 'чужий залишок не вивільнено цією дією');
  });
}
