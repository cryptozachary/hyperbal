import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailState, addBlockedReason } from '../public/js/alerts.js';

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
