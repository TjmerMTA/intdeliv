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
