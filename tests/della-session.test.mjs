// Сесія Della з адмінки: зберігається лише в базі, перевіряється однією сторінкою, стан чесний і сам себе
// оновлює при зборі; охоплення замовником у status.get; чорний список догоняє вже зібрані заявки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dellaLoginState, parseDellaSearch, parseDellaSearchWithIds, contactsCalls, contactsBody, parseDellaContacts, parseJsArgs,
} from '../extension/lib/della.js';
import { customerKeys } from '../extension/lib/model.js';
import { normalizeDellaCookie, DEFAULT_SEARCH_URL, CONTACTS_PER_POLL } from '../worker/src/engine.js';
import { setup, live, HTML, T0 } from './helpers/harness.mjs';
import { asLoggedIn, withCustomers, withHiddenCompanies, withContactsCall } from './helpers/della-fixtures.mjs';

const COOKIE = 'PHPSESSID=s3cr3tSess10n; della_auth=Zq9xK2mP7tVb';
const SECRETS = ['s3cr3tSess10n', 'Zq9xK2mP7tVb'];
const ALFA = { code: 'A1', name: 'ТОВ «Альфа»', phone: '+38 (067) 111-22-33', edrpou: '12345678' };
const LOGGED = asLoggedIn(withCustomers(HTML, () => ALFA)); // вхід є, замовника видно
const BLIND = asLoggedIn(HTML); // вхід є, замовника не видно (акаунт не верифікований)
const PHONE_ONLY = asLoggedIn(withCustomers(HTML, () => ({ phone: '+38 (067) 111-22-33' })));
const NAME_ONLY = asLoggedIn(withCustomers(HTML, () => ({ name: 'ТОВ «Мар’яна-Транс»' })));
const NOW = new Date(2026, 8, 22, 10);
/** Della за кукою: наша сесія — page, будь-яка інша чи без куки — анонімна видача. */
const byCookie = (page) => (url, headers) => (headers.Cookie === COOKIE ? page : HTML);
const noSecret = (v, what) => {
  const s = JSON.stringify(v);
  for (const x of SECRETS) assert.ok(!s.includes(x), `${what}: значення сесії у виводі`);
};
const logOf = async (h) => (await h.call('log.list', { limit: 2000 })).map((x) => x.msg);
const core = (d) => ({ session: d.session, checkedAt: d.checkedAt, customerSeen: d.customerSeen });

test('сесія Della: рядок Cookie з DevTools нормалізується, порожньо — очистити, значення без назви — зрозуміла помилка', () => {
  assert.equal(normalizeDellaCookie('Cookie: a=1; b=2'), 'a=1; b=2');
  assert.equal(normalizeDellaCookie('  cookie:a=1;b=2;  '), 'a=1; b=2');
  assert.equal(normalizeDellaCookie('PHPSESSID=abc123'), 'PHPSESSID=abc123');
  assert.equal(normalizeDellaCookie('"a=1; b=2"'), 'a=1; b=2');
  assert.equal(normalizeDellaCookie('a=1;\r\n b=x==\n'), 'a=1; b=x==');
  for (const empty of ['', '   ', undefined, null, 'Cookie:  ']) assert.equal(normalizeDellaCookie(empty), '');
  for (const bad of ['abc123def', 'a=1; \u0000b=2', '=abc']) {
    assert.throws(() => normalizeDellaCookie(bad), (e) => /назва=значення|недопустим/.test(e.message) && !e.message.includes('abc'));
  }
});

test('ознаки входу Della: анонімна видача — без входу (доведено фікстурою), вимкнені ознаки — вхід є, без ознак — невідомо', () => {
  assert.equal(dellaLoginState(HTML), 'out');
  assert.equal(dellaLoginState(LOGGED), 'in');
  assert.equal(dellaLoginState(BLIND), 'in');
  // шапку змінили, а «Докладніше» досі веде на реєстрацію — однаково без входу
  assert.equal(dellaLoginState(HTML.replace(/<div id="unlogged_div"[^>]*>/, '<div>')), 'out');
  assert.equal(dellaLoginState('<html><body>Перевірка, що ви не робот</body></html>'), 'unknown');
  assert.equal(dellaLoginState(''), 'unknown');
});

test('залогінена картка: код і назва компанії, телефон, ЄДРПОУ; лапки атрибутів будь-які; кілька телефонів — усі ключами', () => {
  const [c] = parseDellaSearch(LOGGED, { now: NOW });
  assert.equal(c.dellaCompanyId, 'A1');
  assert.equal(c.company, 'ТОВ «Альфа»');
  assert.equal(c.phone, '+38 (067) 111-22-33');
  assert.equal(c.edrpou, '12345678');
  const sq = parseDellaSearch(HTML.replace(/(<div class="request_card(?:\s[^"]*)?"\s+data-request_id="[^"]*")/,
    "$1 data-company-code='Q7' data-company-name='Бета &amp; Ко'"), { now: NOW })[0];
  assert.equal(sq.dellaCompanyId, 'Q7');
  assert.equal(sq.company, 'Бета & Ко');
  const two = parseDellaSearch(withCustomers(HTML, (i) => (i ? null : { phone: '+38 (067) 111-22-33, +38 (050) 765-43-21' })), { now: NOW })[0];
  assert.deepEqual(customerKeys(two), ['tel:380671112233', 'tel:380507654321']);
  assert.deepEqual(customerKeys(parseDellaSearch(HTML, { now: NOW })[0]), [], 'анонімна картка — без замовника');
});

