import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dellaSearchUrl, DEFAULT_SEARCH_URL } from '../worker/src/engine.js';

test('dellaSearchUrl: галочка вимкнена — з адреси Della знято «лише прямий замовник» (z21 → z2)', () => {
  assert.equal(dellaSearchUrl(DEFAULT_SEARCH_URL, false), DEFAULT_SEARCH_URL.replace('z1z21z3', 'z1z2z3'));
});
test('dellaSearchUrl: галочка ввімкнена — адреса без змін', () => {
  assert.equal(dellaSearchUrl(DEFAULT_SEARCH_URL, true), DEFAULT_SEARCH_URL);
});
test('dellaSearchUrl: адреса без z21 і з іншими z2x не ламається', () => {
  const u = 'https://della.com.ua/search/a204bd204eflolz1z2z3z4z51.html';
  assert.equal(dellaSearchUrl(u, false), u);
  const v = 'https://della.com.ua/search/a204z21.html';
  assert.equal(dellaSearchUrl(v, false), 'https://della.com.ua/search/a204z2.html');
});
