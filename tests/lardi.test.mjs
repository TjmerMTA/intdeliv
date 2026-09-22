import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCargoBody, resolveBodyIds, LardiClient, NeedsReviewError } from '../extension/lib/lardi.js';
import { mergeSeen, applyPatch, accountsNeeded, maskToken, isMasked, newLoad } from '../extension/lib/model.js';

const load = {
  id: 'd_x', source: 'della', dateFrom: '2026-09-23', dateTo: '2026-09-25',
  fromCity: 'Київ', fromRegion: 'Київська обл.', toCity: 'Львів', toRegion: 'Львівська обл.',
  cargo: 'запчастини на палетах', body: 'тент', weight: 6.9, volume: 40, price: 20000, currency: 'UAH',
  payment: 'Безнал', tags: ['Довантаження', 'ПДВ', 'Кільк. палет: 8', 'Передоплата: 50%'],
  dims: { length: 13.6, width: 2.45 }, directCustomer: true, status: 'new', lardi: [],
};
const BODY_TYPES = [{ id: 34, name: 'Тент' }, { id: 25, name: 'Ізотерм' }, { id: 27, name: 'Контейнер' }, { id: 29, name: 'Рефрижератор' }];

test('buildCargoBody maps load → Lardi body', () => {
  const b = buildCargoBody(load, {
    bodyIds: [34],
    from: { townId: 137, townName: 'Київ', areaId: 23, countrySign: 'UA' },
    to: { townId: 555, townName: 'Львів', areaId: 12 },
    paymentUnitId: 1,
    note: 'Дзвоніть',
  });
  assert.equal(b.dateFrom, '2026-09-23');
  assert.equal(b.dateTo, '2026-09-25');
  assert.equal(b.contentName, 'запчастини на палетах');
  assert.deepEqual(b.cargoBodyTypeIds, [34]);
  assert.equal(b.sizeMass, 6.9);
  assert.equal(b.sizeVolume, 40);
  assert.equal(b.paymentValue, 20000);
  assert.equal(b.paymentPrice, 20000);
  assert.equal(b.paymentCurrencyId, 2);
  assert.equal(b.paymentUnitId, 1);
  assert.deepEqual(b.paymentForms, [{ id: 4, vat: true }]);
  assert.equal(b.groupage, undefined); // groupage вимагає упаковку й габарити — не ставимо
  assert.equal(b.paymentPrepay, 50);
  assert.equal(b.sizeLength, 13.6);
  assert.deepEqual(b.waypointListSource, [{ countrySign: 'UA', townName: 'Київ', townId: 137, areaId: 23 }]);
  assert.deepEqual(b.waypointListTarget, [{ countrySign: 'UA', townName: 'Львів', townId: 555, areaId: 12 }]);
  assert.match(b.note, /Кільк\. палет: 8/);
  assert.match(b.note, /Дзвоніть/);
});

test('payment mapping and required fields', () => {
  const ctx = { bodyIds: [34], from: { townName: 'A' }, to: { townName: 'B' } };
  assert.deepEqual(buildCargoBody({ ...load, payment: 'Готівка', tags: [] }, ctx).paymentForms, [{ id: 2, vat: false }]);
  assert.deepEqual(buildCargoBody({ ...load, payment: 'Картка', tags: [] }, ctx).paymentForms, [{ id: 10, vat: false }]);
  assert.equal(buildCargoBody({ ...load, payment: undefined }, ctx).paymentForms, undefined);
  assert.equal(buildCargoBody({ ...load, currency: 'USD' }, ctx).paymentCurrencyId, 4);
  assert.throws(() => buildCargoBody({ ...load, price: undefined }, ctx), NeedsReviewError);
  assert.throws(() => buildCargoBody({ ...load, weight: undefined }, ctx), NeedsReviewError);
  assert.throws(() => buildCargoBody(load, { ...ctx, bodyIds: [] }), NeedsReviewError);
});

test('resolveBodyIds: name match, fallback, needs review', () => {
  assert.deepEqual(resolveBodyIds('тент', BODY_TYPES), [34]);
  assert.deepEqual(resolveBodyIds('Рефрижератор', BODY_TYPES), [29]);
  assert.deepEqual(resolveBodyIds('ізотерм', [{ id: 25, name: 'Изотерм' }]), [25]);
  assert.deepEqual(resolveBodyIds('крита', BODY_TYPES), [34, 25]);
  assert.deepEqual(resolveBodyIds('тент', []), [34], 'fallback without reference');
  assert.deepEqual(resolveBodyIds('контейнер', []), [27]);
  assert.throws(() => resolveBodyIds('рефрижератор', []), NeedsReviewError);
  assert.throws(() => resolveBodyIds('щось дивне', BODY_TYPES), NeedsReviewError);
});

function fakeFetch(routes, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const key = `${init.method} ${u.pathname.replace('/v2', '')}`;
    const h = routes[key];
    if (!h) return new Response('{"message":"not found"}', { status: 404 });
    const r = typeof h === 'function' ? h(u, init, calls) : h;
    return new Response(JSON.stringify(r.body ?? r), { status: r.status || 200 });
  };
}