test('fetchDella: спершу сесія з адмінки, тоді DELLA_COOKIE, тоді без входу', async () => {
  const h = setup({ env: { DELLA_COOKIE: 'env_sess=E1' } });
  await h.engine().runCycle();
  assert.ok(h.calls.della.length > 0);
  assert.ok(h.calls.della.every((c) => c.headers.Cookie === 'env_sess=E1'), 'DELLA_COOKIE');
  await h.call('della.session.set', { cookie: 'Cookie: ' + COOKIE });
  h.calls.della.length = 0;
  h.clock.t += 120e3;
  await h.engine().poll();
  assert.ok(h.calls.della.length > 0);
  assert.ok(h.calls.della.every((c) => c.headers.Cookie === COOKIE), 'сесія з адмінки — першою');
  await h.call('della.session.set', { cookie: ' ' });
  h.calls.della.length = 0;
  await h.engine().poll();
  assert.ok(h.calls.della.every((c) => c.headers.Cookie === 'env_sess=E1'), 'сесію стерто — знову DELLA_COOKIE');
  const a = setup();
  await a.engine().runCycle();
  assert.ok(a.calls.della.length > 0 && a.calls.della.every((c) => !('Cookie' in c.headers)), 'без жодної — анонімно');
});

test('della.session.check: вхід є і замовника видно → alive, зразок картки; одна сторінка першого пошуку; стан у status/settings без нових запитів', async () => {
  const h = setup();
  const U2 = 'https://della.com.ua/search/a204bd204eflolz1z21z3z4z51z6z7z8z9y1y2y3y4y5y6h0ilk0m2.html';
  await h.call('settings.set', { della: { searchUrls: [DEFAULT_SEARCH_URL, U2] } });
  h.della = byCookie(LOGGED);
  assert.deepEqual(await h.call('della.session.set', { cookie: COOKIE }), { state: 'alive' });
  h.calls.della.length = 0;
  const r = await h.call('della.session.check', {});
  assert.deepEqual(Object.keys(r).sort(), ['cards', 'customerSeen', 'message', 'sample', 'state']);
  assert.deepEqual(r.cards, { withCustomer: 25, total: 25 });
  assert.equal(r.state, 'alive');
  assert.equal(r.customerSeen, true);
  assert.deepEqual(r.sample, {
    company: 'ТОВ «Альфа»', phone: '+38 (067) 111-22-33', edrpou: '12345678', dellaCompanyId: 'A1',
    has: { phone: true, company: true, dellaCompanyId: true, edrpou: true },
  });
  assert.match(r.message, /^Вхід працює: Della дає телефон, назву компанії, код компанії Della і ЄДРПОУ — чорний список спрацює і за телефоном, і за назвою \(замовника видно в 25 з 25 карток; приклад: ТОВ «Альфа», \+38 \(067\) 111-22-33\)\.$/);
  assert.equal(h.calls.della.length, 1, 'рівно одна сторінка');
  assert.equal(h.calls.della[0].url, DEFAULT_SEARCH_URL, 'перший пошук, перша сторінка');
  assert.equal(h.calls.della[0].headers.Cookie, COOKIE);

  const st = await h.call('status.get');
  assert.deepEqual(core(st.della), { session: 'alive', checkedAt: T0, customerSeen: true });
  const sg = await h.call('settings.get');
  assert.deepEqual(sg.della.session, { set: true, state: 'alive', checkedAt: T0, updatedAt: T0 });
  assert.equal(h.calls.della.length, 1, 'status.get і settings.get на Della не ходять');
  assert.ok((await logOf(h)).includes('Della: вхід є, замовник у картці видно'));
});

test('della.session.check: none, expired, blind, error — чесна причина українською, стан зберігається', async () => {
  const h = setup();
  const n = await h.call('della.session.check', {});
  assert.deepEqual({ ...n, message: '' }, { state: 'none', customerSeen: false, sample: null, cards: null, message: '' });
  assert.match(n.message, /не задано/);
  assert.equal(h.calls.della.length, 0, 'без сесії на Della не ходимо');

  h.della = () => HTML; // Della відповідає як без входу — сесію не прийнято
  assert.deepEqual(await h.call('della.session.set', { cookie: COOKIE }), { state: 'expired' });
  const e = await h.call('della.session.check', {});
  assert.equal(e.state, 'expired');
  assert.equal(e.customerSeen, false);
  assert.equal(e.sample, null);
  assert.match(e.message, /без входу/);
  assert.equal((await h.call('status.get')).della.session, 'expired');

  h.della = () => BLIND;
  const b = await h.call('della.session.check', {});
  assert.equal(b.state, 'blind');
  assert.equal(b.customerSeen, false);
  assert.equal(b.sample, null);
  assert.match(b.message, /не видно/);
  assert.match(b.message, /верифік/);

  h.della = () => new Response('busy', { status: 503 });
  const x = await h.call('della.session.check', {});
  assert.equal(x.state, 'error');
  assert.match(x.message, /503/);
  h.della = () => '<html><body>Перевірка, що ви не робот</body></html>';
  const y = await h.call('della.session.check', {});
  assert.equal(y.state, 'error');
  assert.match(y.message, /карток/);
  assert.equal((await h.call('status.get')).della.session, 'error');
});

