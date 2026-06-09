import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidAddress, normalizeAccount, normalizeFills, parseNum, fetchInfo } from '../hyperliquid.js';

test('isValidAddress', () => {
  assert.equal(isValidAddress('0x' + 'a'.repeat(40)), true);
  assert.equal(isValidAddress('0x' + 'A'.repeat(40)), true);
  assert.equal(isValidAddress('0x123'), false);
  assert.equal(isValidAddress('nope'), false);
  assert.equal(isValidAddress(''), false);
});

test('parseNum tolerates junk', () => {
  assert.equal(parseNum('1.5'), 1.5);
  assert.equal(parseNum(2), 2);
  assert.equal(parseNum(undefined), null);
  assert.equal(parseNum('abc'), null);
});

test('normalizeAccount derives fields', () => {
  const cs = {
    marginSummary: { accountValue: '1000', totalMarginUsed: '50' },
    assetPositions: [
      { position: {
        coin: 'BTC', szi: '2', entryPx: '90', positionValue: '200',
        unrealizedPnl: '20', returnOnEquity: '0.25', liquidationPx: '50',
        leverage: { type: 'cross', value: 10 }, marginUsed: '20',
      } },
      { position: { coin: 'ETH', szi: '0', entryPx: '0', positionValue: '0',
        unrealizedPnl: '0', returnOnEquity: '0', liquidationPx: null,
        leverage: { type: 'isolated', value: 5 }, marginUsed: '0' } },
    ],
  };
  const a = normalizeAccount(cs);
  assert.equal(a.equity, 1000);
  assert.equal(a.openPositionsCount, 1);          // zero-size excluded
  const btc = a.positions[0];
  assert.equal(btc.side, 'LONG');
  assert.equal(btc.markPrice, 100);               // 200 / |2|
  assert.equal(btc.roe, 25);                       // 0.25 * 100
  assert.equal(Math.round(a.totalUnrealizedPnl), 20);
});

test('normalizeAccount handles empty/missing', () => {
  const a = normalizeAccount({});
  assert.equal(a.equity, null);
  assert.deepEqual(a.positions, []);
  assert.equal(a.openPositionsCount, 0);
});

test('normalizeFills maps + recent sum', () => {
  const fills = [
    { tid: 1, coin: 'BTC', closedPnl: '10', fee: '0.5', px: '100', sz: '1', side: 'B', time: 111 },
    { tid: 2, coin: 'BTC', closedPnl: '-3', fee: '0.5', px: '100', sz: '1', side: 'A', time: 222 },
  ];
  const { rows, recentRealized } = normalizeFills(fills);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tid, 1);
  assert.equal(rows[0].closed_pnl, 10);
  assert.equal(recentRealized, 7);
});

test('fetchInfo throws on non-ok', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(() => fetchInfo({ type: 'x' }, { fetchImpl: fakeFetch, apiUrl: 'http://x' }), /Hyperliquid API error 500/);
});
