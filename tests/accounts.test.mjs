// N акаунтів Lardi: стан, токени, розподіл, ліміти, статистика, авто-пауза при 401, догін, «видалення».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, live, TOK_A, TOK_B, TOK_C } from './helpers/harness.mjs';

const acc = (name, token, enabled = true) => ({ name, token, enabled });

// 15
test('3 акаунти зберігаються й читаються, масиви статистики довжини N, максимум 5', async () => {
  const h = setup();
  const s = await h.call('settings.set', { lardi: { accounts: [acc('A', TOK_A), acc('B', TOK_B), acc('C', TOK_C)] } });
  assert.equal(s.lardi.accounts.length, 3);
  assert.deepEqual(s.lardi.accounts.map((a) => a.state), ['ok', 'ok', 'ok']);
  const st = await h.call('status.get');
  assert.equal(st.today.published.length, 3);
  assert.equal(st.today.dry.length, 3);
  assert.equal(st.accounts.length, 3);
  const seven = Array.from({ length: 7 }, (_, i) => acc('X' + i, ''));
  const s7 = await h.call('settings.set', { lardi: { accounts: seven } });
  assert.equal(s7.lardi.accounts.length, 5);
  assert.equal(s7.lardi.accounts[0].token, '••••1111', 'порожній токен — не змінювати');
  // стара адмінка шле лише 2 акаунти — решта не зникає
  const s2 = await h.call('settings.set', { lardi: { accounts: [acc('A', '••••1111'), acc('B', '••••2222')] } });
  assert.equal(s2.lardi.accounts.length, 5);
  assert.equal(s2.lardi.accounts[2].token, '••••3333');
});

// 16
test('акаунт без токена «очікує підключення»: не бере участі ні в бойовому режимі, ні в dry-run', async () => {
  const h = setup();
  const s = await live(h, [acc('A', TOK_A), acc('Друге Ларді', '')]);
  assert.equal(s.lardi.accounts[1].state, 'pending');
  assert.equal(s.lardi.accounts[1].hasToken, false);
  await h.engine().runCycle();
  assert.ok(h.posts().length > 0);
  assert.ok(h.posts().every((p) => p.token === TOK_A));
  const items = (await h.list({ status: 'all' })).items;
  assert.ok(items.every((l) => l.lardi.every((e) => e.account === 0)));

  const d = setup();
  await d.call('settings.set', { lardi: { dryRun: true, intervalSeconds: 5, accounts: [acc('A', TOK_A), acc('B', '')] } });
  await d.engine().runCycle();
  const st = await d.call('status.get');
  assert.ok(st.today.dry[0] > 0);
  assert.equal(st.today.dry[1], 0, 'dry-run не рахує акаунт без токена');
  const log = await d.call('log.list', { limit: 200 });
  assert.ok(log.some((x) => /would publish → Lardi «A»/.test(x.msg)));
  assert.ok(!log.some((x) => /would publish → Lardi «B»/.test(x.msg)));
});

// 17
test('токен: у відповідях лише ••••XXXX, у журналі немає; порожнє/маска — не змінювати', async () => {
  const h = setup();
  const SECRET = 'tokSECRET-9f8e7d6c5b4a';
  const s = await h.call('settings.set', { lardi: { accounts: [acc('A', TOK_A), acc('Друге', SECRET)] } });
  assert.equal(s.lardi.accounts[1].token, '••••5b4a');
  const got = await h.call('settings.get');
  assert.equal(got.lardi.accounts[1].token, '••••5b4a');
  assert.ok(!JSON.stringify(got).includes(SECRET));
  assert.ok(!JSON.stringify(await h.call('status.get')).includes(SECRET));
  assert.ok(!JSON.stringify(await h.call('lardi.accounts')).includes(SECRET));
  for (const t of ['', '••••5b4a']) await h.call('settings.set', { lardi: { accounts: [acc('A', t), acc('Друге', t)] } });
  const raw = await h.engine().getSettings();
  assert.equal(raw.lardi.accounts[1].token, SECRET);
  assert.equal(raw.lardi.accounts[0].token, TOK_A);
  const log = await h.call('log.list', { limit: 500 });
  assert.ok(log.some((x) => /«Друге»: збережено новий токен/.test(x.msg)));
  assert.ok(!JSON.stringify(log).includes(SECRET));
  assert.ok(!JSON.stringify(log).includes(TOK_A));
});