test('della.session.set: порожньо — сесію видалено (стан none, збір без куки); значення без назви — помилка, нічого не збережено', async () => {
  const h = setup();
  h.della = byCookie(LOGGED);
  await h.call('della.session.set', { cookie: COOKIE });
  assert.deepEqual(await h.call('della.session.set', { cookie: '   ' }), { state: 'none' });
  const sg = await h.call('settings.get');
  assert.equal(sg.della.session.set, false);
  assert.equal(sg.della.session.state, 'none');
  assert.deepEqual(core((await h.call('status.get')).della), { session: 'none', checkedAt: null, customerSeen: false });
  h.calls.della.length = 0;
  await h.engine().runCycle();
  assert.ok(h.calls.della.length > 0 && h.calls.della.every((c) => !('Cookie' in c.headers)));
  assert.ok((await logOf(h)).some((m) => /^Della: сесію видалено/.test(m)));

  const bad = await h.rpc('della.session.set', { cookie: 'abc123def' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /назва=значення/);
  assert.ok(!bad.error.includes('abc123def'));
  assert.equal((await h.call('settings.get')).della.session.set, false);
});

test('збір із сесією: Della «вийшла» — expired і один рядок журналу за кілька опитувань; вхід повернувся — один рядок «вхід є…»', async () => {
  const h = setup();
  h.della = byCookie(LOGGED);
  await h.call('della.session.set', { cookie: COOKIE });
  let page = HTML;
  h.della = () => page;
  for (let i = 0; i < 3; i++) { h.clock.t += 61e3; await h.engine().poll(); }
  const st = await h.call('status.get');
  assert.equal(st.della.session, 'expired');
  assert.equal(st.della.customerSeen, false);
  assert.equal(st.della.checkedAt, h.clock.t, 'час останнього збору');
  let log = await logOf(h);
  assert.equal(log.filter((m) => /^Della: сесія закінчилась/.test(m)).length, 1, log.join('\n'));
  assert.ok((await h.list({ status: 'all' })).total > 0, 'збір іде далі');

  page = BLIND;
  for (let i = 0; i < 2; i++) { h.clock.t += 61e3; await h.engine().poll(); }
  assert.equal((await h.call('status.get')).della.session, 'blind');
  page = LOGGED;
  for (let i = 0; i < 3; i++) { h.clock.t += 61e3; await h.engine().poll(); }
  assert.deepEqual(core((await h.call('status.get')).della), { session: 'alive', checkedAt: h.clock.t, customerSeen: true });
  log = await logOf(h);
  assert.equal(log.filter((m) => m === 'Della: вхід є, замовник у картці видно').length, 2, 'при збереженні і при поверненні');
  assert.equal(log.filter((m) => /^Della: вхід є, але замовника/.test(m)).length, 1);
  assert.equal(log.filter((m) => /^Della: сесія закінчилась/.test(m)).length, 1);
});

test('гонка: збір зі старою сесією, що закінчився вже після збереження нової, стану нової не перезаписує', async () => {
  const h = setup();
  const OLD = 'PHPSESSID=old0ld0ld0ld';
  h.della = () => HTML;
  await h.call('della.session.set', { cookie: OLD });
  let release;
  const gate = new Promise((r) => { release = r; });
  h.della = async (url, headers) => {
    if (headers.Cookie !== OLD) return LOGGED;
    await gate; // стара сесія «висить» на Della
    return HTML;
  };
  const polling = h.engine().poll();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await h.call('della.session.set', { cookie: COOKIE }), { state: 'alive' });
  release();
  await polling;
  assert.equal((await h.call('status.get')).della.session, 'alive');
  assert.equal((await logOf(h)).filter((m) => /^Della: сесія закінчилась/.test(m)).length, 1, 'лише від першої перевірки старої');
});

test('status.get: custCoverage — скільки заявок мають замовника; заповнюється, коли сесія почала працювати', async () => {
  const h = setup();
  await h.engine().runCycle();
  let st = await h.call('status.get');
  assert.deepEqual(st.custCoverage, { withCustomer: 0, total: 16 });
  assert.deepEqual(core(st.della), { session: 'none', checkedAt: null, customerSeen: false });

  const half = asLoggedIn(withCustomers(HTML, (i) => (i % 2 ? null : ALFA)));
  h.della = byCookie(half);
  await h.call('della.session.set', { cookie: COOKIE });
  h.clock.t += 61e3;
  await h.engine().poll();
  const keyed = new Set((await parseDellaSearchWithIds(half, { now: NOW })).filter((p) => customerKeys(p).length).map((p) => p.id));
  const ids = (await h.list({ status: 'all' })).items.map((l) => l.id);
  const want = ids.filter((id) => keyed.has(id)).length;
  assert.ok(want > 0 && want < 16);
  st = await h.call('status.get');
  assert.deepEqual(st.custCoverage, { withCustomer: want, total: 16 });
});

/** Анонімно зібрано й опубліковано; у чорному списку ключ (телефон чи назва), якого анонімно не видно; потім сесія показала замовника. */
async function blackSeenLater(text = '067 111 22 33', page = LOGGED) {
  const h = setup();
  await live(h);
  await h.engine().runCycle();
  const pub = (await h.list({ status: 'published' })).items;
  assert.ok(pub.length > 0);
  // жива публікація може бути й у заявки, що ще в черзі на другий акаунт
  const liveIds = (await h.list({ status: 'all' })).items.flatMap((l) => l.lardi.filter((e) => e.status === 'published').map((e) => e.id)).sort();
  assert.ok(liveIds.length > 0);
  const add = await h.call('customers.add', { list: 'black', text });
  assert.equal(add.affected.hidden, 0, 'анонімно замовника не видно — приховувати нічого');
  h.della = byCookie(page);
  await h.call('della.session.set', { cookie: COOKIE });
  h.clock.t += 61e3;
  await h.engine().poll();
  return { h, pub, liveIds, customerId: add.customer.id };
}

test('customers.reapply: чорний список застосовується до заявок, що вже в базі; повторно — нічого', async () => {
  const { h, liveIds, customerId } = await blackSeenLater();
  const n = h.throws().length;
  const r = await h.call('customers.reapply', {});
  assert.deepEqual(Object.keys(r).sort(), ['failed', 'hidden', 'removed']);
  assert.equal(r.hidden, 16);
  assert.equal(r.removed, liveIds.length);
  assert.equal(r.failed, 0);
  assert.deepEqual(h.throws().slice(n).flatMap((c) => c.body.cargoIds).sort(), liveIds, 'знято саме живі публікації');
  assert.equal((await h.list({ status: 'all' })).total, 0);
  const own = (await h.list({ customer: customerId, status: 'all' })).items;
  assert.equal(own.length, 16);
  assert.ok(own.every((l) => l.status === 'inactive' && l.inactiveKind === 'blacklist'));
  assert.equal((await h.call('customers.list', { list: 'black' })).items[0].loads, 16);
  assert.ok((await logOf(h)).some((m) => /^Чорний список: застосовано до наявних заявок — приховано 16/.test(m)));
  const m = h.throws().length;
  assert.deepEqual(await h.call('customers.reapply', {}), { hidden: 0, removed: 0, failed: 0 });
  assert.equal(h.throws().length, m, 'нічого не знімається двічі');
});

