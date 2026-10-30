import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePrice,
  parseLiveBracketCommand,
  createBracketOrderFeature
} from '../../src/modules/bot/features/bracket-order.js';

test('normalizePrice correctly distinguishes cents vs decimals', () => {
  assert.equal(normalizePrice('2'), 0.02);
  assert.equal(normalizePrice('20'), 0.20);
  assert.equal(normalizePrice('45'), 0.45);
  assert.equal(normalizePrice('50'), 0.50);
  assert.equal(normalizePrice('1'), 0.01);
  assert.equal(normalizePrice('99'), 0.99);
  assert.equal(normalizePrice('0.02'), 0.02);
  assert.equal(normalizePrice('0.45'), 0.45);
  assert.equal(normalizePrice(0.5), 0.5);

  // Invalid cases
  assert.equal(normalizePrice('0'), null);
  assert.equal(normalizePrice('100'), null);
  assert.equal(normalizePrice('-5'), null);
  assert.equal(normalizePrice('abc'), null);
  assert.equal(normalizePrice(null), null);
  assert.equal(normalizePrice(undefined), null);
});

test('parseLiveBracketCommand parses "up 2 2 3" correctly', () => {
  const result = parseLiveBracketCommand('up 2 2 3');
  assert.ok(result);
  assert.equal(result.side, 'UP');
  assert.equal(result.amount, 2);
  assert.equal(result.buyPrice, 0.02);
  assert.equal(result.sellPrice, 0.03);
  assert.equal(result.buyPriceCents, 2);
  assert.equal(result.sellPriceCents, 3);
  assert.equal(result.coin, 'BTC');
});

test('parseLiveBracketCommand parses "down 5 45 50" correctly', () => {
  const result = parseLiveBracketCommand('down 5 45 50');
  assert.ok(result);
  assert.equal(result.side, 'DOWN');
  assert.equal(result.amount, 5);
  assert.equal(result.buyPrice, 0.45);
  assert.equal(result.sellPrice, 0.50);
  assert.equal(result.buyPriceCents, 45);
  assert.equal(result.sellPriceCents, 50);
  assert.equal(result.coin, 'BTC');
});

test('parseLiveBracketCommand handles custom coin and currency symbol', () => {
  const ethResult = parseLiveBracketCommand('up 2 2 3 eth');
  assert.ok(ethResult);
  assert.equal(ethResult.coin, 'ETH');

  const dollarResult = parseLiveBracketCommand('down $5 45 50 btc');
  assert.ok(dollarResult);
  assert.equal(dollarResult.amount, 5);
  assert.equal(dollarResult.side, 'DOWN');
  assert.equal(dollarResult.coin, 'BTC');
});

test('parseLiveBracketCommand handles inverted order like "$2 up 2 3"', () => {
  const result = parseLiveBracketCommand('$2 up 2 3');
  assert.ok(result);
  assert.equal(result.side, 'UP');
  assert.equal(result.amount, 2);
  assert.equal(result.buyPrice, 0.02);
  assert.equal(result.sellPrice, 0.03);
});

test('parseLiveBracketCommand enforces sellPrice > buyPrice', () => {
  const invalidLower = parseLiveBracketCommand('up 2 3 2');
  assert.ok(invalidLower);
  assert.ok(invalidLower.error);
  assert.match(invalidLower.error, /higher than buy price/);

  const invalidEqual = parseLiveBracketCommand('up 2 20 20');
  assert.ok(invalidEqual);
  assert.ok(invalidEqual.error);
  assert.match(invalidEqual.error, /higher than buy price/);
});

test('parseLiveBracketCommand ignores non-bracket commands', () => {
  assert.equal(parseLiveBracketCommand('up 20'), null);
  assert.equal(parseLiveBracketCommand('20 up'), null);
  assert.equal(parseLiveBracketCommand('buy up'), null);
  assert.equal(parseLiveBracketCommand('settings'), null);
});

test('createBracketOrderFeature returns handler', () => {
  const feature = createBracketOrderFeature({});
  assert.equal(typeof feature.handleLiveBracketOrder, 'function');
});
