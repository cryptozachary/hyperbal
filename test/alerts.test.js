import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METRICS, SCOPES, OPERATORS, isValidMetric, resolveMetric, liquidationDistancePct } from '../alerts.js';

// A representative assembleAccount() payload. Field names match normalizeAccount()
// in hyperliquid.js — if those ever change, these tests are the tripwire.
const PAYLOAD = {
  equity: 10000,
  marginUsed: 2500,
  totalUnrealizedPnl: -300,
  openPositionsCount: 2,
  positions: [
    { coin: 'BTC', size: 0.5, side: 'LONG', entryPrice: 60000, markPrice: 58000,
      liquidationPrice: 52200, leverage: 5, marginUsed: 5800, unrealizedPnl: -1000, roe: -16.67 },
    { coin: 'ETH', size: -2, side: 'SHORT', entryPrice: 3000, markPrice: 2650,
      liquidationPrice: null, leverage: 3, marginUsed: 1766, unrealizedPnl: 700, roe: 11.67 },
  ],
};

test('scopes and operators are the documented sets', () => {
  assert.deepEqual([...SCOPES].sort(), ['account', 'position']);
  assert.deepEqual(OPERATORS, ['above', 'below']);
});

test('every metric declares a label and a unit', () => {
  for (const scope of SCOPES) {
    for (const [name, meta] of Object.entries(METRICS[scope])) {
      assert.equal(typeof meta.label, 'string', `${scope}.${name} label`);
      assert.ok(['usd', 'pct', 'x', 'count'].includes(meta.unit), `${scope}.${name} unit`);
    }
  }
});

test('isValidMetric rejects unknown scope, unknown metric, and wrong scope', () => {
  assert.equal(isValidMetric('account', 'equity'), true);
  assert.equal(isValidMetric('position', 'markPrice'), true);
  assert.equal(isValidMetric('account', 'markPrice'), false); // right metric, wrong scope
  assert.equal(isValidMetric('position', 'equity'), false);
  assert.equal(isValidMetric('nonsense', 'equity'), false);
  // Prototype keys must not read as valid metrics.
  assert.equal(isValidMetric('__proto__', 'toString'), false);
  assert.equal(isValidMetric('account', 'constructor'), false);
});

test('resolveMetric reads every account metric', () => {
  const at = (metric) => resolveMetric(PAYLOAD, { scope: 'account', metric });
  assert.equal(at('equity'), 10000);
  assert.equal(at('marginUsed'), 2500);
  assert.equal(at('totalUnrealizedPnl'), -300);
  assert.equal(at('openPositionsCount'), 2);
});

test('resolveMetric reads every position metric', () => {
  const at = (metric, coin = 'BTC') => resolveMetric(PAYLOAD, { scope: 'position', coin, metric });
  assert.equal(at('markPrice'), 58000);
  assert.equal(at('entryPrice'), 60000);
  assert.equal(at('liquidationPrice'), 52200);
  assert.equal(at('unrealizedPnl'), -1000);
  assert.equal(at('roe'), -16.67);
  assert.equal(at('leverage'), 5);
  assert.equal(at('size'), 0.5);
  assert.equal(at('marginUsed'), 5800);
  assert.equal(at('size', 'ETH'), -2); // negative size resolves, it is not "missing"
});

test('resolveMetric returns null rather than 0 when it cannot resolve', () => {
  // Coin not held at all.
  assert.equal(resolveMetric(PAYLOAD, { scope: 'position', coin: 'SOL', metric: 'markPrice' }), null);
  // Held, but the field itself is null upstream.
  assert.equal(resolveMetric(PAYLOAD, { scope: 'position', coin: 'ETH', metric: 'liquidationPrice' }), null);
  // No payload at all.
  assert.equal(resolveMetric(null, { scope: 'account', metric: 'equity' }), null);
  // A metric outside the whitelist never resolves, whatever the payload holds.
  assert.equal(resolveMetric({ ...PAYLOAD, secret: 1 }, { scope: 'account', metric: 'secret' }), null);
  // An account with no positions reports null unrealized PnL — parked, not zero.
  assert.equal(resolveMetric({ equity: 5, positions: [] }, { scope: 'account', metric: 'totalUnrealizedPnl' }), null);
});

test('liquidationDistancePct', () => {
  // |58000 - 52200| / 58000 * 100 = 10
  assert.equal(resolveMetric(PAYLOAD, { scope: 'position', coin: 'BTC', metric: 'liquidationDistancePct' }), 10);
  // ETH has no liquidation price — no distance to report.
  assert.equal(resolveMetric(PAYLOAD, { scope: 'position', coin: 'ETH', metric: 'liquidationDistancePct' }), null);
  assert.equal(liquidationDistancePct({ markPrice: 0, liquidationPrice: 10 }), null); // no division by zero
  assert.equal(liquidationDistancePct({ markPrice: 100, liquidationPrice: null }), null);
  assert.equal(liquidationDistancePct(null), null);
  // A short's liquidation price sits above the mark; distance is still positive.
  assert.equal(liquidationDistancePct({ markPrice: 2650, liquidationPrice: 3180 }), 20);
});