test('customers.reapply: Lardi лежить — заявки однаково приховані, failed чесний, залишок знімає staleCheck', async () => {
  const { h, liveIds } = await blackSeenLater();
  h.lardiDown = true;
  const r = await h.call('customers.reapply', {});
  assert.deepEqual(r, { hidden: 16, removed: 0, failed: liveIds.length });
  assert.equal((await h.list({ status: 'all' })).total, 0);
  h.lardiDown = false;
  const n = h.throws().length;
  await h.engine().staleCheck();
  assert.deepEqual(h.throws().slice(n).flatMap((c) => c.body.cargoIds).sort(), liveIds);
});

test('staleCheck: чорний список сам догоняє заявки, чий замовник з’явився пізніше — з рядком журналу, зняття з Lardi, кожну раз', async () => {
  const { h, liveIds, customerId } = await blackSeenLater();
  const n = h.throws().length;
  await h.engine().staleCheck();
  const own = (await h.list({ customer: customerId, status: 'all' })).items;
  assert.ok(own.every((l) => l.status === 'inactive' && l.inactiveKind === 'blacklist'), 'приховано');
  assert.deepEqual(h.throws().slice(n).flatMap((c) => c.body.cargoIds).sort(), liveIds, 'живі зняті тим самим проходом');
  assert.ok((await logOf(h)).some((m) => /^Чорний список: догнано 16 /.test(m)));
  const m = h.throws().length;
  const lines = (await logOf(h)).length;
  await h.engine().staleCheck();
  assert.equal(h.throws().length, m, 'повторно нічого не знімається');
  const after = await logOf(h); // новіші — спершу
  assert.ok(!after.slice(0, after.length - lines).some((x) => /догнано/.test(x)), 'і не пишеться');
});

test('staleCheck: догін чорного списку обмежений за прохід, кожна заявка — один раз', async () => {
  const { h } = await blackSeenLater();
  const e = h.engine();
  const s = await e.getSettings();
  const sizes = [];
  for (let i = 0; i < 6; i++) sizes.push((await e.catchUpBlack(s, 5)).hidden);
  assert.deepEqual(sizes, [5, 5, 5, 1, 0, 0]);
});

test('секретність: значення сесії немає ні в журналі, ні в settings.get/settings.set/status.get, ні у відповідях і помилках', async () => {
  const h = setup();
  const outs = [];
  h.della = byCookie(LOGGED);
  outs.push(await h.call('della.session.set', { cookie: 'Cookie: ' + COOKIE }));
  outs.push(await h.call('della.session.check', {}));
  await h.engine().runCycle();
  h.della = () => HTML;
  outs.push(await h.call('della.session.check', {}));
  h.clock.t += 61e3;
  await h.engine().poll();
  h.della = () => new Response('bad gateway', { status: 502 });
  outs.push(await h.call('della.session.check', {}));
  // мережева помилка, у тексті якої є кука (так undici пише про невірний заголовок)
  h.della = (url, headers) => { throw new TypeError(`Headers.append: "${headers.Cookie}" is an invalid header value.`); };
  outs.push(await h.call('della.session.check', {}));
  h.clock.t += 61e3;
  await h.engine().poll();
  outs.push(await h.rpc('della.session.set', { cookie: SECRETS[1] }));
  outs.push(await h.call('settings.set', { della: { pollSeconds: 90, session: 'PHPSESSID=evil' } }));
  outs.push(await h.call('settings.get'), await h.call('status.get'), await h.call('log.list', { limit: 2000 }));
  outs.forEach((o, i) => noSecret(o, `вивід #${i}`));
  assert.ok(outs[3].message.includes('502'));
  // settings.set сесію не міняє: збір і далі з тією самою кукою
  h.della = null;
  h.calls.della.length = 0;
  h.clock.t += 120e3;
  await h.engine().poll();
  assert.ok(h.calls.della.length > 0 && h.calls.della.every((c) => c.headers.Cookie === COOKIE));
});

// ---------- R03: ключ замовника — телефон АБО назва компанії, кожного досить ----------

test('ключ за назвою: ТОВ/ФОП, лапки, регістр, апостроф — одна назва; загальні й короткі назви ключем не стають', async () => {
  const k = (company) => customerKeys({ company });
  for (const v of ['ТОВ «Мар’яна-Транс»', 'тов "МАР\'ЯНА-ТРАНС"', 'Марʼяна-Транс, ТзОВ', 'мар`яна-транс']) assert.deepEqual(k(v), ["name:мар'яна транс"], v);
  assert.deepEqual(k('ФОП Коваль'), ['name:коваль']);
  assert.deepEqual(k('Коваль, фоп'), ['name:коваль']);
  for (const weak of ['ФОП', 'ТОВ', 'Приватна особа', 'Абв', 'ТОВ «Абв»', '']) assert.deepEqual(k(weak), [], `«${weak}» — не ключ`);
  const h = setup();
  for (const weak of ['ФОП', 'Приватна особа']) {
    const r = await h.rpc('customers.add', { list: 'black', text: weak });
    assert.equal(r.ok, false, weak);
    assert.match(r.error, /назву компанії \(від 4 літер\)/);
  }
  const pv = await h.call('customers.preview', { text: 'Мар’яна-Транс' });
  assert.deepEqual(pv.keys, ["name:мар'яна транс"]);
  assert.equal(pv.weak, true, 'лише назва — попередження про можливий збіг');
});

