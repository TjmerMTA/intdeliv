// QA (tester) — hostile checks for story della-session at 5520e1b. Not part of the release suite
// (tests/*.test.mjs); run with: node --test tests/qa/della-session.qa.mjs
// Each test is one claim of the piece; a failing test = a finding in reports/della-session.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerKeys, normCompany } from '../../extension/lib/model.js';
import { CONTACTS_PER_POLL, scrubSecret } from '../../worker/src/engine.js';
import { setup, live, HTML } from '../helpers/harness.mjs';
import { asLoggedIn, withCustomers, withContactsCall } from '../helpers/della-fixtures.mjs';

const MARK = ['QAmark1Sess9xZ', 'QAmark2Auth7pL', 'QAmark3Remb5kQ'];
const COOKIE = `PHPSESSID=${MARK[0]}; della_auth=${MARK[1]}; remember=${MARK[2]}; lang=uk`;
const LOGGED = asLoggedIn(withCustomers(HTML, () => ({ code: 'A1', name: 'ТОВ «Альфа»', phone: '+38 (067) 111-22-33' })));
const BLIND = asLoggedIn(HTML);
const leaks = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return MARK.filter((m) => s.includes(m)); };
const logOf = async (h) => (await h.call('log.list', { limit: 2000 })).map((x) => x.msg);
const posts = (h) => h.calls.della.filter((c) => c.method === 'POST');

