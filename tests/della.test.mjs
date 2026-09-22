import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseDellaSearch, parseDellaSearchWithIds, buildPageUrl, parsePrice, parseDateRange, regionFromTitle, inferDate,
} from '../extension/lib/della.js';
import { applyFilters, regionMatches } from '../extension/lib/filters.js';

const html = readFileSync(fileURLToPath(new URL('./fixtures/della-search.html', import.meta.url)), 'utf8');
const URL0 = 'https://della.com.ua/search/a204bd204eflolz1z21z3z4z51z6z7z8z9y1y2y3y4y5y6h0ilk0m1.html';
const NOW = new Date('2026-09-22T10:00:00');

test('parses 25 cards with sane fields', async () => {
  const loads = await parseDellaSearchWithIds(html, { url: URL0, now: NOW });
  assert.equal(loads.length, 25);
  for (const l of loads) {
    assert.equal(l.source, 'della');
    assert.match(l.dateFrom, /^2026-\d\d-\d\d$/);
    assert.ok(l.fromCity && l.toCity, 'cities');
    assert.ok(/обл\.$/.test(l.fromRegion) && /обл\.$/.test(l.toRegion), `regions ${l.fromRegion} / ${l.toRegion}`);
    assert.match(l.fromCityId, /^\d+$/);
    assert.match(l.toCityId, /^\d+$/);
    assert.equal(typeof l.price, 'number');
    assert.ok(l.price >= 500 && l.price <= 200000, `price ${l.price}`);
    assert.equal(l.currency, 'UAH');
    assert.equal(typeof l.weight, 'number');
    assert.ok(l.weight > 0 && l.weight < 40);
    assert.ok(l.cargo.length > 1);
    assert.ok(l.body.length > 1);
    assert.equal(l.directCustomer, true, 'URL with z21 → all direct customers');
    assert.equal(l.dellaUrl, URL0);
    assert.ok(Array.isArray(l.tags));
    assert.match(l.id, /^d_[0-9a-f]{40}$/);
    assert.equal(l.fingerprint.split('|').length, 6);
  }
  assert.equal(new Set(loads.map((l) => l.id)).size, 25, 'ids unique');
});

test('first card details', () => {
  const [l] = parseDellaSearch(html, { url: URL0, now: NOW });
  assert.equal(l.fromCity, 'Київ');
  assert.equal(l.toCity, 'Долинська');
  assert.equal(l.toRegion, 'Кіровоградська обл.');
  assert.equal(l.fromCityId, '208');
  assert.equal(l.toCityId, '5282');
  assert.equal(l.distanceKm, 374);
  assert.equal(l.price, 1000);
  assert.equal(l.pricePerKm, 2.67);
  assert.equal(l.weight, 0.1);
  assert.equal(l.body, 'крита');
  assert.equal(l.cargo, 'двері металеві');
  assert.equal(l.payment, 'Картка');
  assert.deepEqual(l.tags, ['Довантаження', 'При розвантаженні', 'Торг']);
  assert.equal(l.fingerprint, '208|5282|двері металеві|0.1|1000|2026-09-22');
});

test('price with change-arrow tooltip, date ranges, volume, payment, deleted, multi-stop', () => {
  const loads = parseDellaSearch(html, { url: URL0, now: NOW });
  const l1 = loads[1];
  assert.equal(l1.price, 19000, 'tooltip «збільшена на 1000 грн» ignored');
  assert.equal(l1.payment, 'Безнал');
  assert.equal(l1.fromRegion, 'Київська обл.');
  const range = loads.find((l) => l.fromCity === 'Настасів');
  assert.equal(range.dateFrom, '2026-09-22');
  assert.equal(range.dateTo, '2026-09-25');
  assert.equal(range.volume, 22);
  assert.equal(loads[2].volume, 8);
  assert.equal(loads.filter((l) => l.dellaDeleted).length, 1);
  assert.equal(loads.find((l) => l.dellaDeleted).payment, 'Готівка');
  const multi = loads.find((l) => l.fromCity === 'Чернігів' && l.toCity === 'Олександрія');
  assert.ok(multi.tags.includes('Через: Біла Церква'));
  const dims = loads.find((l) => l.fromCity === 'Дніпро' && l.toCity === 'Одеса');
  assert.deepEqual(dims.dims, { length: 13, width: 2.45, height: 2.2 });
  const noDist = loads[24];
  assert.equal(noDist.distanceKm, undefined);
  assert.equal(noDist.price, 21000);
  const payments = new Set(loads.map((l) => l.payment).filter(Boolean));
  for (const p of payments) assert.ok(['Безнал', 'Картка', 'Готівка', 'Будь-яка'].includes(p), p);
  assert.ok(loads.every((l) => typeof l.postedAt === 'number'));
});