for (const [kind, text, page] of [['телефон', '067 111 22 33', PHONE_ONLY], ['назва компанії', "мар'яна-транс", NAME_ONLY]]) {
  test(`R03, ${kind}: новий збір — заявки чорного замовника відкинуто фільтром, на Lardi нічого`, async () => {
    const h = setup();
    await live(h);
    await h.call('customers.add', { list: 'black', text });
    h.della = byCookie(page);
    await h.call('della.session.set', { cookie: COOKIE });
    const [p] = (await parseDellaSearchWithIds(page, { now: NOW })).filter((x) => x.price >= 8000);
    const e = h.engine();
    const black = await e.store.keysOfList('black');
    assert.deepEqual(e.filterVerdict(p, (await e.getSettings()).filters, (x) => customerKeys(x).some((key) => black.has(key))),
      { pass: false, reason: 'чорний список' }, 'відмова саме у filterVerdict');
    await e.runCycle();
    assert.equal((await h.call('status.get')).custCoverage.total, 0, 'жодної не збережено');
    assert.equal(h.posts().length, 0, 'на Lardi нічого');
    assert.ok((await logOf(h)).some((m) => /чорний список: 16/.test(m)));
  });

  test(`R03, ${kind}: зібрані раніше без замовника — догін ховає й знімає з Lardi, як і за телефоном`, async () => {
    const { h, liveIds, customerId } = await blackSeenLater(text, page);
    const n = h.throws().length;
    await h.engine().staleCheck();
    const own = (await h.list({ customer: customerId, status: 'all' })).items;
    assert.equal(own.length, 16);
    assert.ok(own.every((l) => l.status === 'inactive' && l.inactiveKind === 'blacklist'));
    assert.deepEqual(h.throws().slice(n).flatMap((c) => c.body.cargoIds).sort(), liveIds);
    assert.equal((await h.list({ status: 'all' })).total, 0);
  });
}

// ---------- що саме дає сесія: sample.has і одне речення для клієнтки ----------

test('della.session.check: sample.has — телефон / назва / код / ЄДРПОУ так чи ні, і що з цим робити', async () => {
  const h = setup();
  const check = async (page) => { h.della = byCookie(page); return h.call('della.session.check', {}); };
  await h.call('della.session.set', { cookie: COOKIE });

  const name = await check(NAME_ONLY);
  assert.equal(name.state, 'alive');
  assert.deepEqual(Object.keys(name.sample).sort(), ['company', 'dellaCompanyId', 'edrpou', 'has', 'phone']);
  assert.deepEqual(name.sample.has, { phone: false, company: true, dellaCompanyId: false, edrpou: false });
  assert.equal(name.sample.phone, null);
  assert.match(name.message, /^Вхід працює, але Della дає лише назву компанії — блокуйте за назвою, телефон у картці не видно/);

  // код і назва там, де їх бере JS Della («сховати компанію»): #hide_request_or_company_hidden_<request_code>
  const hid = await check(asLoggedIn(withHiddenCompanies(HTML, () => ({ code: 'G7', name: 'ТОВ «Гамма»' }))));
  assert.deepEqual(hid.sample.has, { phone: false, company: true, dellaCompanyId: true, edrpou: false });
  assert.equal(hid.sample.dellaCompanyId, 'G7');
  assert.match(hid.message, /^Вхід працює, але Della дає лише назву компанії і код компанії Della — блокуйте за назвою/);

  const phone = await check(PHONE_ONLY);
  assert.deepEqual(phone.sample.has, { phone: true, company: false, dellaCompanyId: false, edrpou: false });
  assert.match(phone.message, /^Вхід працює: Della дає телефон, але не назву компанії — блокуйте за телефоном/);

  const log = await logOf(h);
  assert.equal(log.filter((m) => /^Della: у картках немає телефону/.test(m)).length, 1, 'попередження про телефон — раз');
});

test('остання картка сторінки не забирає собі низ сторінки: чужі data-company-* і телефони після списку', () => {
  const page = withHiddenCompanies(HTML, (i) => (i === 0 ? { code: 'Z9', name: 'ТОВ «Чужа»' } : null))
    .replace('class="footer', 'data-company-code="Q1" data-company-name="Della" class="footer')
    .replace('</body>', '<div>Підтримка: +38 (044) 000-00-00</div></body>');
  const cards = parseDellaSearch(page, { now: NOW });
  assert.equal(cards.length, 25);
  assert.equal(cards[0].dellaCompanyId, 'Z9', 'перша — за своїм request_code');
  assert.deepEqual(customerKeys(cards[24]), [], 'остання — без замовника');
  assert.equal(cards[24].price > 0, true, 'і далі розбирається повністю');
});

// ---------- телефон за «Докладніше»: /ajax_private_list_card.php ----------

