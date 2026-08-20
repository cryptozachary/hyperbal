// Pure alert logic: which metrics exist, how to read one off an account payload,
// and (Task 2) whether a rule should fire. No database, no clock, no network —
// which is what makes the firing semantics testable without a fixture.

// The metric whitelist, keyed by scope. `metric` from an HTTP request is checked
// against this and never interpolated into SQL or evaluated as code, which is why
// a "general rule model" does not mean an expression language.
//
// Every name here must exist on the payload normalizeAccount() produces — except
// liquidationDistancePct, which is derived below.
export const METRICS = {
  account: {
    equity:             { label: 'account equity',       unit: 'usd' },
    marginUsed:         { label: 'margin used',          unit: 'usd' },
    totalUnrealizedPnl: { label: 'total unrealized PnL', unit: 'usd' },
    openPositionsCount: { label: 'open positions',       unit: 'count' },
  },
  position: {
    markPrice:              { label: 'mark price',              unit: 'usd' },
    entryPrice:             { label: 'entry price',             unit: 'usd' },
    liquidationPrice:       { label: 'liquidation price',       unit: 'usd' },
    unrealizedPnl:          { label: 'unrealized PnL',          unit: 'usd' },
    roe:                    { label: 'ROE',                     unit: 'pct' },
    leverage:               { label: 'leverage',                unit: 'x' },
    size:                   { label: 'position size',           unit: 'count' },
    marginUsed:             { label: 'margin used',             unit: 'usd' },
    liquidationDistancePct: { label: 'distance to liquidation', unit: 'pct' },
  },
};

export const SCOPES = Object.keys(METRICS);
export const OPERATORS = ['above', 'below'];

const owns = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// hasOwnProperty rather than `in` or a truthy lookup: isValidMetric('account',
// 'constructor') must be false, and an inherited key would otherwise sail
// straight through into resolveMetric.
export function isValidMetric(scope, metric) {
  return owns(METRICS, scope) && owns(METRICS[scope], metric);
}

// |mark − liq| / |mark| × 100. Null unless both inputs are finite and mark is
// non-zero: a position with no liquidation price (fully collateralized, or the
// upstream simply didn't send one) has no distance to report, and reporting 0
// there would read as "about to be liquidated" — the exact inversion of the truth.
export function liquidationDistancePct(pos) {
  const mark = pos?.markPrice;
  const liq = pos?.liquidationPrice;
  if (!Number.isFinite(mark) || !Number.isFinite(liq) || mark === 0) return null;
  return (Math.abs(mark - liq) / Math.abs(mark)) * 100;
}

// The rule's current value, or null when it can't be resolved right now (position
// closed, coin not held, field absent upstream). Null means "unknown" and never
// zero — the evaluator parks a rule rather than comparing a threshold against a
// value it doesn't have.
export function resolveMetric(payload, rule) {
  if (!payload || !isValidMetric(rule.scope, rule.metric)) return null;

  if (rule.scope === 'account') {
    const v = payload[rule.metric];
    return Number.isFinite(v) ? v : null;
  }

  const pos = (payload.positions || []).find((p) => p.coin === rule.coin);
  if (!pos) return null;
  if (rule.metric === 'liquidationDistancePct') return liquidationDistancePct(pos);
  const v = pos[rule.metric];
  return Number.isFinite(v) ? v : null;
}
