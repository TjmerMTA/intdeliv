// stale-black-mark: заявки з позначкою «чорний список», які вже не підпадають під жоден ключ чорного списку в базі,
// staleCheck повертає туди, де їм місце (у роботу / чергу / Архів) — обмежено за прохід, з рядком журналу.
// Це не зняття блокування: заявку, що підпадає під будь-який чорний ключ, не чіпаємо; правда — з бази, не з позначки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, live, withCompanies, HTML } from './helpers/harness.mjs';

const A = { code: 'A1', name: 'ТОВ «Альфа»' };
const B = { code: 'B2', name: 'Бета Транс' };
const AB = withCompanies(HTML, (i) => (i % 2 ? B : A)); // 10 заявок Альфи, 6 — Бети
const LOG = /більше не підпадають під чорний список — повернулися/;

/** Альфа справді в чорному списку; Бети в ньому немає, але її заявки марковано «чорний список» (давнє недороблене зняття). */
async function base({ autoPublish = true } = {}) {
  const h = setup({ html: AB }); await live(h, undefined, { autoPublish });
  await h.engine().runCycle();
  const black = (await h.call('customers.add', { list: 'black', text: 'della:A1' })).customer;
  const st = h.engine().store;
  const betas = (await h.list({ status: 'all' })).items.filter((x) => x.dellaCompanyId === 'B2');
  for (const l of betas) {
    await st.updateLoad(l.id, (x) => ({ ...x, status: 'inactive', inactiveKind: 'blacklist', statusReason: 'чорний список', queuedAt: null, lardi: (x.lardi || []).map((e) => ({ ...e, status: 'removed' })) }));
  }
  const alphas = (await h.list({ customer: black.id, status: 'all' })).items;
  assert.equal(alphas.length, 10);
  assert.ok(alphas.every((x) => x.inactiveKind === 'blacklist'), 'передумова: Альфу сховано');
  return { h, st, black, betas: betas.map((x) => x.id), alphas: alphas.map((x) => x.id) };
}
const loadsOf = async (st, ids) => Promise.all(ids.map((id) => st.getLoad(id)));
const marks = (ls) => ls.filter((x) => x.status === 'inactive' && x.inactiveKind === 'blacklist').length;

test('staleCheck: позначка без жодного чорного ключа — заявка повертається в роботу й чергу; рядок журналу її словами', async () => {
  const { h, st, betas } = await base();
  await h.engine().staleCheck();
  const after = await loadsOf(st, betas);
  assert.equal(marks(after), 0, 'позначок не лишилось');
  assert.ok(after.every((x) => x.status === 'queued'), 'автопублікація — у черзі');
  assert.ok(after.every((x) => x.inactiveKind === undefined));
  assert.ok(after.every((x) => (x.lardi || []).every((e) => e.status !== 'removed')), 'знятих публікуємо заново');
  const line = (await h.call('log.list', {})).find((x) => LOG.test(x.msg));
  assert.ok(line, 'рядок журналу');
  assert.match(line.msg, /^Чорний список: 6 заявок/);
  assert.match(line.msg, /у черзі на Lardi 6/);
  // повторний прохід — уже нічого, і рядок не повторюється
  const n = (await h.call('log.list', {})).filter((x) => LOG.test(x.msg)).length;
  await h.engine().staleCheck();
  assert.equal((await h.call('log.list', {})).filter((x) => LOG.test(x.msg)).length, n);
});

test('справді заблоковану заявку не чіпаємо — ні за колонкою, ні коли колонка застаріла, а дані замовника під чорним ключем', async () => {
  const { h, st, alphas } = await base();
  // правда — з даних: колонку однієї заявки Альфи «зіпсовано», SQL її чорною вже не вважає, але дані — під чорним ключем
  await st.db.prepare("UPDATE loads SET custKeys = '' WHERE id = ?").bind(alphas[0]).run();
  const before = await loadsOf(st, alphas);
  for (let i = 0; i < 3; i++) {
    h.clock.t += 61e3; // інакше наступний прохід міг би сховати вивільнену назад тими самими байтами
    await h.engine().staleCheck();
    assert.deepEqual(await loadsOf(st, alphas), before, `прохід ${i + 1}: заявки Альфи — байт у байт`);
    await h.engine().publishTick(h.clock.t + 60e3);
  }
  // (заявки Бети з base() вивільняються й ідуть на Lardi — так і треба; Альфи там немає)
  assert.ok((await loadsOf(st, alphas)).every((x) => !(x.lardi || []).some((e) => e.status === 'published')), 'Альфи на Lardi немає');
  assert.ok(!(await h.list({ status: 'all' })).items.some((x) => x.dellaCompanyId === 'A1' && x.id !== alphas[0]), 'Альфу не видно');
});

test('позначка, але замовник тим часом сам потрапив у чорний список — не чіпаємо (правда з бази, не з позначки)', async () => {
  const { h, st, betas } = await base();
  await h.call('customers.add', { list: 'black', name: 'Бета Транс' }); // за назвою — інший ключ, ніж della:B2
  const before = await loadsOf(st, betas);
  h.clock.t += 61e3;
  await h.engine().staleCheck();
  assert.deepEqual(await loadsOf(st, betas), before);
  assert.ok(!(await h.call('log.list', {})).some((x) => LOG.test(x.msg)));
});

