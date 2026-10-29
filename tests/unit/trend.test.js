import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTrendMessage, getTrendKeyboard, createTrendFeature } from '../../src/modules/bot/features/trend.js';

test('createTrendFeature exports showTrend', () => {
  const feature = createTrendFeature();
  assert.equal(typeof feature.showTrend, 'function');
});

test('formatTrendMessage correctly formats outcomes and counts streak', () => {
  const mockRounds = [
    { title: 'Bitcoin Up or Down - 7:35AM-7:40AM ET', timeStr: '7:35AM-7:40AM ET', winner: 'UP' },
    { title: 'Bitcoin Up or Down - 7:30AM-7:35AM ET', timeStr: '7:30AM-7:35AM ET', winner: 'DOWN' },
    { title: 'Bitcoin Up or Down - 7:25AM-7:30AM ET', timeStr: '7:25AM-7:30AM ET', winner: 'DOWN' },
    { title: 'Bitcoin Up or Down - 7:20AM-7:25AM ET', timeStr: '7:20AM-7:25AM ET', winner: 'UP' },
    { title: 'Bitcoin Up or Down - 7:15AM-7:20AM ET', timeStr: '7:15AM-7:20AM ET', winner: 'DOWN' },
    { title: 'Bitcoin Up or Down - 7:10AM-7:15AM ET', timeStr: '7:10AM-7:15AM ET', winner: 'DOWN' },
    { title: 'Bitcoin Up or Down - 7:05AM-7:10AM ET', timeStr: '7:05AM-7:10AM ET', winner: 'UP' },
    { title: 'Bitcoin Up or Down - 7:00AM-7:05AM ET', timeStr: '7:00AM-7:05AM ET', winner: 'DOWN' },
    { title: 'Bitcoin Up or Down - 6:55AM-7:00AM ET', timeStr: '6:55AM-7:00AM ET', winner: 'DOWN' },
    { title: 'Bitcoin Up or Down - 6:50AM-6:55AM ET', timeStr: '6:50AM-6:55AM ET', winner: 'UP' }
  ];

  const text = formatTrendMessage(mockRounds, 'BTC');
  assert.match(text, /BTC 5M Up\/Down Trend/);
  assert.match(text, /🟢 UP: <b>4<\/b>/);
  assert.match(text, /🔴 DOWN: <b>6<\/b>/);
  assert.match(text, /Streak:<\/b> 🟢 UP \(1 in a row\)/);
  assert.match(text, /7:35AM-7:40AM ET/);
});

test('getTrendKeyboard creates valid inline keyboard with toggle and refresh', () => {
  const keyboard = getTrendKeyboard('BTC');
  const json = JSON.stringify(keyboard);
  assert.match(json, /Switch to ETH/);
  assert.match(json, /trend:coin:ETH/);
  assert.match(json, /trend:refresh:BTC/);
  assert.match(json, /1-Click Bet/);
});