/** Capture everything the engine writes to the console while fn runs. */
async function captureConsole(fn) {
  const out = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => out.push(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  try { await fn(); } finally { Object.assign(console, orig); }
  return out.join('\n');
}

// ---------------------------------------------------------------- 1. secrecy

test('S1 marker cookie: every RPC answer, every log line, console, errors — no marker', async () => {
  const h = setup();
  await live(h);
  const outs = [];
  const con = await captureConsole(async () => {
    h.della = (url, headers) => (headers.Cookie === COOKIE ? LOGGED : HTML);
    outs.push(await h.rpc('della.session.set', { cookie: `Cookie: ${COOKIE}` }));
    outs.push(await h.rpc('della.session.check', {}));
    await h.engine().runCycle({ forcePoll: true });
    await h.engine().staleCheck();
    // every state
    for (const page of [BLIND, HTML, '<html>captcha</html>']) {
      h.della = () => page; outs.push(await h.rpc('della.session.check', {}));
      h.clock.t += 61e3; await h.engine().poll();
    }
    h.della = () => new Response('nope', { status: 403 }); outs.push(await h.rpc('della.session.check', {}));
    h.della = (u, hd) => { throw new TypeError(`Headers.append: "${hd.Cookie}" is an invalid header value.`); };
    outs.push(await h.rpc('della.session.check', {}));
    h.clock.t += 61e3; await h.engine().poll();
    h.della = (u, hd) => { const e = new Error('socket hang up'); e.cause = { header: hd.Cookie }; e.stack = `Error: ${hd.Cookie}\n at x`; throw e; };
    outs.push(await h.rpc('della.session.check', {}));
    h.clock.t += 61e3; await h.engine().poll();
    // contacts path errors
    h.della = (u, hd, init) => { if (init.method === 'POST') throw new Error(`POST failed with ${hd.Cookie}`); return asLoggedIn(withContactsCall(HTML)); };
    await h.call('settings.set', { della: { contacts: true } });
    h.clock.t += 61e3; await h.engine().poll();
    // bad inputs echo?
    for (const bad of [MARK[0], `${MARK[0]}\u0001x=1`, `x=${MARK[0]}`.repeat(1000), { a: MARK[0] }, [MARK[0]]]) outs.push(await h.rpc('della.session.set', { cookie: bad }));
    outs.push(await h.rpc('settings.set', { della: { session: COOKIE, cookie: COOKIE } }));
    // every other handler
    for (const [m, p] of [['ping', {}], ['settings.get', {}], ['status.get', {}], ['loads.list', { limit: 5000, status: 'all' }],
      ['customers.list', {}], ['customers.preview', { text: '067 111 22 33' }], ['customers.reapply', {}], ['lardi.accounts', {}],
      ['log.list', { limit: 2000 }], ['sync.now', {}], ['no.such', {}]]) outs.push(await h.rpc(m, p));
    await h.settle();
  });
  // restore a valid session (set above with bad values may have failed) and re-dump
  outs.push(await h.rpc('settings.get', {}), await h.rpc('status.get', {}));
  const found = outs.map((o, i) => [i, leaks(o)]).filter(([, l]) => l.length);
  assert.deepEqual(found, [], 'marker in RPC answers');
  assert.deepEqual(leaks(await logOf(h)), [], 'marker in log.list');
  assert.deepEqual(leaks(con), [], 'marker in console output');
  // the session is still the marker one (bad sets did not wipe it silently)
  h.calls.della.length = 0; h.della = null; h.clock.t += 61e3; await h.engine().poll();
  assert.ok(h.calls.della.some((c) => c.headers.Cookie === COOKIE), 'session still in use after rejected inputs');
});

test('S2 RPC method names from Object.prototype must not dump the engine (env.DELLA_COOKIE, ADMIN_KEY)', async () => {
  const h = setup({ env: { DELLA_COOKIE: COOKIE } });
  const r = await h.rpc('valueOf', {});
  assert.deepEqual(leaks(r), [], `valueOf answered ok=${r.ok} and carries the env session`);
});

test('S3 scrubSecret: short cookie values are not scrubbed (documented) — what is the threshold in practice', () => {
  const c = 'sid=abc1234; tok=LongEnoughValue';
  const m = scrubSecret(`x ${c} y abc1234 LongEnoughValue`, c);
  assert.ok(!m.includes('LongEnoughValue'));
  // record behaviour, not a requirement: 7-char values survive
  assert.ok(m.includes('abc1234'), 'short values pass through (documented in code)');
});

test('S4 cron error path (worker.scheduled → console.error) does not print the cookie', async () => {
  const h = setup();
  h.della = (u, hd) => (hd.Cookie === COOKIE ? LOGGED : HTML);
  await h.call('della.session.set', { cookie: COOKIE });
  const e = h.engine();
  e.store.upsertSeen = async () => { throw new Error(`db exploded near ${COOKIE}`); };
  const con = await captureConsole(async () => { h.clock.t += 61e3; await e.runCycle({ forcePoll: true }); });
  assert.deepEqual(leaks(con), [], con);
  assert.deepEqual(leaks(await logOf(h)), []);
});

// ---------------------------------------------------------------- 2. R03 keys and name edges

const nk = (s) => customerKeys({ company: s }).find((k) => k.startsWith('name:')) || '';
test('K1 name normalisation: same company in different spellings → same key', () => {
  const groups = [
    ['ТОВ «Мар’яна-Транс»', 'Марʼяна-Транс ТОВ', "мар'яна-транс", 'МАР`ЯНА-ТРАНС, тов', '  Мар’яна-Транс  '],
    ['LLC Alpha Trans', 'Alpha Trans LLC', 'alpha  trans', 'Alpha Trans, Ltd.'],
    ['ООО «Ромашка»', 'Ромашка ООО', 'ромашка'],
    ['ФОП Коваль', 'Коваль ФОП', 'фоп  КОВАЛЬ'],
  ];
  for (const g of groups) assert.equal(new Set(g.map(nk)).size, 1, `${g.join(' | ')} → ${g.map(nk).join(' | ')}`);
});
test('K2 name edges that a client will type (left quote ‘, U+02B9, hyphen vs space, NBSP, Latin homoglyph ТОВ)', () => {
  const pairs = [
    ['Мар‘яна-Транс', 'Мар’яна-Транс'], // U+2018
    ['Марʹяна-Транс', 'Мар’яна-Транс'], // U+02B9
    ['Логістик Плюс', 'Логістик-Плюс'],
    ['Альфа Транс', 'Альфа Транс'],
    ['TOB Альфа', 'ТОВ Альфа'], // Latin T,O,B
    ['Товариство з обмеженою відповідальністю «Альфа»', 'ТОВ «Альфа»'],
  ];
  const bad = pairs.filter(([a, b]) => nk(a) !== nk(b)).map(([a, b]) => `${a} → ${nk(a)}  ≠  ${b} → ${nk(b)}`);
  assert.deepEqual(bad, []);
});
test('K3 weak-name guard: 3 letters / legal form / stop words never become a key; add is refused', async () => {
  for (const w of ['ТОВ', 'ФОП', 'Абв', 'LLC', 'ТОВ ФОП', 'Приватна особа', 'частное лицо', 'Логістика', 'ТОВ «Логістика»', 'Замовник', '...']) assert.equal(nk(w), '', w);
  const h = setup();
  for (const w of ['ТОВ', 'Абв', 'Логістика', 'Приватна особа']) {
    const r = await h.rpc('customers.add', { list: 'black', text: w });
    assert.equal(r.ok, false, `${w} accepted as black-list entry`);
  }
});
test('K4 weak-name guard against a frequent generic name: a name key matches only an exact company, never a substring', async () => {
  const h = setup();
  await live(h);
  const page = asLoggedIn(withCustomers(HTML, (i) => ({ name: i % 2 ? 'ТОВ «Транс»' : 'ТОВ «Транс Логістик Груп»' })));
  h.della = (u, hd) => (hd.Cookie === COOKIE ? page : HTML);
  await h.call('della.session.set', { cookie: COOKIE });
  await h.call('customers.add', { list: 'black', text: 'Транс' }); // 5 letters, allowed
  await h.engine().runCycle({ forcePoll: true });
  const all = (await h.list({ status: 'all' })).items;
  const longOnes = all.filter((l) => /Логістик/.test(l.company || ''));
  assert.ok(longOnes.length > 0, '«Транс» must not swallow «Транс Логістик Груп»');
});

async function seenThenBlack({ page, text, edit = false }) {
  const h = setup();
  await live(h);
  await h.engine().runCycle(); // anonymous: published without customer
  const before = (await h.list({ status: 'all' })).items;
  const liveIds = before.flatMap((l) => l.lardi.filter((e) => e.status === 'published').map((e) => e.id));
  assert.ok(liveIds.length > 0);
  if (edit) for (const l of before) await h.call('loads.update', { id: l.id, patch: { price: l.price } });
  const add = await h.call('customers.add', { list: 'black', text });
  h.della = (u, hd) => (hd.Cookie === COOKIE ? page : HTML);
  await h.call('della.session.set', { cookie: COOKIE });
  h.clock.t += 61e3; await h.engine().poll();
  return { h, liveIds, add };
}
for (const [kind, text, card] of [
  ['phone', '+380 67 111 2233', { phone: '+38 (067) 111-22-33' }],
  ['name «ТОВ "Мар\'яна-Транс"» vs card «Марʼяна-Транс, ТзОВ»', 'ТОВ "Мар\'яна-Транс"', { name: 'Марʼяна-Транс, ТзОВ' }],
  ['name LLC', 'alpha trans llc', { name: 'LLC «Alpha Trans»' }],
]) {
  const page = asLoggedIn(withCustomers(HTML, () => card));
  test(`K5 R03 ${kind}: refused at collection`, async () => {
    const h = setup(); await live(h);
    await h.call('customers.add', { list: 'black', text });
    h.della = (u, hd) => (hd.Cookie === COOKIE ? page : HTML);
    await h.call('della.session.set', { cookie: COOKIE });
    await h.engine().runCycle({ forcePoll: true });
    await h.engine().publishTick(h.clock.t + 60e3);
    assert.equal(h.posts().length, 0, 'nothing on Lardi');
    assert.equal((await h.list({ status: 'all' })).total, 0);
  });
  test(`K6 R03 ${kind}: already in DB and on Lardi → catch-up sweep hides + unpublishes, each once`, async () => {
    const { h, liveIds } = await seenThenBlack({ page, text });
    const t0 = h.throws().length;
    await h.engine().staleCheck();
    const thrown = h.throws().slice(t0).flatMap((c) => c.body.cargoIds).sort();
    assert.deepEqual(thrown, [...liveIds].sort());
    assert.equal((await h.list({ status: 'all' })).total, 0);
    h.clock.t += 11 * 60e3; await h.engine().staleCheck();
    assert.equal(h.throws().length, t0 + h.throws().slice(t0).length, 'second pass: nothing new');
    const t1 = h.throws().length; h.clock.t += 11 * 60e3; await h.engine().staleCheck(); assert.equal(h.throws().length, t1);
  });
}
test('K7 a load the client edited (price) still gets the customer and is caught by the black list', async () => {
  const page = asLoggedIn(withCustomers(HTML, () => ({ phone: '+38 (067) 111-22-33' })));
  const { h } = await seenThenBlack({ page, text: '067 111 22 33', edit: true });
  await h.engine().staleCheck();
  assert.equal((await h.list({ status: 'all' })).total, 0, 'edited loads stay visible and published');
});

// ---------------------------------------------------------------- 3. honest states

test('H1 a phone in ONE card (e.g. in the cargo note) on an otherwise blind page → must not be reported as plain "alive / customer visible"', async () => {
  const h = setup();
  let n = -1;
  const page = BLIND.replace(/(<div class="request_card(?:\s[^"]*)?"\s+data-request_id="[^"]*"[^>]*>)/g, (m) => (++n === 0 ? `${m}<div class="cargo_note">дзвоніть +380671112233</div>` : m));
  h.della = (u, hd) => (hd.Cookie === COOKIE ? page : HTML);
  await h.call('della.session.set', { cookie: COOKIE });
  const r = await h.call('della.session.check', {});
  // 1 of ~25 cards: claim must at least carry how many cards had a customer
  assert.ok(r.state !== 'alive' || /\b1\b.*з|з.*\b25\b/.test(r.message), `state=${r.state} message=${r.message}`);
});
test('H2 last-card fallback: footer phone is not the customer when the end-of-list markers are absent', async () => {
  const h = setup();
  let page = BLIND.replace(/is_subscription_pending|id="deny_info"|class="pages"|class="footer/g, 'x');
  page = page.replace('</body>', '<div>Служба підтримки Della: +38 (044) 300-00-00</div></body>');
  h.della = (u, hd) => (hd.Cookie === COOKIE ? page : HTML);
  await h.call('della.session.set', { cookie: COOKIE });
  const r = await h.call('della.session.check', {});
  assert.notEqual(r.state, 'alive', `support phone taken as customer: ${JSON.stringify(r.sample)}`);
});
test('H3 the five states via check: none / alive / blind / expired / error, admin shape', async () => {
  const h = setup();
  const res = {};
  res.none = await h.call('della.session.check', {});
  h.della = (u, hd) => (hd.Cookie === COOKIE ? LOGGED : HTML);
  await h.call('della.session.set', { cookie: COOKIE });
  res.alive = await h.call('della.session.check', {});
  h.della = () => BLIND; res.blind = await h.call('della.session.check', {});
  h.della = () => HTML; res.expired = await h.call('della.session.check', {});
  h.della = () => { throw new Error('ECONNRESET'); }; res.error = await h.call('della.session.check', {});
  for (const [k, v] of Object.entries(res)) {
    assert.equal(v.state, k);
    // + cards {withCustomer, total} — частку карток директор попросив віддавати у відповіді (H1)
    assert.deepEqual(Object.keys(v).sort(), ['cards', 'customerSeen', 'message', 'sample', 'state']);
    assert.equal(v.customerSeen, k === 'alive');
    assert.ok(v.message && v.message.length > 10);
  }
  assert.deepEqual(Object.keys(res.alive.sample.has).sort(), ['company', 'dellaCompanyId', 'edrpou', 'phone']);
  assert.ok(Object.values(res.alive.sample.has).every((b) => typeof b === 'boolean'));
  assert.equal(res.blind.sample, null);
});
test('H4 alive → expired over 20 polls: one log line, state expired, collection continues', async () => {
  const h = setup();
  h.della = (u, hd) => (hd.Cookie === COOKIE ? LOGGED : HTML);
  await h.call('della.session.set', { cookie: COOKIE });
  h.della = () => HTML;
  for (let i = 0; i < 20; i++) { h.clock.t += 61e3; await h.engine().runCycle(); }
  const log = await logOf(h);
  assert.equal(log.filter((m) => /сесія закінчилась/.test(m)).length, 1, log.filter((m) => /Della/.test(m)).join('\n'));
  assert.equal((await h.call('status.get')).della.session, 'expired');
  // admin check in between must not re-log
  await h.call('della.session.check', {}); await h.call('della.session.check', {});
  assert.equal((await logOf(h)).filter((m) => /сесія закінчилась/.test(m)).length, 1);
});
test('H5 network down during polls: state is not silently kept "alive" forever? (record) and no log flood', async () => {
  const h = setup();
  h.della = (u, hd) => (hd.Cookie === COOKIE ? LOGGED : HTML);
  await h.call('della.session.set', { cookie: COOKIE });
  h.della = () => { throw new Error('ENOTFOUND della.com.ua'); };
  for (let i = 0; i < 5; i++) { h.clock.t += 61e3; await h.engine().runCycle(); }
  const st = await h.call('status.get');
  console.log('# H5 state after 5 failed polls:', st.della.session, 'checkedAt age ms', h.clock.t - st.della.checkedAt, 'lastError', st.lastError);
  assert.ok(st.lastError, 'poll errors visible');
});
test('H6 removing the session while DELLA_COOKIE env is set: "removed" must be true (engine stops logging in)', async () => {
  const h = setup({ env: { DELLA_COOKIE: COOKIE } });
  h.della = (u, hd) => (hd.Cookie ? LOGGED : HTML);
  await h.call('della.session.set', { cookie: 'PHPSESSID=OtherSessQA11' });
  const r = await h.call('della.session.set', { cookie: '' });
  h.calls.della.length = 0; h.clock.t += 61e3; await h.engine().poll();
  const used = h.calls.della.filter((c) => c.headers.Cookie).length;
  assert.ok(!(r.state === 'none' && used > 0), `set('') said ${r.state}, then poll sent a Cookie on ${used} requests; status now ${(await h.call('status.get')).della.session}`);
});
test('H7 env DELLA_COOKIE only, never checked: status.get must not say "none" while the engine logs in', async () => {
  const h = setup({ env: { DELLA_COOKIE: COOKIE } });
  const st = await h.call('status.get');
  const set = (await h.call('settings.get')).della.session;
  console.log('# H7 before any poll:', st.della, set);
  h.della = (u, hd) => (hd.Cookie === COOKIE ? LOGGED : HTML);
  await h.engine().poll();
  assert.equal((await h.call('status.get')).della.session, 'alive');
});

// ---------------------------------------------------------------- 4. degradation

test('D1 no session: no Cookie header anywhere, nothing throws, state none, publishing as before', async () => {
  const h = setup(); await live(h);
  const con = await captureConsole(async () => { for (let i = 0; i < 3; i++) { h.clock.t += 61e3; await h.engine().runCycle(); await h.engine().staleCheck(); } });
  assert.ok(h.calls.della.length > 0 && h.calls.della.every((c) => !c.headers.Cookie));
  assert.ok(h.posts().length > 0);
  const st = await h.call('status.get');
  assert.equal(st.della.session, 'none');
  assert.deepEqual(st.custCoverage, { withCustomer: 0, total: st.custCoverage.total });
  assert.ok(!/error|TypeError|Cannot read/i.test((await logOf(h)).join('\n')));
  assert.ok(!/TypeError|Cannot read/.test(con));
  assert.deepEqual(await h.call('customers.reapply', {}), { hidden: 0, removed: 0, failed: 0 });
});

// ---------------------------------------------------------------- 6. scenario 4 and bounds

test('B1 scenario 4: adding a phone hides loads already in the DB (with customer), unpublishes them', async () => {
  const h = setup(); await live(h);
  const page = asLoggedIn(withCustomers(HTML, () => ({ phone: '+38 (067) 111-22-33' })));
  h.della = (u, hd) => (hd.Cookie === COOKIE ? page : HTML);
  await h.call('della.session.set', { cookie: COOKIE });
  await h.engine().runCycle({ forcePoll: true });
  const pubBefore = (await h.list({ status: 'all' })).items.flatMap((l) => l.lardi.filter((e) => e.status === 'published').map((e) => e.id));
  assert.ok(pubBefore.length > 0);
  const t0 = h.throws().length;
  const r = await h.call('customers.add', { list: 'black', text: '0671112233' });
  assert.equal(r.affected.hidden, 16);
  assert.deepEqual(h.throws().slice(t0).flatMap((c) => c.body.cargoIds).sort(), pubBefore.sort());
  assert.equal((await h.list({ status: 'all' })).total, 0);
});
test('B2 catch-up is bounded per pass (SWEEP_LIMIT) and each load handled once', async () => {
  const h = setup();
  const e = h.engine(); await e.ready();
  // 250 loads in DB already carrying a black phone, status new
  const now = h.clock.t;
  const loads = Array.from({ length: 250 }, (_, i) => ({ id: `qa${i}`, source: 'della', status: 'new', fromCity: 'Київ', toCity: 'Львів', dateFrom: '2026-09-23', price: 9000, currency: 'UAH', phone: '+380671112233', seenAt: now, firstSeenAt: now, lardi: [] }));
  await e.store.db.batch(loads.map((l) => e.store.putStmt(l)));
  await e.store.upsertCustomer('black', ['tel:380671112233'], { fallbackLabel: 'qa' });
  const passes = [];
  for (let i = 0; i < 4; i++) passes.push((await h.engine().catchUpBlack(await e.getSettings())).hidden);
  assert.deepEqual(passes, [100, 100, 50, 0]);
});
test('B3 customers.reapply is NOT bounded: one RPC call does every pending load (record size)', async () => {
  const h = setup();
  const e = h.engine(); await e.ready();
  const now = h.clock.t;
  const N = 3000;
  const loads = Array.from({ length: N }, (_, i) => ({ id: `qb${i}`, source: 'della', status: 'published', fromCity: 'Київ', toCity: 'Львів', dateFrom: '2026-09-23', price: 9000, currency: 'UAH', phone: '+380671112233', seenAt: now, firstSeenAt: now, lardi: [{ account: 0, id: 5000 + i, status: 'published' }] }));
  for (let i = 0; i < N; i += 500) await e.store.db.batch(loads.slice(i, i + 500).map((l) => e.store.putStmt(l)));
  await e.store.upsertCustomer('black', ['tel:380671112233'], { fallbackLabel: 'qa' });
  await live(h, [{ name: 'A', token: 'tokAAAA1111', enabled: true }]);
  const t = Date.now();
  const r = await h.call('customers.reapply', {});
  console.log(`# B3 reapply over ${N}: ${JSON.stringify(r)} in ${Date.now() - t} ms, Lardi throw calls ${h.throws().length}`);
  assert.equal(r.hidden, N);
});

// ---------------------------------------------------------------- contacts caps

const CPAGE = (tag) => asLoggedIn(withContactsCall(withCustomers(HTML, () => ({ name: 'ТОВ «Мар’яна-Транс»' })))).replace(/class="cargo_type">/g, `class="cargo_type">${tag} `);
test('C1 contacts: HTTP 403/429 from Della is a refusal → must stop for the whole session (not 1 request every poll)', async () => {
  const h = setup();
  let tag = 0;
  h.della = (u, hd, init) => (init.method === 'POST' ? new Response('Forbidden', { status: 403 }) : CPAGE(`T${tag}`));
  await h.call('della.session.set', { cookie: COOKIE });
  await h.call('settings.set', { della: { contacts: true } });
  for (let i = 0; i < 5; i++) { tag++; h.clock.t += 61e3; await h.engine().poll(); }
  const warns = (await logOf(h)).filter((m) => /контакти не отримано/.test(m)).length;
  assert.equal(posts(h).length, 1, `POSTs after 5 polls with 403: ${posts(h).length}; warn lines: ${warns}`);
});
test('C2 contacts: never more than 10 per poll even with 3 search URLs × 3 pages', async () => {
  const h = setup();
  const urls = ['https://della.com.ua/search/a1b0d0e0f0g0h0i0j0k0m0.html', 'https://della.com.ua/search/a2b0d0e0f0g0h0i0j0k0m0.html', 'https://della.com.ua/search/a3b0d0e0f0g0h0i0j0k0m0.html'];
  await h.call('settings.set', { della: { searchUrls: urls, pagesPerPoll: 3, contacts: true } });
  h.della = (u, hd, init) => (init.method === 'POST' ? new Response(JSON.stringify({ contact_modules: { b: 'немає' } })) : CPAGE(u.slice(-30)));
  await h.call('della.session.set', { cookie: COOKIE });
  h.clock.t += 61e3; await h.engine().poll();
  assert.ok(posts(h).length <= CONTACTS_PER_POLL, `POSTs: ${posts(h).length}`);
});
test('C3 contacts: no retry of a load across polls; parallel RPC sync.now + cron do not double the cap', async () => {
  const h = setup();
  h.della = (u, hd, init) => (init.method === 'POST' ? new Response(JSON.stringify({ contact_modules: { b: 'без телефону' } })) : CPAGE('X'));
  await h.call('della.session.set', { cookie: COOKIE });
  await h.call('settings.set', { della: { contacts: true } });
  await Promise.all([h.engine().runCycle({ forcePoll: true }), h.engine().runCycle({ forcePoll: true }), h.call('sync.now')]);
  await h.settle();
  const n1 = posts(h).length;
  for (let i = 0; i < 3; i++) { h.clock.t += 61e3; await h.engine().runCycle(); }
  const ids = posts(h).map((c) => new URLSearchParams(c.body).get('r_c'));
  assert.ok(n1 <= CONTACTS_PER_POLL, `first minute: ${n1}`);
  assert.equal(new Set(ids).size, ids.length, 'a load asked twice');
});
test('C4 contacts: expired session (Della logged out) → no POST at all', async () => {
  const h = setup();
  h.della = (u, hd, init) => (init.method === 'POST' ? new Response('{}') : withContactsCall(HTML));
  await h.call('della.session.set', { cookie: COOKIE });
  await h.call('settings.set', { della: { contacts: true } });
  h.clock.t += 61e3; await h.engine().poll();
  assert.equal(posts(h).length, 0);
});
test('C5 contacts: answer that is HTML (logged-out page) is a refusal → stops', async () => {
  const h = setup();
  let tag = 0;
  h.della = (u, hd, init) => (init.method === 'POST' ? new Response('<html>login</html>') : CPAGE(`H${tag}`));
  await h.call('della.session.set', { cookie: COOKIE });
  await h.call('settings.set', { della: { contacts: true } });
  for (let i = 0; i < 3; i++) { tag++; h.clock.t += 61e3; await h.engine().poll(); }
  assert.equal(posts(h).length, 1);
});