test('helpers', () => {
  assert.deepEqual(parsePrice('20<span style="color:#FFFFFF;">&nbsp;</span>000 грн'), { price: 20000, currency: 'UAH' });
  assert.deepEqual(parsePrice('1 200 USD'), { price: 1200, currency: 'USD' });
  assert.deepEqual(parseDateRange(' 22.09&ndash;22.11 ', NOW), { dateFrom: '2026-09-22', dateTo: '2026-11-22' });
  assert.equal(inferDate('05', '01', NOW), '2027-01-05');
  assert.equal(inferDate('05', '03', NOW), '2026-03-05');
  assert.equal(inferDate('30', '12', new Date('2027-01-02')), '2026-12-30');
  assert.deepEqual(parseDateRange('28.12–03.01', new Date('2026-12-20')), { dateFrom: '2026-12-28', dateTo: '2027-01-03' });
  assert.equal(regionFromTitle('Рівненський р-н, Рівненська обл.'), 'Рівненська обл.');
  assert.equal(regionFromTitle('Київ обл.'), 'Київ обл.');
  assert.equal(regionFromTitle('Автономна Республіка Крим'), 'Автономна Республіка Крим');
});

test('buildPageUrl', () => {
  assert.equal(buildPageUrl(URL0, 0), URL0);
  assert.equal(buildPageUrl(URL0, 1), URL0.replace('.html', 'r25l25.html'));
  assert.equal(buildPageUrl(URL0.replace('.html', 'r50l25.html'), 3), URL0.replace('.html', 'r75l25.html'));
  assert.equal(buildPageUrl(URL0.replace('.html', 'r50l25.html'), 0), URL0);
});

test('filters on fixture: minPrice 8000 + directOnly', () => {
  const loads = parseDellaSearch(html, { url: URL0, now: NOW });
  const f = { minPrice: 8000, directOnly: true, bodies: [], fromRegions: [], toRegions: [], excludeRegions: [], stopWords: [], maxAgeHours: 0 };
  const res = loads.map((l) => ({ l, r: applyFilters(l, f, NOW) }));
  const pass = res.filter((x) => x.r.pass);
  assert.ok(pass.length > 5 && pass.length < 25);
  assert.ok(pass.every((x) => x.l.price >= 8000 && !x.l.dellaDeleted));
  assert.ok(res.filter((x) => !x.r.pass).every((x) => x.r.reason));
  // регионы / стоп-слова / кузова
  const kyiv = loads[1];
  assert.equal(applyFilters(kyiv, { ...f, fromRegions: ['Київська'] }, NOW).pass, true);
  assert.equal(applyFilters(kyiv, { ...f, fromRegions: ['Львівська обл.'] }, NOW).pass, false);
  assert.equal(applyFilters(kyiv, { ...f, excludeRegions: ['Полтавська область'] }, NOW).pass, false);
  assert.equal(applyFilters(kyiv, { ...f, stopWords: ['ТНВ'] }, NOW).pass, false);
  assert.equal(applyFilters(kyiv, { ...f, bodies: ['тент'] }, NOW).pass, false);
  assert.equal(applyFilters(kyiv, { ...f, bodies: ['крита', 'тент'] }, NOW).pass, true);
  assert.equal(applyFilters(kyiv, f, new Date('2026-09-24T08:00:00')).pass, false, 'date passed');
  assert.ok(regionMatches('Київ обл.', ['Київська обл.']));
  assert.ok(!regionMatches('Харківська обл.', ['Херсонська обл.']));
});