test('туди, де їм місце: без автопублікації — у роботі; минула — в Архіві (дата); давно не видно в Della — в Архіві (неактуальна)', async () => {
  const { h, st, betas } = await base({ autoPublish: false });
  await st.updateLoad(betas[0], (x) => ({ ...x, dateFrom: '2026-09-01', dateTo: undefined }));
  await st.updateLoad(betas[1], (x) => ({ ...x, seenAt: 1 }));
  await h.engine().staleCheck();
  const [past, unseen, ...rest] = await loadsOf(st, betas);
  assert.deepEqual([past.status, past.inactiveKind], ['inactive', 'date']);
  assert.deepEqual([unseen.status, unseen.inactiveKind], ['inactive', 'stale']);
  assert.ok(rest.every((x) => x.status === 'new'), 'у роботі, не в черзі');
  const line = (await h.call('log.list', {})).find((x) => LOG.test(x.msg));
  assert.match(line.msg, /у роботі 4/);
  assert.match(line.msg, /в Архіві 2/);
  assert.doesNotMatch(line.msg, /у черзі/);
});

test('обмежено за прохід: не більше limit, кожна заявка — раз; решта — наступними проходами', async () => {
  const { h, st, betas } = await base();
  const e = h.engine();
  const s = await e.getSettings();
  const seen = [];
  for (let pass = 0; pass < 3; pass++) {
    const r = await e.reconcileBlackMarks(s, -1, 2);
    assert.equal(r.ids.length, 2, `прохід ${pass + 1}`);
    assert.equal(new Set(r.ids).size, 2, 'без повторів у проході');
    seen.push(...r.ids);
  }
  assert.deepEqual(seen.sort(), [...betas].sort(), 'кожна з шести — рівно раз');
  assert.equal((await e.reconcileBlackMarks(s, -1, 2)).ids.length, 0);
  assert.equal(marks(await loadsOf(st, betas)), 0);
  assert.ok((await h.call('log.list', {})).some((x) => LOG.test(x.msg) && /по 2 за прохід, решта — наступним/.test(x.msg)));
});

test('звичайний стан — тиша: без таких позначок staleCheck рядка не пише й нічого не чіпає', async () => {
  const h = setup({ html: AB }); await live(h);
  await h.engine().runCycle();
  await h.call('customers.add', { list: 'black', text: 'della:A1' });
  await h.engine().staleCheck();
  assert.ok(!(await h.call('log.list', {})).some((x) => LOG.test(x.msg)));
});

// ---- позначка без жодних даних про замовника: не повертаємо, а кажемо вголос ----
const NOBODY = /позначено «чорний список», але даних про замовника в них немає — лишили як є/;
/** Заявки Бети, яким стерто дані замовника (телефон, назва, код, ЄДРПОУ), — позначені «чорний список». */
async function nobody(st, ids) {
  for (const id of ids) {
    await st.updateLoad(id, (x) => {
      const y = { ...x };
      for (const k of ['phone', 'company', 'dellaCompanyId', 'edrpou']) delete y[k];
      return y;
    });
  }
  for (const id of ids) {
    const row = await st.db.prepare('SELECT custKeys FROM loads WHERE id = ?').bind(id).first();
    assert.equal(row.custKeys, '', 'передумова: даних про замовника немає');
  }
}

test('позначка без даних про замовника — не повертаємо, лишаємо як є; один рядок журналу, скільки їх, — і не щопроходу', async () => {
  const { h, st, betas } = await base();
  const anon = betas.slice(0, 2);
  await nobody(st, anon);
  const before = await loadsOf(st, anon);
  for (let i = 0; i < 3; i++) {
    h.clock.t += 61e3;
    await h.engine().staleCheck();
    assert.deepEqual(await loadsOf(st, anon), before, `прохід ${i + 1}: байт у байт`);
    await h.engine().publishTick(h.clock.t + 60e3);
  }
  assert.ok((await loadsOf(st, anon)).every((x) => !(x.lardi || []).some((e) => e.status === 'published')), 'на Lardi їх немає');
  const lines = (await h.call('log.list', {})).filter((x) => NOBODY.test(x.msg));
  assert.equal(lines.length, 1, 'вголос, але один раз, поки їх стільки ж');
  assert.match(lines[0].msg, /^Чорний список: 2 заявок/);
  // решту (з даними, під чорний список не підпадають) повернуто як і було
  assert.equal(marks(await loadsOf(st, betas.slice(2))), 0);
  // з'явилась ще одна — новий рядок з новим числом
  await nobody(st, [betas[2]]);
  await st.updateLoad(betas[2], (x) => ({ ...x, status: 'inactive', inactiveKind: 'blacklist', statusReason: 'чорний список' }));
  h.clock.t += 61e3;
  await h.engine().staleCheck();
  const again = (await h.call('log.list', {})).filter((x) => NOBODY.test(x.msg));
  assert.equal(again.length, 2);
  assert.ok(again.some((x) => /^Чорний список: 3 заявок/.test(x.msg)));
});

test('позначки без даних не займають місця в межі проходу — решту однаково повертаємо', async () => {
  const { h, st, betas } = await base();
  const anon = betas.slice(0, 3);
  await nobody(st, anon); // найдавніші — саме вони були б першими в черзі звірки
  const e = h.engine();
  const s = await e.getSettings();
  const r = await e.reconcileBlackMarks(s, -1, 2);
  assert.equal(r.ids.length, 2);
  assert.ok(r.ids.every((id) => !anon.includes(id)), 'у межі — лише ті, що з даними');
  assert.equal(r.restored, 2);
  assert.equal(r.nobody, 3);
  await e.reconcileBlackMarks(s, -1, 2);
  assert.equal(marks(await loadsOf(st, betas.slice(3))), 0, 'усі з даними повернуто');
  assert.equal(marks(await loadsOf(st, anon)), 3, 'без даних — на місці');
});