// 18
test('both: кожна заявка на обидва; вимкнули один — лише на другий; roundrobin чергує', async () => {
  const h = setup();
  await live(h);
  await h.engine().runCycle();
  const byTok = (t) => h.posts().filter((p) => p.token === t).length;
  assert.equal(byTok(TOK_A), byTok(TOK_B));
  const pub = (await h.list({ status: 'published' })).items;
  assert.ok(pub.every((l) => l.lardi.length === 2));

  const h2 = setup();
  await live(h2, [acc('A', TOK_A, false), acc('B', TOK_B)]);
  await h2.engine().runCycle();
  assert.ok(h2.posts().length > 0 && h2.posts().every((p) => p.token === TOK_B));

  const h3 = setup();
  await live(h3, undefined, { mode: 'roundrobin' });
  await h3.engine().runCycle();
  const toks = h3.posts().map((p) => p.token);
  assert.ok(toks.length >= 4);
  const nA = toks.filter((t) => t === TOK_A).length;
  assert.ok(Math.abs(nA - (toks.length - nA)) <= 1, 'по черзі: ' + toks.join(','));
  const rr = (await h3.list({ status: 'published' })).items;
  assert.ok(rr.every((l) => l.lardi.length === 1));
});

// 19
test('ліміт на добу — per-account: один уперся, другий продовжує', async () => {
  const h = setup();
  await live(h, undefined, { dailyLimit: 3 });
  const e = h.engine();
  await e.bump('published:0', 3);
  await e.runCycle();
  assert.ok(h.posts().length >= 3);
  assert.ok(h.posts().every((p) => p.token === TOK_B));
  assert.equal(h.posts().length, 3, 'B теж до ліміту');
});

