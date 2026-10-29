import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuickBetFeature, parseQuickBetTextCommand } from '../../src/modules/bot/features/quick-bet.js';
import {
  getPersistentBottomKeyboard,
  getQuickBetAmountKeyboard,
  getQuickBetDirectionKeyboard,
  getSettingsBottomKeyboard,
  getExportPkConfirmKeyboard,
  getWithdrawCancelKeyboard
} from '../../src/modules/bot/ui/keyboards.js';

test('createQuickBetFeature exports handlers', () => {
  assert.equal(typeof createQuickBetFeature, 'function');
  const feature = createQuickBetFeature({});
  assert.equal(typeof feature.showQuickBetMenu, 'function');
  assert.equal(typeof feature.showDirectionMenu, 'function');
  assert.equal(typeof feature.handleSelectAmount, 'function');
  assert.equal(typeof feature.handleToggleCoin, 'function');
  assert.equal(typeof feature.handleExecuteQuickBet, 'function');
});

test('parseQuickBetTextCommand correctly parses various formats', () => {
  // Standard format
  assert.deepEqual(parseQuickBetTextCommand('50 up'), { amount: 50, side: 'UP', coin: null });
  assert.deepEqual(parseQuickBetTextCommand('30 down'), { amount: 30, side: 'DOWN', coin: null });

  // Without space
  assert.deepEqual(parseQuickBetTextCommand('50up'), { amount: 50, side: 'UP', coin: null });
  assert.deepEqual(parseQuickBetTextCommand('30down'), { amount: 30, side: 'DOWN', coin: null });

  // With dollar signs
  assert.deepEqual(parseQuickBetTextCommand('$50 up'), { amount: 50, side: 'UP', coin: null });
  assert.deepEqual(parseQuickBetTextCommand('50$ down'), { amount: 50, side: 'DOWN', coin: null });

  // Inverted order (direction first)
  assert.deepEqual(parseQuickBetTextCommand('up 50'), { amount: 50, side: 'UP', coin: null });
  assert.deepEqual(parseQuickBetTextCommand('down 30'), { amount: 30, side: 'DOWN', coin: null });
  assert.deepEqual(parseQuickBetTextCommand('up $50'), { amount: 50, side: 'UP', coin: null });

  // Short forms
  assert.deepEqual(parseQuickBetTextCommand('50 u'), { amount: 50, side: 'UP', coin: null });
  assert.deepEqual(parseQuickBetTextCommand('30 d'), { amount: 30, side: 'DOWN', coin: null });

  // With coin specified
  assert.deepEqual(parseQuickBetTextCommand('50 up eth'), { amount: 50, side: 'UP', coin: 'ETH' });
  assert.deepEqual(parseQuickBetTextCommand('30 down btc'), { amount: 30, side: 'DOWN', coin: 'BTC' });
  assert.deepEqual(parseQuickBetTextCommand('50 eth up'), { amount: 50, side: 'UP', coin: 'ETH' });
  assert.deepEqual(parseQuickBetTextCommand('btc 30 down'), { amount: 30, side: 'DOWN', coin: 'BTC' });

  // Non-matching inputs
  assert.equal(parseQuickBetTextCommand('$1'), null);
  assert.equal(parseQuickBetTextCommand('Settings'), null);
  assert.equal(parseQuickBetTextCommand('Positions'), null);
  assert.equal(parseQuickBetTextCommand('🟢 Buy UP ($3)'), null);
  assert.equal(parseQuickBetTextCommand('🔴 Buy DOWN ($3)'), null);
  assert.equal(parseQuickBetTextCommand('upload'), null);
  assert.equal(parseQuickBetTextCommand('download'), null);
  assert.equal(parseQuickBetTextCommand('update'), null);
  assert.equal(parseQuickBetTextCommand('0 up'), null);
});

test('getPersistentBottomKeyboard creates clean bottom layout without old strategy', () => {
  const keyboard = getPersistentBottomKeyboard();
  const json = JSON.stringify(keyboard);
  assert.match(json, /1-Click Bet/);
  assert.match(json, /Balance/);
  assert.match(json, /Positions/);
  assert.match(json, /Orders/);
  assert.match(json, /Trend/);
  assert.match(json, /Settings/);
  assert.equal(json.includes('Split & Sell'), false);
  assert.equal(json.includes('5M UpDown'), false);
});

test('getQuickBetAmountKeyboard creates clean step 1 bottom keyboard layout', () => {
  const keyboard = getQuickBetAmountKeyboard('BTC');
  const json = JSON.stringify(keyboard);
  assert.match(json, /\$1/);
  assert.match(json, /\$3/);
  assert.match(json, /\$5/);
  assert.match(json, /\$10/);
  assert.match(json, /Switch to ETH/);
  assert.match(json, /Back to Menu/);
  assert.equal(json.includes('Buy UP'), false);
  assert.equal(json.includes('Buy DOWN'), false);
});

test('getQuickBetDirectionKeyboard creates clean step 2 bottom keyboard layout', () => {
  const keyboard = getQuickBetDirectionKeyboard(3, 'BTC');
  const json = JSON.stringify(keyboard);
  assert.match(json, /Buy UP \(\$3\)/);
  assert.match(json, /Buy DOWN \(\$3\)/);
  assert.match(json, /Change Amount/);
  assert.match(json, /Main Menu/);
  assert.equal(json.includes('$10'), false);
});

test('getSettingsBottomKeyboard creates clean settings bottom keyboard without inline buttons', () => {
  const keyboard = getSettingsBottomKeyboard();
  const json = JSON.stringify(keyboard);
  assert.match(json, /Redeem Winnings/);
  assert.match(json, /Set Allowances/);
  assert.match(json, /Collateral Status/);
  assert.match(json, /Wrap USDC\.e/);
  assert.match(json, /Withdraw Funds/);
  assert.match(json, /Export Private Key/);
  assert.match(json, /Back to Menu/);
  assert.equal(json.includes('Strategy'), false);
  assert.equal(json.includes('Notifications'), false);
});

test('getExportPkConfirmKeyboard and getWithdrawCancelKeyboard produce valid bottom keyboards', () => {
  const exportKb = JSON.stringify(getExportPkConfirmKeyboard());
  assert.match(exportKb, /CONFIRM EXPORT/);
  assert.match(exportKb, /Back to Settings/);

  const withdrawKb = JSON.stringify(getWithdrawCancelKeyboard());
  assert.match(withdrawKb, /Back to Settings/);
});
