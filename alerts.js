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

// Decide what to do with each rule against one account payload. Returns one
// decision per rule, in the order given: the observed value, whether to send, and
// the `last_state` to persist (null = parked/unresolvable).
//
// A rule fires when the condition is true, was NOT true at the previous
// evaluation, and the cooldown has elapsed. The middle clause is the edge
// detection — a value that sits past its threshold for an hour produces one email,
// not one per tick.
//
// These comparisons run here in JS, never in SQL: `last_state = NULL` must read as
// "not true" so a parked rule can fire again, whereas a SQL `last_state != 1`
// would evaluate to NULL and silently match nothing.
export function evaluateRules(rules, payload, now, cooldownMs) {
  return rules.map((rule) => {
    const value = resolveMetric(payload, rule);
    if (value === null) return { rule, value: null, fire: false, nextState: null };

    const condition = rule.operator === 'above' ? value > rule.threshold
      : rule.operator === 'below' ? value < rule.threshold
      : null;
    // An operator outside the whitelist parks the rule. The API validates on the
    // way in, so this is only reachable via a hand-edited database — but treating
    // an unknown operator as "below" would fire real emails off a typo.
    if (condition === null) return { rule, value, fire: false, nextState: null };

    if (!condition) return { rule, value, fire: false, nextState: 0 };
    if (rule.last_state === 1) return { rule, value, fire: false, nextState: 1 };

    // Inside the quiet period. nextState stays 0 — NOT 1 — so the very next
    // evaluation past the window sees a still-true condition against a false prior
    // state and fires. The cooldown delays an alert; it must never swallow one.
    const cooled = rule.last_attempt_at == null || now - rule.last_attempt_at >= cooldownMs;
    if (!cooled) return { rule, value, fire: false, nextState: 0 };

    return { rule, value, fire: true, nextState: 1 };
  });
}

// Value formatting by unit. Locale is pinned to en-US so an email reads the same
// regardless of the server's locale — unlike public/js/format.js, which
// deliberately follows the viewer's.
export function formatValue(v, unit) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (unit === 'usd') return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (unit === 'pct') return `${v.toFixed(2)}%`;
  if (unit === 'x') return `${v}×`;
  return String(v);
}

// One phrasing of a rule, shared by the email subject and the UI list so the two
// cannot drift into describing the same rule differently.
export function describeRule(rule) {
  const meta = METRICS[rule.scope]?.[rule.metric];
  const name = meta ? meta.label : rule.metric;
  const subject = rule.scope === 'position' ? `${rule.coin} ${name}` : name;
  return `${subject} ${rule.operator} ${formatValue(rule.threshold, meta?.unit)}`;
}