// 20, 21
test('статистика lardi.accounts; 401 → invalid, авто-пауза, інший працює; новий токен відновлює', async () => {
  const h = setup();
  await live(h, [acc('A', TOK_A), acc('B', TOK_B)]);
  await h.engine().runCycle();
  const stats = await h.call('lardi.accounts');
  const pubA = h.posts().filter((p) => p.token === TOK_A).length;
  assert.equal(stats[0].today.published, pubA);
  assert.equal(stats[0].live, pubA);
  assert.equal(stats[0].errors, 0);
  assert.ok(stats[0].lastPublishAt > 0);
  assert.equal(stats[1].state, 'ok');

  // токен B відкликали на Lardi: у налаштуваннях він «правильний», але Lardi відповідає 401
  const s = await h.engine().getSettings();
  s.lardi.accounts[1].token = 'revoked-token';
  await h.engine().store.setKV('settings', s);
  h.clock.t += 60e3;
  const before = h.posts().length;
  await h.engine().runCycle({ skipPoll: true });
  const st = await h.call('lardi.accounts');
  assert.equal(st[1].state, 'invalid');
  assert.match(st[1].lastError, /401/);
  assert.ok(h.posts().slice(before).some((p) => p.token === TOK_A), 'A працює далі');
  const revoked = () => h.calls.lardi.filter((c) => c.token === 'revoked-token').length;
  assert.ok(revoked() > 0);
  const r0 = revoked();
  h.clock.t += 60e3;
  await h.engine().runCycle({ skipPoll: true });
  assert.equal(revoked(), r0, 'на паузі — жодного запиту з відхиленим токеном');
  assert.equal((await h.call('status.get')).accounts[1].state, 'invalid');
  assert.ok((await h.call('log.list', {})).some((x) => /відхилив токен/.test(x.msg)));
  const q = (await h.list({ status: 'all' })).items.filter((l) => l.lardi.some((e) => e.account === 1 && e.status === 'error'));
  assert.ok(q.every((l) => ['queued', 'published'].includes(l.status)), 'заявка не падає в «Помилка» через токен');

  const r = await h.call('settings.set', { lardi: { accounts: [acc('A', '••••1111'), acc('B', 'tokNEW5555')] } });
  assert.equal(r.lardi.accounts[1].state, 'ok');
  // пропущене за час паузи доганяється кнопкою «догін»
  const bf = await h.call('lardi.backfill', { accountIndex: 1 });
  assert.ok(bf.queued > 0);
  await h.settle();
  h.clock.t += 60e3;
  const n = h.posts().length;
  await h.engine().runCycle({ skipPoll: true });
  assert.ok(h.posts().slice(n).some((p) => p.token === 'tokNEW5555'));
  // перевірка невірного токена
  const bad = await h.call('lardi.test', { accountIndex: 0, token: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal((await h.call('lardi.accounts'))[0].state, 'ok', 'перевірка чужого токена не чіпає збережений');
});

// 22
test('догін нового акаунта: лише актуальні опубліковані без запису на ньому, не чорні, обрані першими, у межах ліміту', async () => {
  const h = setup();
  await live(h, [acc('A', TOK_A), acc('Друге', '')], { intervalSeconds: 1 });
  await h.engine().runCycle();
  const pub = (await h.list({ status: 'published' })).items;
  assert.ok(pub.length >= 5, `опубліковано ${pub.length}`);
  const e = h.engine();
  // одна минула, одна — від чорного замовника, одна — від обраного
  await e.store.updateLoad(pub[0].id, (l) => ({ ...l, dateFrom: '2026-09-01', dateTo: undefined }));
  await h.call('loads.update', { id: pub[1].id, patch: { phone: '0501112233' } });
  await h.call('customers.add', { list: 'black', text: '0501112233' });
  await h.call('loads.update', { id: pub[2].id, patch: { phone: '0504445566' } });
  await h.call('customers.add', { list: 'white', text: '0504445566' });
  const denied = await h.rpc('lardi.backfill', { accountIndex: 1 });
  assert.equal(denied.ok, false, 'без токена — ні');
  await h.call('settings.set', { lardi: { accounts: [acc('A', '••••1111'), acc('Друге', TOK_B)], dailyLimit: 3 } });
  const pv = await h.call('lardi.backfill', { accountIndex: 1, dryRunOnly: true });
  assert.equal(pv.candidates, 3, 'обмежено лімітом');
  const r = await h.call('lardi.backfill', { accountIndex: 1 });
  assert.equal(r.queued, 3);
  const queued = (await h.list({ status: 'queued' })).items.map((l) => l.id);
  assert.ok(queued.includes(pub[2].id), 'обраний — у першій трійці');
  assert.ok(!queued.includes(pub[0].id) && !queued.includes(pub[1].id));
  await h.settle();
  h.clock.t += 60e3;
  await e.publishTick(h.clock.t + 25e3);
  const onB = (await h.list({ account: 1, status: 'all' })).items;
  assert.equal(onB.length, 3);
  assert.ok(onB.every((l) => l.status === 'published' && l.lardi.length === 2));
  assert.ok((await h.list({ account: 'none', status: 'all' })).items.every((l) => l.lardi.every((x) => x.status !== 'published')));
});

// 23
test('«видалення» акаунта = вимкнення + очищення токена; індекси й lardi[].account не змінюються', async () => {
  const h = setup();
  await live(h, [acc('A', TOK_A), acc('B', TOK_B), acc('C', TOK_C)]);
  await h.engine().runCycle();
  const before = (await h.list({ status: 'all' })).items.map((l) => [l.id, l.lardi.map((e) => e.account)]);
  const s = await h.call('settings.set', { lardi: { accounts: [acc('A', '••••1111'), { ...acc('B', '••••2222'), archived: true }, acc('C', '••••3333')] } });
  assert.equal(s.lardi.accounts.length, 3);
  assert.deepEqual(s.lardi.accounts.map((a) => a.name), ['A', 'B', 'C']);
  assert.equal(s.lardi.accounts[1].state, 'disabled');
  assert.equal(s.lardi.accounts[1].archived, true);
  assert.equal(s.lardi.accounts[1].token, '');
  assert.equal((await h.engine().getSettings()).lardi.accounts[1].token, '', 'токен стерто');
  assert.equal(s.lardi.accounts[2].token, '••••3333');
  const after = (await h.list({ status: 'all' })).items.map((l) => [l.id, l.lardi.map((e) => e.account)]);
  assert.deepEqual(after, before);
  h.clock.t += 60e3;
  const n = h.posts().length;
  await h.engine().runCycle({ skipPoll: true });
  assert.ok(h.posts().slice(n).every((p) => p.token !== TOK_B));
});