const CONTACTS_PAGE = asLoggedIn(withContactsCall(withCustomers(HTML, () => ({ name: 'ТОВ «Мар’яна-Транс»' }))));
const posts = (h) => h.calls.della.filter((c) => c.method === 'POST');
const contactsDella = (answer) => (url, headers, init) => {
  if (init.method !== 'POST') return headers.Cookie === COOKIE ? CONTACTS_PAGE : HTML;
  return new Response(JSON.stringify(typeof answer === 'function' ? answer(init) : answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const PHONE_MODULE = { contact_modules: { contacts_block: '<a href="tel:+380507654321">+38 (050) 765-43-21</a>' } };

test('контакти: виклик companyDrawContacts у картці → поля запиту як у JS Della; відповіді Della — телефон або відмова', () => {
  assert.deepEqual(parseJsArgs("['a','b'], 'x\\'y', 1, !0, null, -2.5"), [['a', 'b'], "x'y", 1, true, null, -2.5]);
  assert.equal(parseJsArgs('foo(1)'), null, 'вираз — не вгадуємо');
  const calls = contactsCalls(CONTACTS_PAGE);
  assert.equal(calls.size, 25);
  const [rid, call] = [...calls][0];
  assert.deepEqual(call, { modes: ['phones', 'emails'], em: 'em1', from_search: 1, is_in_list: 0, ne_cfp: 0, ne_e: 0, ne_is: 0, c_c: 'G7', r_c: call.r_c, r_l: 'l25', ri: 3 });
  assert.ok(call.r_c.startsWith(rid));
  const body = new URLSearchParams(contactsBody(call));
  assert.deepEqual(body.getAll('modes[]'), ['phones', 'emails']);
  assert.equal(body.get('token'), '', 'токена капчі сервер не має');
  assert.equal(body.get('r_c'), call.r_c);
  assert.deepEqual(contactsCalls(HTML).size, 0, 'анонімно викликів немає');
  assert.deepEqual(parseDellaContacts(PHONE_MODULE), { phone: '+38 (050) 765-43-21' });
  assert.deepEqual(parseDellaContacts({ error: 1 }), { refused: 'captcha' });
  assert.deepEqual(parseDellaContacts({ contact_error_alert: 1, error_desc: '<b>Обмеження доступу до інформації</b>' }), { refused: 'access', desc: 'Обмеження доступу до інформації' });
  assert.deepEqual(parseDellaContacts(null), { refused: 'format' });
});

test('контакти: за замовчуванням вимкнено — жодного запиту, навіть якщо в картках є кнопка', async () => {
  const h = setup();
  h.della = contactsDella(PHONE_MODULE);
  await h.call('della.session.set', { cookie: COOKIE });
  assert.equal((await h.call('settings.get')).della.contacts, false);
  await h.engine().runCycle();
  assert.ok((await h.list({ status: 'all' })).total > 0);
  assert.equal(posts(h).length, 0);
});

test('контакти: увімкнено — один запит на НОВУ заявку, не більше 10 за збір, з сесією; чорний за телефоном — одразу прихований, у чергу не стає', async () => {
  const h = setup();
  await live(h);
  h.della = contactsDella(PHONE_MODULE);
  await h.call('della.session.set', { cookie: COOKIE });
  await h.call('settings.set', { della: { contacts: true } });
  await h.call('customers.add', { list: 'black', text: '050 765 43 21' });
  await h.engine().poll(); // лише збір: ховає сам, не чекаючи догону в staleCheck
  assert.equal(posts(h).length, CONTACTS_PER_POLL);
  assert.ok(posts(h).every((c) => c.url === 'https://della.com.ua/ajax_private_list_card.php' && c.headers.Cookie === COOKIE));
  const asked = posts(h).map((c) => new URLSearchParams(c.body).get('r_c'));
  assert.equal(new Set(asked).size, CONTACTS_PER_POLL, 'кожна заявка — один раз');
  const cl = (await h.call('customers.list', { list: 'black' })).items[0];
  assert.equal(cl.loads, CONTACTS_PER_POLL, 'телефон із «Докладніше» спрацював ключем');
  const own = (await h.list({ customer: cl.id, status: 'all' })).items;
  assert.ok(own.every((l) => l.status === 'inactive' && l.inactiveKind === 'blacklist' && !l.lardi.length), 'приховані одразу');
  assert.equal((await h.list({ status: 'queued' })).total, 16 - CONTACTS_PER_POLL, 'у черзі лише решта');
  await h.engine().publishTick(h.clock.t + 25e3);
  assert.ok(h.posts().length > 0, 'решта публікується');
  assert.ok((await h.list({ customer: cl.id, status: 'all' })).items.every((l) => !l.lardi.length), 'чорні на Lardi не потрапили');
  assert.ok((await logOf(h)).includes('Della: телефон за «Докладніше» отримано — чорний список за телефоном працює'));
  // ті самі картки ще раз — заявки вже не нові: жодного запиту
  h.clock.t += 61e3;
  await h.engine().poll();
  assert.equal(posts(h).length, CONTACTS_PER_POLL);
});

test('контакти: заявці з телефоном у картці не питаємо', async () => {
  const h = setup();
  const phoned = asLoggedIn(withContactsCall(withCustomers(HTML, () => ({ phone: '+38 (067) 111-22-33' }))));
  h.della = (url, headers, init) => (init.method === 'POST' ? new Response(JSON.stringify(PHONE_MODULE)) : phoned);
  await h.call('della.session.set', { cookie: COOKIE });
  await h.call('settings.set', { della: { contacts: true } });
  await h.engine().poll();
  assert.ok((await h.list({ status: 'all' })).total > 0);
  assert.equal(posts(h).length, 0);
});

test('контакти: перша відмова Della (капча) — запити для цієї сесії зупинено, один рядок журналу; check каже чесно; нова сесія — знову один', async () => {
  const h = setup();
  h.della = contactsDella({ error: 1 });
  await h.call('della.session.set', { cookie: COOKIE });
  await h.call('settings.set', { della: { contacts: true } });
  await h.engine().poll();
  assert.equal(posts(h).length, 1, 'одна спроба — і досить');
  // нові заявки наступного збору (інший вантаж — інші id) — однаково без запитів
  const next = CONTACTS_PAGE.replace(/class="cargo_type">/g, 'class="cargo_type">Б ');
  h.della = (url, headers, init) => (init.method === 'POST' ? contactsDella({ error: 1 })(url, headers, init) : next);
  h.clock.t += 61e3;
  await h.engine().poll();
  assert.ok((await h.call('status.get')).custCoverage.total >= 32, 'нові заявки є');
  assert.equal(posts(h).length, 1);
  const log = await logOf(h);
  assert.equal(log.filter((m) => /^Della: телефон за «Докладніше» не віддала \(Della вимагає капчу з браузера\)/.test(m)).length, 1);
  h.della = contactsDella({ error: 1 });
  const r = await h.call('della.session.check', {});
  assert.match(r.message, /телефон у картці не видно, а за «Докладніше» Della його серверу не віддає \(потрібні капча й верифікація\)/);

  // нова сесія — Della питаємо знову (раз), відмова «доступу» — з її власним текстом
  const COOKIE2 = 'PHPSESSID=n3wS3ss10nVal';
  h.della = (url, headers, init) => {
    if (init.method === 'POST') return new Response(JSON.stringify({ contact_error_alert: 1, error_desc: 'Обмеження доступу до інформації' }));
    return headers.Cookie === COOKIE2 ? next.replace(/class="cargo_type">Б /g, 'class="cargo_type">В ') : HTML;
  };
  await h.call('della.session.set', { cookie: COOKIE2 });
  h.clock.t += 61e3;
  await h.engine().poll();
  assert.equal(posts(h).length, 2);
  assert.ok((await logOf(h)).some((m) => /не віддала \(«Обмеження доступу до інформації» — потрібна верифікація акаунта\)/.test(m)));
});

test('контакти: мережева помилка з кукою в тексті — у журналі куки немає, повторів у тому ж зборі немає', async () => {
  const h = setup();
  h.della = (url, headers, init) => {
    if (init.method === 'POST') throw new TypeError(`fetch failed: Cookie "${headers.Cookie}" rejected`);
    return headers.Cookie === COOKIE ? CONTACTS_PAGE : HTML;
  };
  await h.call('della.session.set', { cookie: COOKIE });
  await h.call('settings.set', { della: { contacts: true } });
  await h.engine().poll();
  assert.equal(posts(h).length, 1);
  const log = await h.call('log.list', { limit: 2000 });
  noSecret(log, 'журнал');
  assert.ok(log.some((x) => /^Della: телефон за «Докладніше» не віддала \(помилка запиту: Della: fetch failed/.test(x.msg)), log.map((x) => x.msg).join('\n'));
});

// ---------- за звітом тестувальника (reports/della-session.md @ 5520e1b) ----------

test('S2: RPC не викликає успадковані методи Object.prototype — ні рушія, ні DELLA_COOKIE, ні ADMIN_KEY у відповіді', async () => {
  const h = setup({ env: { DELLA_COOKIE: COOKIE } });
  for (const m of ['valueOf', 'toString', 'constructor', 'hasOwnProperty', 'isPrototypeOf', '__proto__', 'toLocaleString', '__defineGetter__']) {
    const r = await h.rpc(m, {});
    assert.equal(r.ok, false, m);
    assert.match(r.error, /невідомий метод/, m);
    noSecret(r, m);
    assert.ok(!JSON.stringify(r).includes('secret-admin-key'), `${m}: ADMIN_KEY`);
  }
  assert.equal((await h.rpc('ping', {})).ok, true);
});

test('C1: HTTP-відмова Della на запит контактів (403/429/5xx, мережа) — теж відмова: сесія більше не питає, рядок журналу один', async () => {
  for (const answer of [() => new Response('Forbidden', { status: 403 }), () => new Response('slow down', { status: 429 }), () => { throw new TypeError('fetch failed'); }]) {
    const h = setup();
    let page = CONTACTS_PAGE;
    h.della = (url, headers, init) => (init.method === 'POST' ? answer() : headers.Cookie === COOKIE ? page : HTML);
    await h.call('della.session.set', { cookie: COOKIE });
    await h.call('settings.set', { della: { contacts: true } });
    for (let i = 0; i < 5; i++) {
      page = CONTACTS_PAGE.replace(/class="cargo_type">/g, `class="cargo_type">${i} `); // щоразу нові заявки
      h.clock.t += 61e3;
      await h.engine().poll();
    }
    assert.equal(posts(h).length, 1, 'одна спроба на сесію');
    const lines = (await logOf(h)).filter((m) => /^Della: (контакти|телефон за «Докладніше»)/.test(m));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /запити контактів для цієї сесії зупинено/);
  }
});

test('K7: заявка, яку клієнтка редагувала, однаково отримує замовника з Della — чорний список її ховає й знімає з Lardi', async () => {
  const h = setup();
  await live(h);
  await h.engine().runCycle();
  const all = (await h.list({ status: 'all' })).items;
  const edited = all.filter((l) => l.lardi.some((e) => e.status === 'published')).slice(0, 3);
  assert.ok(edited.length > 0);
  for (const l of edited) {
    await h.call('loads.update', { id: l.id, patch: { price: l.price + 500 } });
    await h.call('loads.update', { id: l.id, patch: { comment: 'дзвонила, домовились' } });
  }
  // правку клієнтки Della не перезаписує, а вписаний нею телефон — не чіпає
  const own = all.find((l) => !edited.includes(l));
  await h.call('loads.update', { id: own.id, patch: { phone: '0441234567' } });
  await h.call('customers.add', { list: 'black', text: '067 111 22 33' });
  h.della = byCookie(LOGGED);
  await h.call('della.session.set', { cookie: COOKIE });
  h.clock.t += 61e3;
  await h.engine().poll();
  await h.engine().staleCheck();
  const after = await h.engine().store.getMany(all.map((l) => l.id));
  for (const l of edited) {
    const x = after.get(l.id);
    assert.equal(x.price, l.price + 500, 'правка лишилась');
    assert.equal(x.comment, 'дзвонила, домовились', 'коментар лишився');
    assert.equal(x.edited, true);
    assert.equal(x.inactiveKind, 'blacklist');
    assert.ok(x.lardi.every((e) => e.status !== 'published'), 'знято з Lardi');
  }
  assert.equal(after.get(own.id).phone, '0441234567', 'вписаний телефон не перезаписано');
  assert.equal(after.get(own.id).company, 'ТОВ «Альфа»', 'а відсутнє — дописано');
});

test('H6: стерти сесію з адмінки, коли є DELLA_COOKIE, — відповідь і журнал кажуть правду: вхід іде далі із запасної', async () => {
  const h = setup({ env: { DELLA_COOKIE: 'env_sess=E1E1E1E1E1' } });
  h.della = (url, headers) => (headers.Cookie === 'env_sess=E1E1E1E1E1' ? LOGGED : HTML);
  await h.call('della.session.set', { cookie: COOKIE });
  const r = await h.call('della.session.set', { cookie: '' });
  assert.deepEqual(r, { state: 'alive' }, 'стан запасної сесії, перевірений одразу');
  const log = await logOf(h);
  assert.ok(log.some((m) => /^Della: сесію з адмінки видалено — далі вхід із запасної DELLA_COOKIE/.test(m)), log.join('\n'));
  assert.ok(!log.some((m) => /збір іде без входу/.test(m)));
  assert.equal((await h.call('status.get')).della.session, 'alive');
  const sg = await h.call('settings.get');
  assert.equal(sg.della.session.set, false, 'в адмінці сесії немає');
  assert.equal(sg.della.session.state, 'alive');
});

test('H1: один телефон у тексті однієї картки — не «вхід працює»: alive лише коли замовника видно в більшості карток', async () => {
  const one = asLoggedIn(HTML.replace('двері металеві', 'двері металеві, дзвоніть +380671112233'));
  const h = setup();
  h.della = byCookie(one);
  await h.call('della.session.set', { cookie: COOKIE });
  const r = await h.call('della.session.check', {});
  assert.equal(r.state, 'blind');
  assert.equal(r.sample, null);
  assert.match(r.message, /лише в 1 з 25 карток/);
  h.clock.t += 61e3;
  await h.engine().poll();
  assert.equal((await h.call('status.get')).della.session, 'blind', 'збір судить так само');
  // більшість карток — так
  h.della = byCookie(asLoggedIn(withCustomers(HTML, (i) => (i % 2 ? null : ALFA))));
  const ok = await h.call('della.session.check', {});
  assert.equal(ok.state, 'alive');
  assert.match(ok.message, /\(замовника видно в 13 з 25 карток/);
});

test('H2: зникли маркери кінця списку — остання картка однаково не забирає низ сторінки', () => {
  let page = HTML;
  for (const k of ['is_subscription_pending', 'id="deny_info"', 'class="pages"', 'class="footer']) page = page.split(k).join('x-gone');
  page = page.replace('</body>', '<div>Підтримка Della: +38 (044) 000-00-00 <span data-company-code="Q1" data-company-name="Della"></span></div></body>');
  const cards = parseDellaSearch(page, { now: NOW });
  assert.equal(cards.length, 25);
  assert.deepEqual(customerKeys(cards[24]), []);
  assert.ok(cards[24].price > 0 && cards[24].toCity, 'остання картка розібрана повністю');
});

test('K2: назва — дефіс і пробіл, будь-який апостроф, латинські ТОВ, повна форма «Товариство з обмеженою відповідальністю» — один ключ', () => {
  const k = (company) => customerKeys({ company });
  const one = (xs) => { const ks = xs.map((x) => JSON.stringify(k(x))); assert.equal(new Set(ks).size, 1, xs.join(' | ') + ' → ' + ks.join(' | ')); assert.notEqual(ks[0], '[]'); };
  one(['Логістик Плюс', 'Логістик-Плюс', 'ТОВ «Логістик – Плюс»']);
  one(['Мар’яна', 'Мар‘яна', 'Марʹяна', "Мар'яна", 'Марʼяна', 'Мар`яна']);
  one(['TOB Альфа Транс', 'ТОВ Альфа Транс', 'TOВ «Альфа Транс»', 'Товариство з обмеженою відповідальністю «Альфа Транс»', 'Альфа-Транс, LLC']);
  one(['ФОП Коваль Петро', 'Фізична особа-підприємець Коваль Петро', 'Коваль Петро ФОП']);
  assert.deepEqual(k('Товариство з обмеженою відповідальністю'), [], 'сама форма — не ключ');
  assert.deepEqual(k('Транс'), ['name:транс']);
  assert.notDeepEqual(k('Транс'), k('Транс Логістик Груп'), 'і далі лише повний збіг');
});

test('K2: міграція — збережені раніше ключі за назвою переходять на нове написання, заявки знову збігаються; повторно — нічого', async () => {
  const h = setup();
  await h.engine().runCycle();
  const st = h.engine().store;
  // як було до виправлення: ключ із дефісом, заявка з тією ж назвою
  const { customer } = await st.upsertCustomer('black', ['name:логістик-плюс'], { label: 'Логістик-Плюс' });
  const [l] = (await h.list({ status: 'all' })).items;
  await h.env.DB.prepare("UPDATE loads SET custKeys = '|name:логістик-плюс|', data = json_set(data, '$.company', 'ТОВ «Логістик-Плюс»') WHERE id = ?").bind(l.id).run();
  await h.env.DB.prepare("DELETE FROM settings WHERE k = 'meta:nameKeysV'").run();
  await st.migrate(); // як під час старту сервера
  assert.deepEqual((await st.getCustomer(customer.id)).keys, ['name:логістик плюс']);
  assert.equal((await st.loadsByKeys(['name:логістик плюс'])).length, 1, 'заявка знову належить замовнику');
  assert.equal(await st.migrateNameKeys(), null, 'повторно — нічого (позначка версії)');
  await h.env.DB.prepare("DELETE FROM settings WHERE k = 'meta:nameKeysV'").run();
  assert.equal((await st.migrateNameKeys()).changed, 0, 'і без позначки — уже нема чого міняти');
});

test('status-della-has: status.get.della — has, phoneSeen і частка карток з останньої перевірки чи збору, без запиту до Della', async () => {
  const h = setup();
  assert.deepEqual((await h.call('status.get')).della, { session: 'none', checkedAt: null, customerSeen: false, has: null, phoneSeen: null, cards: null });
  h.della = byCookie(NAME_ONLY);
  await h.call('della.session.set', { cookie: COOKIE });
  const n = h.calls.della.length;
  assert.deepEqual((await h.call('status.get')).della, {
    session: 'alive', checkedAt: T0, customerSeen: true,
    has: { phone: false, company: true, dellaCompanyId: false, edrpou: false }, phoneSeen: false, cards: { withCustomer: 25, total: 25 },
  });
  assert.equal(h.calls.della.length, n, 'status.get на Della не ходить');
  // збір (3 сторінки) пише те саме
  h.della = byCookie(LOGGED);
  h.clock.t += 61e3;
  await h.engine().poll();
  const d = (await h.call('status.get')).della;
  assert.deepEqual(d.has, { phone: true, company: true, dellaCompanyId: true, edrpou: true });
  assert.equal(d.phoneSeen, true);
  assert.deepEqual(d.cards, { withCustomer: 75, total: 75 });
  // вхід зник — про картки нічого не відомо
  h.della = () => HTML;
  h.clock.t += 61e3;
  await h.engine().poll();
  assert.deepEqual((await h.call('status.get')).della, { session: 'expired', checkedAt: h.clock.t, customerSeen: false, has: null, phoneSeen: null, cards: null });
  // і check віддає частку в самій відповіді
  h.della = () => BLIND;
  assert.deepEqual((await h.call('della.session.check', {})).cards, { withCustomer: 0, total: 25 });
  assert.equal((await h.call('della.session.check', {})).state, 'blind');
});
