import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  METRICS, SCOPES, OPERATORS, isValidMetric, resolveMetric, liquidationDistancePct,
  evaluateRules, describeRule, formatValue,
} from '../alerts.js';

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

const COOLDOWN = 900000;
const NOW = 1_700_000_000_000;

// One rule with sensible defaults; each test overrides only what it is about.
const rule = (over = {}) => ({
  id: 1, address: '0xabc', scope: 'account', coin: null, metric: 'equity',
  operator: 'below', threshold: 5000, enabled: 1,
  last_state: 0, last_attempt_at: null, last_fired_at: null, ...over,
});

const one = (r, payload = PAYLOAD, now = NOW) => evaluateRules([r], payload, now, COOLDOWN)[0];

test('fires on a false to true transition', () => {
  // equity is 10000, so a "below 20000" rule is true.
  const d = one(rule({ threshold: 20000 }));
  assert.equal(d.fire, true);
  assert.equal(d.nextState, 1);
  assert.equal(d.value, 10000);
});

test('does not fire while the condition stays true', () => {
  const d = one(rule({ threshold: 20000, last_state: 1, last_attempt_at: NOW - COOLDOWN * 2 }));
  assert.equal(d.fire, false);
  assert.equal(d.nextState, 1);
});

test('does not fire when the condition is false, and records state 0', () => {
  const d = one(rule({ threshold: 5000, last_state: 1 }));
  assert.equal(d.fire, false);
  assert.equal(d.nextState, 0);
});

test('the boundary fires neither operator', () => {
  assert.equal(one(rule({ operator: 'below', threshold: 10000 })).fire, false);
  assert.equal(one(rule({ operator: 'above', threshold: 10000 })).fire, false);
  // Just past it, both do.
  assert.equal(one(rule({ operator: 'below', threshold: 10000.01 })).fire, true);
  assert.equal(one(rule({ operator: 'above', threshold: 9999.99 })).fire, true);
});

test('cooldown defers rather than dropping', () => {
  const inWindow = rule({ threshold: 20000, last_state: 0, last_attempt_at: NOW - 60000 });
  const blocked = one(inWindow);
  assert.equal(blocked.fire, false);
  // The critical assertion: state stays 0, so the next pass past the window fires.
  assert.equal(blocked.nextState, 0);

  const past = one(inWindow, PAYLOAD, NOW + COOLDOWN);
  assert.equal(past.fire, true);
  assert.equal(past.nextState, 1);
});

test('an unresolvable metric parks the rule', () => {
  const d = one(rule({ scope: 'position', coin: 'SOL', metric: 'markPrice', threshold: 1 }));
  assert.equal(d.fire, false);
  assert.equal(d.value, null);
  assert.equal(d.nextState, null);
});

test('a parked rule fires when it becomes resolvable and true', () => {
  // last_state null (parked) compares as "not true", so a fresh crossing fires.
  const d = one(rule({ scope: 'position', coin: 'BTC', metric: 'unrealizedPnl',
    operator: 'below', threshold: -500, last_state: null }));
  assert.equal(d.fire, true);
  assert.equal(d.value, -1000);
});

test('an unknown operator parks rather than defaulting', () => {
  const d = one(rule({ operator: 'equals', threshold: 10000 }));
  assert.equal(d.fire, false);
  assert.equal(d.nextState, null);
});

test('evaluateRules returns one decision per rule, in order', () => {
  const out = evaluateRules(
    [rule({ id: 1, threshold: 20000 }), rule({ id: 2, threshold: 1 })],
    PAYLOAD, NOW, COOLDOWN,
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((d) => d.rule.id), [1, 2]);
  assert.deepEqual(out.map((d) => d.fire), [true, false]);
});

test('describeRule renders the shared phrasing', () => {
  assert.equal(
    describeRule(rule({ scope: 'position', coin: 'BTC', metric: 'unrealizedPnl', operator: 'below', threshold: -500 })),
    'BTC unrealized PnL below -$500',
  );
  assert.equal(
    describeRule(rule({ metric: 'equity', operator: 'below', threshold: 5000 })),
    'account equity below $5,000',
  );
  assert.equal(
    describeRule(rule({ scope: 'position', coin: 'BTC', metric: 'liquidationDistancePct', operator: 'below', threshold: 5 })),
    'BTC distance to liquidation below 5.00%',
  );
});

test('formatValue by unit', () => {
  assert.equal(formatValue(1234.5, 'usd'), '$1,234.5');
  assert.equal(formatValue(-500, 'usd'), '-$500');
  assert.equal(formatValue(12.3456, 'pct'), '12.35%');
  assert.equal(formatValue(5, 'x'), '5×');
  assert.equal(formatValue(2, 'count'), '2');
  assert.equal(formatValue(null, 'usd'), '—');
});
