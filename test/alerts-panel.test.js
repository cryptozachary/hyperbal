import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailState, addBlockedReason, panelStatus, currentValue, seedThreshold } from '../public/js/alerts.js';

// Whether email is configured is knowledge the panel only has after /api/alerts
// answers. Modelling it as a boolean defaulted to false meant the panel asserted
// "not configured" — and disabled the test button — for the whole first load,
// which sits behind several sequential round trips. A user clicking in that
// window got nothing at all, under a banner explaining a reason that was untrue.

test('unknown until the server answers: button live, no claim made', () => {
  assert.deepEqual(mailState(null), { disabled: false, warn: false });
  assert.deepEqual(mailState(undefined), { disabled: false, warn: false });
});

test('a confirmed no disables the button and explains why', () => {
  assert.deepEqual(mailState(false), { disabled: true, warn: true });
});

test('a confirmed yes enables the button and drops the banner', () => {
  assert.deepEqual(mailState(true), { disabled: false, warn: false });
});

// Clicking while we don't yet know is strictly better than a dead button: the
// request either succeeds, or returns the 503 that says exactly what's wrong.
test('the unknown state never silently swallows a click', () => {
  assert.equal(mailState(null).disabled, false);
});

// A click that does nothing, with no message, is indistinguishable from a broken
// app. Every one of these used to be a bare `return`.
test('every blocked add path explains itself', () => {
  const ok = { address: '0xabc', metrics: { account: {} }, scope: 'account', coin: '' };
  assert.equal(addBlockedReason(ok), null);

  assert.match(addBlockedReason({ ...ok, address: null }), /select a wallet/i);
  assert.match(addBlockedReason({ ...ok, metrics: null }), /still loading/i);
  assert.match(addBlockedReason({ ...ok, scope: 'position', coin: '' }), /no open positions/i);
  // A position rule with a coin is fine.
  assert.equal(addBlockedReason({ ...ok, scope: 'position', coin: 'BTC' }), null);
});

test('a load failure outranks the mail notice and persists', () => {
  assert.equal(panelStatus({ loadError: null, emailConfigured: true }), null);
  assert.match(panelStatus({ loadError: null, emailConfigured: false }), /not configured/i);
  // Nothing is claimed before the server has answered.
  assert.equal(panelStatus({ loadError: null, emailConfigured: null }), null);
  // If we couldn't read our own state, say that instead of guessing about mail.
  assert.match(panelStatus({ loadError: 'Request failed (502)', emailConfigured: false }), /502/);
});

// --- seeding the threshold with the metric's current reading ---

const ACCOUNT = {
  equity: 72709.35142, marginUsed: 314.48, totalUnrealizedPnl: -337.23, openPositionsCount: 1,
  positions: [{ coin: 'BTC', side: 'SHORT', size: -0.083, entryPrice: 68648,
    markPrice: 72709, liquidationPrice: 75551.73, leverage: 10, marginUsed: 314.48,
    unrealizedPnl: -337.23, roe: -59.16 }],
};

test('currentValue reads account and position metrics', () => {
  assert.equal(currentValue(ACCOUNT, { scope: 'account', metric: 'equity' }), 72709.35142);
  assert.equal(currentValue(ACCOUNT, { scope: 'account', metric: 'openPositionsCount' }), 1);
  assert.equal(currentValue(ACCOUNT, { scope: 'position', coin: 'BTC', metric: 'markPrice' }), 72709);
  assert.equal(currentValue(ACCOUNT, { scope: 'position', coin: 'BTC', metric: 'roe' }), -59.16);
});

test('currentValue yields nothing rather than a wrong default', () => {
  assert.equal(currentValue(null, { scope: 'account', metric: 'equity' }), null);
  assert.equal(currentValue(ACCOUNT, { scope: 'position', coin: 'ETH', metric: 'markPrice' }), null);
  assert.equal(currentValue({ positions: [] }, { scope: 'account', metric: 'equity' }), null);
});

test('liquidation distance is derived, matching the server', () => {
  // |72709 - 75551.73| / 72709 * 100
  const v = currentValue(ACCOUNT, { scope: 'position', coin: 'BTC', metric: 'liquidationDistancePct' });
  assert.ok(Math.abs(v - 3.909) < 0.001, `got ${v}`);
});

test('seedThreshold emits plain digits an <input type=number> accepts', () => {
  // No separators or symbols: a formatted string is rejected and lands as an empty box.
  assert.equal(seedThreshold(72709.35142, 'usd'), '72709.35');
  assert.equal(seedThreshold(-59.163, 'pct'), '-59.16');
  assert.equal(seedThreshold(10, 'x'), '10');
  assert.equal(seedThreshold(-0.083, 'count'), '-0.083');
  assert.equal(seedThreshold(null, 'usd'), '');
  assert.match(seedThreshold(72709.35142, 'usd'), /^-?[\d.]+$/);
});