test('LardiClient.addCargo: towns, body types, auth header, 429 retry, cache', async () => {
  const calls = [];
  let hits429 = 0;
  const store = new Map();
  const cache = { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } };
  const routes = {
    'GET /references/towns/by/name': (u) => {
      const q = u.searchParams.get('query');
      return q === 'Київ'
        ? [{ id: 137, name: 'Київ', areaId: 23, countrySign: 'UA' }, { id: 999, name: 'Київська Русь', areaId: 5 }]
        : [{ id: 555, name: 'Львів', areaId: 12, countrySign: 'UA' }];
    },
    'GET /references/body/types': BODY_TYPES,
    'GET /references/payment/units': [{ id: 2, name: 'км' }, { id: 4, name: 'т' }],
    'POST /proposals/my/add/cargo': () => (hits429++ < 1 ? { status: 429, body: {} } : { id: 298243420 }),
  };
  const client = new LardiClient({ token: 'tok123', fetch: fakeFetch(routes, calls), cache, sleep: async () => {} });
  const res = await client.addCargo(load, { lardi: { note: '' } });
  assert.equal(res.id, 298243420);
  assert.equal(hits429, 2, 'retried after 429');
  const post = calls.filter((c) => c.init.method === 'POST').at(-1);
  assert.equal(post.init.headers.Authorization, 'tok123');
  assert.match(post.url, /language=uk/);
  const body = JSON.parse(post.init.body);
  assert.equal(body.waypointListSource[0].townId, 137);
  assert.equal(body.waypointListTarget[0].townId, 555);
  assert.equal(body.paymentUnitId, undefined, 'no «рейс» unit in reference → omitted');
  // второй раз — города и справочники из кэша
  const before = calls.length;
  await client.prepareCargo(load, {});
  assert.equal(calls.length, before, 'all references served from cache');
});

test('LardiClient: unknown town → NeedsReviewError; test() ok/error; throwToBasket body', async () => {
  const calls = [];
  const routes = {
    'GET /references/towns/by/name': [],
    'GET /proposals/my/cargoes/published': { content: [], paginator: { totalSize: 7 } },
    'POST /proposals/my/basket/throw': { result: 'OK' },
  };
  const client = new LardiClient({ token: 't', fetch: fakeFetch(routes, calls), sleep: async () => {} });
  await assert.rejects(() => client.townByName('Нетакемісто'), NeedsReviewError);
  const t = await client.test();
  assert.equal(t.ok, true);
  assert.match(t.name, /7/);
  await client.throwToBasket([11, 22]);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { cargoIds: [11, 22], lorryIds: [] });
  const bad = new LardiClient({ token: 't', fetch: async () => new Response('{"message":"Unauthorized"}', { status: 401 }), sleep: async () => {} });
  const r = await bad.test();
  assert.equal(r.ok, false);
  assert.match(r.error, /401/);
});

test('model: mergeSeen never overwrites fields, only seenAt', () => {
  const l = newLoad({ ...load, price: 20000 }, 1000);
  const edited = { ...applyPatch(l, { price: 25000 }, 2000) };
  assert.equal(edited.edited, true);
  const m = mergeSeen(edited, { ...load, price: 20000 }, 3000);
  assert.equal(m.price, 25000);
  assert.equal(m.seenAt, 3000);
  assert.equal(m.firstSeenAt, 1000);
  const stale = { ...l, status: 'inactive', inactiveKind: 'stale', lardi: [{ account: 0, id: 1, status: 'removed' }] };
  const back = mergeSeen(stale, load, 4000);
  assert.equal(back.status, 'new');
  assert.deepEqual(back.lardi, []);
});

test('model: accountsNeeded both / roundrobin / dry; token mask', () => {
  const s = { lardi: { dryRun: false, mode: 'both', accounts: [{ token: 'a', enabled: true }, { token: 'b', enabled: true }, { token: '', enabled: true }] } };
  assert.deepEqual(accountsNeeded({ lardi: [] }, s), [0, 1]);
  assert.deepEqual(accountsNeeded({ lardi: [{ account: 0, id: 5, status: 'published' }] }, s), [1]);
  const rr = { lardi: { ...s.lardi, mode: 'roundrobin' } };
  assert.deepEqual(accountsNeeded({ lardi: [] }, rr, 1), [1]);
  assert.deepEqual(accountsNeeded({ lardi: [{ account: 1, id: 5, status: 'published' }] }, rr, 0), []);
  const dry = { lardi: { ...s.lardi, dryRun: true } };
  assert.deepEqual(accountsNeeded({ lardi: [] }, dry), [0, 1, 2]);
  assert.deepEqual(accountsNeeded({ lardi: [{ account: 0, status: 'dry' }, { account: 1, status: 'dry' }, { account: 2, status: 'dry' }] }, dry), []);
  // после выключения dry-run dry-записи не считаются публикацией
  assert.deepEqual(accountsNeeded({ lardi: [{ account: 0, status: 'dry' }, { account: 1, status: 'dry' }] }, s), [0, 1]);
  assert.equal(maskToken('abcdef123456'), '••••3456');
  assert.ok(isMasked('••••3456'));
});

test('buildCargoBody: Lardi limits — note ≤ 100, contentName ≤ 50, settings note first', async () => {
  const { buildCargoBody, LIMITS } = await import('../extension/lib/lardi.js');
  const load = { dateFrom: '2026-09-24', price: 35000, weight: 16.3, cargo: 'дуже довга назва вантажу '.repeat(5), currency: 'UAH',
    tags: ['Можл. дозавантаження', 'Зверху', 'Місць вивант.: 2', 'Кільк. палет: 17', 'Швидке вивантаження', 'При розвантаженні', 'Швидка оплата'] };
  const ctx = { bodyIds: [34], from: { townName: 'Буча', townId: 6019 }, to: { townName: 'Ужгород', townId: 194 }, note: 'Тел. 0671234567' };
  const b = buildCargoBody(load, ctx);
  assert.ok(b.note.length <= LIMITS.note, b.note);
  assert.ok(!/0671234567/.test(b.note), 'phone-like settings note dropped: ' + b.note);
  assert.ok((b.note.match(/\d/g) || []).length <= LIMITS.noteDigits, b.note);
  assert.equal(b.groupage, undefined);
  assert.ok(b.contentName.length <= LIMITS.contentName);
});
