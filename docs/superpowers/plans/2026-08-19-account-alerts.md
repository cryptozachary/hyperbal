# Account Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user define threshold rules over account and position metrics, evaluate them server-side with no browser open, and email when a rule crosses.

**Architecture:** A pure evaluator (`alerts.js`) decides everything — which metrics exist, how to read one off an account payload, and whether a rule fires — with no database, clock, or network. A stateful runner (`alert-runner.js`) subscribes to the existing Hyperliquid `webData2` stream as a *trigger*, debounces it, re-fetches the aggregated account via `assembleAccount()`, feeds the evaluator, and persists the outcome. A 5-minute backstop interval covers a stalled stream. Email goes through a two-property `notifier.js` interface that degrades to logging when SMTP is unconfigured.

**Tech Stack:** Node 18+ ESM, Express 4, better-sqlite3, `ws`, and one new zero-dependency package: `nodemailer`. Tests are `node:test` + `node:assert/strict`, as everywhere else in this repo.

**Spec:** `docs/superpowers/specs/2026-08-19-account-alerts-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `alerts.js` *(new)* | Pure. Metric whitelist, `resolveMetric`, `evaluateRules`, `describeRule`, `formatValue`. |
| `notifier.js` *(new)* | Email transport. SMTP via nodemailer, or a logging no-op. |
| `alert-runner.js` *(new)* | Stateful. Stream subscription, debounce, backstop interval, evaluate→send→persist. |
| `public/js/alerts.js` *(new)* | The alerts panel. |
| `db.js` | Add the `alerts` table, its CRUD, and the cascade delete. |
| `server.js` | Add the five `/api/alerts` routes and the bootstrap wiring. |
| `config.js` | Add SMTP and alert-timing env vars. |
| `public/js/api.js` | Add the five route wrappers. |
| `public/index.html` | Add the panel markup. |
| `public/styles.css` | Add the panel styles. |
| `public/js/app.js` | Mount the panel, feed it positions and the selected address. |
| `.env.example`, `README.md` | Document the new configuration. |

---

## Task 0: Configuration and dependency

**Goal:** New env vars land in `config.js` with sane defaults, and `nodemailer` is installed.

**Files:**
- Modify: `config.js`
- Modify: `.env.example`
- Modify: `package.json` (via npm)
- Test: `test/config.test.js`

**Acceptance Criteria:**
- [ ] `config.alertCooldownMs` defaults to 900000, `alertPollIntervalMs` to 300000, `alertDebounceMs` to 5000
- [ ] `config.smtpPort` defaults to 587
- [ ] `config.dashboardUrl` defaults to `http://localhost:<port>` using the same resolved port
- [ ] `nodemailer` is in `dependencies`

**Verify:** `node --test test/config.test.js` → all tests pass

**Steps:**

- [ ] **Step 1: Install nodemailer**

```bash
npm install nodemailer
```

- [ ] **Step 2: Write the failing test**

Append to `test/config.test.js`:

```js
test('config has alert defaults', () => {
  assert.equal(config.alertCooldownMs, 900000);
  assert.equal(config.alertPollIntervalMs, 300000);
  assert.equal(config.alertDebounceMs, 5000);
  assert.equal(config.smtpPort, 587);
  assert.match(config.dashboardUrl, /^https?:\/\//);
  // The link in an alert email must point at the port the server actually listens on.
  assert.ok(config.dashboardUrl.endsWith(String(config.port)));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — `Expected values to be strictly equal: undefined !== 900000`

- [ ] **Step 4: Rewrite `config.js`**

The port moves out of the object literal so `dashboardUrl` can interpolate it.

```js
import 'dotenv/config';

function clean(v) {
  return (v ?? '').trim();
}

// Hoisted out of the literal below so dashboardUrl can default against the same
// resolved value rather than re-reading (and re-defaulting) process.env.PORT.
const port = Number(clean(process.env.PORT)) || 3005;

export const config = {
  port,
  hlApiUrl: clean(process.env.HL_API_URL) || 'https://api.hyperliquid.xyz/info',
  hlWsUrl: clean(process.env.HL_WS_URL) || 'wss://api.hyperliquid.xyz/ws',
  defaultWallet: clean(process.env.DEFAULT_WALLET).toLowerCase(),
  dbPath: clean(process.env.DB_PATH) || './data/hyperliquid.db',
  snapshotMinIntervalMs: Number(clean(process.env.SNAPSHOT_MIN_INTERVAL_MS)) || 60000,

  // Alerts. Every one of these is optional: with no SMTP_HOST/ALERT_EMAIL_TO the
  // notifier degrades to logging and the rest of the feature still works.
  smtpHost: clean(process.env.SMTP_HOST),
  smtpPort: Number(clean(process.env.SMTP_PORT)) || 587,
  smtpUser: clean(process.env.SMTP_USER),
  smtpPass: clean(process.env.SMTP_PASS),
  smtpFrom: clean(process.env.SMTP_FROM),
  alertEmailTo: clean(process.env.ALERT_EMAIL_TO),
  alertCooldownMs: Number(clean(process.env.ALERT_COOLDOWN_MS)) || 900000,
  alertPollIntervalMs: Number(clean(process.env.ALERT_POLL_INTERVAL_MS)) || 300000,
  alertDebounceMs: Number(clean(process.env.ALERT_DEBOUNCE_MS)) || 5000,
  dashboardUrl: clean(process.env.DASHBOARD_URL) || `http://localhost:${port}`,
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS, 2 tests

- [ ] **Step 6: Document the new vars in `.env.example`**

Append:

```
# --- Alerts (all optional) ---
# Without SMTP_HOST and ALERT_EMAIL_TO, alerts still evaluate but are only logged.
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
# Envelope From; defaults to SMTP_USER
SMTP_FROM=
# Where alert emails are delivered
ALERT_EMAIL_TO=
# Quiet period between sends for a single rule (ms). Default 15 minutes.
ALERT_COOLDOWN_MS=900000
# Backstop sweep interval, in case the websocket stalls silently (ms)
ALERT_POLL_INTERVAL_MS=300000
# Debounce applied to websocket-triggered evaluations (ms)
ALERT_DEBOUNCE_MS=5000
# Link target in the alert email body; defaults to http://localhost:PORT
DASHBOARD_URL=
```

- [ ] **Step 7: Commit**

```bash
git add config.js .env.example package.json package-lock.json test/config.test.js
git commit -m "feat(config): add SMTP and alert timing configuration"
```

---

## Task 1: Metric whitelist and resolution

**Goal:** `alerts.js` exposes the whitelist and can read any listed metric off an `assembleAccount()` payload.

**Files:**
- Create: `alerts.js`
- Test: `test/alerts.test.js`

**Acceptance Criteria:**
- [ ] `METRICS` is keyed by scope (`account`, `position`) with `label` and `unit` per metric
- [ ] `isValidMetric` rejects an unknown scope, an unknown metric, and a metric used under the wrong scope
- [ ] `resolveMetric` returns the value for every whitelisted metric
- [ ] `resolveMetric` returns `null` — never `0` — when a position is absent or a field is null
- [ ] `liquidationDistancePct` computes `|mark − liq| / |mark| × 100`, `null` on any unusable input

**Verify:** `node --test test/alerts.test.js` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

Create `test/alerts.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/alerts.test.js`
Expected: FAIL — `Cannot find module '../alerts.js'`

- [ ] **Step 3: Create `alerts.js`**

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/alerts.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add alerts.js test/alerts.test.js
git commit -m "feat(alerts): add metric whitelist and resolution"
```

---

## Task 2: Firing semantics

**Goal:** `evaluateRules` decides fire/no-fire with edge detection and a deferring cooldown, plus the shared human phrasing used by the email and the UI.

**Files:**
- Modify: `alerts.js`
- Test: `test/alerts.test.js`

**Acceptance Criteria:**
- [ ] Fires on a false→true transition
- [ ] Does not re-fire while the condition stays true
- [ ] `value === threshold` fires neither operator
- [ ] Cooldown defers: blocked inside the window with `nextState` left at `0`, fires once past it
- [ ] An unresolvable metric yields `nextState: null` and no fire
- [ ] An unknown operator parks the rule rather than defaulting to a comparison
- [ ] `describeRule` renders `BTC unrealized PnL below -$500`

**Verify:** `node --test test/alerts.test.js` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

Append to `test/alerts.test.js`. Extend the existing import at the top of the file to add the three new names:

```js
import {
  METRICS, SCOPES, OPERATORS, isValidMetric, resolveMetric, liquidationDistancePct,
  evaluateRules, describeRule, formatValue,
} from '../alerts.js';
```

Then append the tests (`PAYLOAD` is already in scope from Task 1):

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/alerts.test.js`
Expected: FAIL — `SyntaxError: The requested module '../alerts.js' does not provide an export named 'evaluateRules'`

- [ ] **Step 3: Append the implementation to `alerts.js`**

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/alerts.test.js`
Expected: PASS, 18 tests

- [ ] **Step 5: Commit**

```bash
git add alerts.js test/alerts.test.js
git commit -m "feat(alerts): add edge-triggered firing with a deferring cooldown"
```

---

## Task 3: Alerts table and CRUD

**Goal:** `db.js` stores rules, reads them back, records evaluation outcomes, and purges them with their wallet.

**Files:**
- Modify: `db.js`
- Test: `test/db.test.js`

**Acceptance Criteria:**
- [ ] `alerts` table exists with the spec's columns and an index on `address`
- [ ] `createAlert` returns the stored row including its new `id`
- [ ] `listAlerts` returns all rules for an address; `listEnabledAlerts` only enabled ones
- [ ] `alertAddresses` returns distinct addresses with at least one enabled rule
- [ ] `updateAlert` patches `enabled`/`threshold` and resets `last_state` to NULL
- [ ] `updateAlert` returns null and `deleteAlert` returns false for an unknown id
- [ ] `saveAlertResult` writes `last_state` unconditionally and leaves `last_attempt_at`/`last_fired_at` untouched when passed null
- [ ] `deleteWallet` purges that wallet's alerts and no other wallet's

**Verify:** `node --test test/db.test.js` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

Append to `test/db.test.js` (`freshDb` is already defined at the top of that file):

```js
const ALERT = { address: '0xaaa', scope: 'account', coin: null, metric: 'equity', operator: 'below', threshold: 5000 };

test('createAlert stores and returns the row', () => {
  const db = freshDb();
  const a = db.createAlert(ALERT);
  assert.ok(a.id > 0);
  assert.equal(a.address, '0xaaa');
  assert.equal(a.metric, 'equity');
  assert.equal(a.threshold, 5000);
  assert.equal(a.enabled, 1);
  assert.equal(a.last_state, null);
  assert.equal(a.last_fired_at, null);
  assert.ok(a.created_at > 0);
});

test('listAlerts and listEnabledAlerts', () => {
  const db = freshDb();
  const on = db.createAlert(ALERT);
  const off = db.createAlert({ ...ALERT, metric: 'marginUsed', threshold: 1 });
  db.createAlert({ ...ALERT, address: '0xbbb' });
  db.updateAlert(off.id, { enabled: 0 });

  assert.equal(db.listAlerts('0xaaa').length, 2);
  const enabled = db.listEnabledAlerts('0xaaa');
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].id, on.id);
  assert.equal(db.listAlerts('0xbbb').length, 1);
});

test('alertAddresses lists distinct addresses with an enabled rule', () => {
  const db = freshDb();
  db.createAlert(ALERT);
  db.createAlert({ ...ALERT, metric: 'marginUsed' }); // same address, second rule
  const disabled = db.createAlert({ ...ALERT, address: '0xbbb' });
  db.updateAlert(disabled.id, { enabled: 0 });

  assert.deepEqual(db.alertAddresses(), ['0xaaa']);
});

test('updateAlert patches and re-arms', () => {
  const db = freshDb();
  const a = db.createAlert(ALERT);
  db.saveAlertResult(a.id, { lastState: 1, attemptAt: 111, firedAt: 111 });

  const updated = db.updateAlert(a.id, { threshold: 7000 });
  assert.equal(updated.threshold, 7000);
  // Re-armed: the old edge state described a threshold that no longer exists.
  assert.equal(updated.last_state, null);
  // Firing history is NOT reset — the UI still shows when it last fired.
  assert.equal(updated.last_fired_at, 111);

  assert.equal(db.updateAlert(9999, { threshold: 1 }), null);
});

test('updateAlert toggles enabled without touching threshold', () => {
  const db = freshDb();
  const a = db.createAlert(ALERT);
  const off = db.updateAlert(a.id, { enabled: 0 });
  assert.equal(off.enabled, 0);
  assert.equal(off.threshold, 5000);
  assert.equal(db.updateAlert(a.id, { enabled: 1 }).enabled, 1);
});

test('deleteAlert', () => {
  const db = freshDb();
  const a = db.createAlert(ALERT);
  assert.equal(db.deleteAlert(a.id), true);
  assert.equal(db.listAlerts('0xaaa').length, 0);
  assert.equal(db.deleteAlert(a.id), false);
});

test('saveAlertResult writes state and leaves null timestamps alone', () => {
  const db = freshDb();
  const a = db.createAlert(ALERT);
  db.saveAlertResult(a.id, { lastState: 1, attemptAt: 500, firedAt: 500 });

  // A no-fire pass: state advances, timestamps must survive untouched.
  db.saveAlertResult(a.id, { lastState: 0 });
  let row = db.listAlerts('0xaaa')[0];
  assert.equal(row.last_state, 0);
  assert.equal(row.last_attempt_at, 500);
  assert.equal(row.last_fired_at, 500);

  // A failed send: attempt advances, fired does not.
  db.saveAlertResult(a.id, { lastState: 0, attemptAt: 900 });
  row = db.listAlerts('0xaaa')[0];
  assert.equal(row.last_attempt_at, 900);
  assert.equal(row.last_fired_at, 500);

  // Parking writes a genuine NULL rather than being swallowed as "no change".
  db.saveAlertResult(a.id, { lastState: null });
  assert.equal(db.listAlerts('0xaaa')[0].last_state, null);
});

test('deleteWallet purges that wallet alerts only', () => {
  const db = freshDb();
  for (const addr of ['0xaaa', '0xbbb']) {
    db.upsertWallet(addr, 'w');
    db.createAlert({ ...ALERT, address: addr });
  }
  db.deleteWallet('0xaaa');
  assert.equal(db.listAlerts('0xaaa').length, 0);
  assert.equal(db.listAlerts('0xbbb').length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/db.test.js`
Expected: FAIL — `TypeError: db.createAlert is not a function`

- [ ] **Step 3: Add the table to the `SCHEMA` string in `db.js`**

Append inside the `SCHEMA` template literal, after the `funding` table:

```sql
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  scope TEXT NOT NULL,
  coin TEXT,
  metric TEXT NOT NULL,
  operator TEXT NOT NULL,
  threshold REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_state INTEGER,
  last_attempt_at INTEGER,
  last_fired_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_addr ON alerts(address);
```

No `ALTER TABLE` migration is needed — the table is new, so `CREATE TABLE IF NOT EXISTS` covers both a fresh database and an existing one.

- [ ] **Step 4: Add the prepared statements**

Inside the `stmts` object in `openDb`, after `rangeFunding`:

```js
    insertAlert: db.prepare(`
      INSERT INTO alerts (address, scope, coin, metric, operator, threshold, enabled, created_at)
      VALUES (@address, @scope, @coin, @metric, @operator, @threshold, 1, @now)
    `),
    getAlert: db.prepare(`SELECT * FROM alerts WHERE id = ?`),
    listAlerts: db.prepare(`SELECT * FROM alerts WHERE address = ? ORDER BY created_at ASC, id ASC`),
    listEnabledAlerts: db.prepare(`SELECT * FROM alerts WHERE address = ? AND enabled = 1 ORDER BY id ASC`),
    alertAddresses: db.prepare(`SELECT DISTINCT address FROM alerts WHERE enabled = 1 ORDER BY address ASC`),
    // Patch what was sent and leave the rest: COALESCE(@x, column) makes an
    // omitted field mean "unchanged" rather than "set to null".
    //
    // last_state is deliberately NOT coalesced — it resets to NULL on every patch.
    // A threshold that moved, or a rule coming back from disabled, describes a
    // world the old edge state no longer refers to; carrying last_state = 1 across
    // would suppress the first real crossing under the new settings.
    // last_fired_at survives, so the UI keeps its history.
    updateAlert: db.prepare(`
      UPDATE alerts SET
        enabled = COALESCE(@enabled, enabled),
        threshold = COALESCE(@threshold, threshold),
        last_state = NULL
      WHERE id = @id
    `),
    deleteAlert: db.prepare(`DELETE FROM alerts WHERE id = ?`),
    removeAlerts: db.prepare(`DELETE FROM alerts WHERE address = ?`),
    // Mirrors the runner's three outcomes. last_state is assigned directly (NULL is
    // a meaningful value here — a parked rule); the two timestamps are coalesced,
    // so a pass that sent nothing leaves them exactly as they were.
    saveAlertResult: db.prepare(`
      UPDATE alerts SET
        last_state = @lastState,
        last_attempt_at = COALESCE(@attemptAt, last_attempt_at),
        last_fired_at = COALESCE(@firedAt, last_fired_at)
      WHERE id = @id
    `),
```

- [ ] **Step 5: Add `removeAlerts` to the wallet delete transaction**

Replace `deleteWalletTxn` in `db.js`:

```js
  // One transaction so a mid-delete failure can't leave a wallet whose row is
  // gone but whose fills, snapshots, and alerts remain.
  const deleteWalletTxn = db.transaction((address) => {
    stmts.removeWallet.run(address);
    stmts.removeSnapshots.run(address);
    stmts.removeFills.run(address);
    stmts.removeFunding.run(address);
    stmts.removeAlerts.run(address);
  });
```

- [ ] **Step 6: Add the wrapper methods**

In the object `openDb` returns, after `insertSnapshotThrottled`:

```js
    createAlert({ address, scope, coin = null, metric, operator, threshold }) {
      const info = stmts.insertAlert.run({ address, scope, coin, metric, operator, threshold, now: Date.now() });
      return stmts.getAlert.get(info.lastInsertRowid);
    },
    listAlerts(address) { return stmts.listAlerts.all(address); },
    listEnabledAlerts(address) { return stmts.listEnabledAlerts.all(address); },
    alertAddresses() { return stmts.alertAddresses.all().map((r) => r.address); },
    // Returns the updated row, or null if there is no such alert.
    updateAlert(id, { enabled, threshold } = {}) {
      stmts.updateAlert.run({
        id,
        // better-sqlite3 rejects booleans and undefined bindings outright, so both
        // are normalized here rather than at every call site.
        enabled: enabled == null ? null : (enabled ? 1 : 0),
        threshold: threshold == null ? null : Number(threshold),
      });
      return stmts.getAlert.get(id) ?? null;
    },
    deleteAlert(id) { return stmts.deleteAlert.run(id).changes > 0; },
    saveAlertResult(id, { lastState = null, attemptAt = null, firedAt = null } = {}) {
      stmts.saveAlertResult.run({ id, lastState, attemptAt, firedAt });
    },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/db.test.js`
Expected: PASS — the existing db tests plus 8 new ones

- [ ] **Step 8: Commit**

```bash
git add db.js test/db.test.js
git commit -m "feat(db): add the alerts table, its CRUD, and cascade delete"
```

---

## Task 4: Email transport

**Goal:** `notifier.js` sends over SMTP when configured, logs a no-op when not, and never opens a socket in tests.

**Files:**
- Create: `notifier.js`
- Test: `test/notifier.test.js`

**Acceptance Criteria:**
- [ ] Missing `smtpHost` or `alertEmailTo` produces `configured: false` and a `send` resolving `{sent: false}` without throwing
- [ ] A configured notifier passes `from`/`to`/`subject`/`text` to the transport and resolves `{sent: true}`
- [ ] Port 465 sets `secure: true`; 587 sets `secure: false`
- [ ] `auth` is omitted entirely when `smtpUser` is blank
- [ ] A transport rejection propagates to the caller

**Verify:** `node --test test/notifier.test.js` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

Create `test/notifier.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../notifier.js';

const CFG = {
  smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'me@example.com',
  smtpPass: 'secret', smtpFrom: '', alertEmailTo: 'you@example.com',
};

// Captures what would have gone over the wire. No socket is ever opened.
function fakeTransport() {
  const sent = [];
  let opts = null;
  const factory = (o) => { opts = o; return { sendMail: async (m) => { sent.push(m); return { messageId: '1' }; } }; };
  return { factory, sent, options: () => opts };
}

test('unconfigured notifier is a no-op that does not throw', async () => {
  for (const cfg of [{ ...CFG, smtpHost: '' }, { ...CFG, alertEmailTo: '' }]) {
    const n = createNotifier(cfg, { transportFactory: () => { throw new Error('must not build a transport'); } });
    assert.equal(n.configured, false);
    const result = await n.send({ subject: 's', text: 't' });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'not-configured');
  }
});

test('configured notifier sends through the transport', async () => {
  const t = fakeTransport();
  const n = createNotifier(CFG, { transportFactory: t.factory });
  assert.equal(n.configured, true);

  const result = await n.send({ subject: 'hello', text: 'body' });
  assert.equal(result.sent, true);
  assert.equal(t.sent.length, 1);
  assert.deepEqual(t.sent[0], {
    from: 'me@example.com', to: 'you@example.com', subject: 'hello', text: 'body',
  });
});

test('smtpFrom overrides the user as the envelope From', async () => {
  const t = fakeTransport();
  const n = createNotifier({ ...CFG, smtpFrom: 'alerts@example.com' }, { transportFactory: t.factory });
  await n.send({ subject: 's', text: 't' });
  assert.equal(t.sent[0].from, 'alerts@example.com');
});

test('port 465 is implicit TLS, everything else is not', () => {
  const a = fakeTransport();
  createNotifier({ ...CFG, smtpPort: 465 }, { transportFactory: a.factory });
  assert.equal(a.options().secure, true);

  const b = fakeTransport();
  createNotifier({ ...CFG, smtpPort: 587 }, { transportFactory: b.factory });
  assert.equal(b.options().secure, false);
});

test('auth is omitted when no user is configured', () => {
  const t = fakeTransport();
  createNotifier({ ...CFG, smtpUser: '' }, { transportFactory: t.factory });
  assert.equal(t.options().auth, undefined);
});

test('a transport failure propagates', async () => {
  const n = createNotifier(CFG, {
    transportFactory: () => ({ sendMail: async () => { throw new Error('550 rejected'); } }),
  });
  await assert.rejects(() => n.send({ subject: 's', text: 't' }), /550 rejected/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/notifier.test.js`
Expected: FAIL — `Cannot find module '../notifier.js'`

- [ ] **Step 3: Create `notifier.js`**

```js
import nodemailer from 'nodemailer';

// Email transport behind a two-property interface — `configured` and `send` — so
// the runner never branches on whether mail is really set up, and the tests never
// open a socket.
//
// With no SMTP_HOST or no ALERT_EMAIL_TO this returns a logging no-op reporting
// `configured: false`: rules still evaluate and still advance their state, they
// just don't leave the machine. That keeps the app runnable with an empty .env,
// matching how DEFAULT_WALLET is already optional.
//
// `send` resolves `{sent}` rather than throwing on the unconfigured path, because
// "no mail was set up" is not a failure worth retrying. A real transport error DOES
// throw — that one is.
export function createNotifier(cfg, { transportFactory = nodemailer.createTransport } = {}) {
  if (!cfg.smtpHost || !cfg.alertEmailTo) {
    return {
      configured: false,
      async send({ subject }) {
        console.log(`[alerts] email not configured; would have sent: ${subject}`);
        return { sent: false, reason: 'not-configured' };
      },
    };
  }

  const transport = transportFactory({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    // 465 is implicit TLS from the first byte; 587 and friends open in the clear
    // and upgrade via STARTTLS, which nodemailer negotiates on its own.
    secure: cfg.smtpPort === 465,
    // Omitted entirely rather than passed empty — a local relay on port 25
    // typically wants no auth at all, and an empty credential pair is not the same
    // thing as none.
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
  });

  return {
    configured: true,
    async send({ subject, text }) {
      await transport.sendMail({
        from: cfg.smtpFrom || cfg.smtpUser,
        to: cfg.alertEmailTo,
        subject,
        text,
      });
      return { sent: true };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/notifier.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add notifier.js test/notifier.test.js
git commit -m "feat(alerts): add the email notifier with a no-op fallback"
```

---

## Task 5: The alert runner

**Goal:** `alert-runner.js` turns stream ticks and a backstop interval into evaluations, sends the emails, and persists each outcome.

**Files:**
- Create: `alert-runner.js`
- Test: `test/alert-runner.test.js`

**Acceptance Criteria:**
- [ ] `evaluateAddress` sends one email for a firing rule and persists `lastState: 1` with both timestamps
- [ ] A non-firing rule persists its `nextState` and no timestamps
- [ ] A send failure persists the rule's **existing** `last_state` plus `attemptAt`, so it retries
- [ ] An unconfigured notifier advances state but leaves `last_fired_at` null
- [ ] A throwing `assembleAccount` is caught — no rule state changes and no throw escapes
- [ ] `start()` watches every address with enabled rules exactly once, even across repeat calls
- [ ] The email subject and body carry the rule, the observed value, and the dashboard URL

**Verify:** `node --test test/alert-runner.test.js` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

Create `test/alert-runner.test.js`. Note that the debounce and interval are deliberately **not** exercised through real timers — `evaluateAddress` and `sweep` are called directly, so nothing here is timing-dependent.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAlertRunner } from '../alert-runner.js';

const NOW = 1_700_000_000_000;
const OPTS = { alertCooldownMs: 900000, alertDebounceMs: 5000, alertPollIntervalMs: 300000, dashboardUrl: 'http://localhost:3005' };

const PAYLOAD = {
  equity: 1000, marginUsed: 100, totalUnrealizedPnl: -50, openPositionsCount: 1,
  positions: [{ coin: 'BTC', size: 0.5, side: 'LONG', entryPrice: 60000, markPrice: 58000,
    liquidationPrice: 52200, leverage: 5, marginUsed: 5800, unrealizedPnl: -1000, roe: -16.67 }],
};

// Records every saveAlertResult call so the tests can assert on persistence.
function fakeDb(rules = []) {
  return {
    saved: [],
    listEnabledAlerts(address) { return rules.filter((r) => r.address === address); },
    alertAddresses() { return [...new Set(rules.map((r) => r.address))]; },
    saveAlertResult(id, result) { this.saved.push({ id, ...result }); },
  };
}

function fakeNotifier({ configured = true, fail = false } = {}) {
  const sent = [];
  return {
    configured, sent,
    async send(mail) {
      if (fail) throw new Error('smtp down');
      sent.push(mail);
      return { sent: configured };
    },
  };
}

const rule = (over = {}) => ({
  id: 1, address: '0xaaa', scope: 'account', coin: null, metric: 'equity',
  operator: 'below', threshold: 5000, enabled: 1,
  last_state: 0, last_attempt_at: null, last_fired_at: null, ...over,
});

const build = (rules, notifier, over = {}) => createAlertRunner({
  db: fakeDb(rules), stream: new EventEmitter(), notifier,
  opts: OPTS, now: () => NOW, assemble: async () => PAYLOAD, ...over,
});

test('a firing rule sends one email and records both timestamps', async () => {
  const notifier = fakeNotifier();
  const runner = build([rule()], notifier);
  await runner.evaluateAddress('0xaaa');

  assert.equal(notifier.sent.length, 1);
  assert.deepEqual(runner.db.saved, [{ id: 1, lastState: 1, attemptAt: NOW, firedAt: NOW }]);
});

test('the email carries the rule, the value, and the dashboard url', async () => {
  const notifier = fakeNotifier();
  const runner = build([rule({ scope: 'position', coin: 'BTC', metric: 'unrealizedPnl', threshold: -500 })], notifier);
  await runner.evaluateAddress('0xaaa');

  const mail = notifier.sent[0];
  assert.match(mail.subject, /BTC unrealized PnL below -\$500/);
  assert.match(mail.subject, /-\$1,000/);      // the observed value
  assert.match(mail.text, /0xaaa/);            // which wallet
  assert.match(mail.text, /http:\/\/localhost:3005/);
  assert.match(mail.text, /BTC LONG/);         // the position summary
});

test('an account-scope email summarizes the account', async () => {
  const notifier = fakeNotifier();
  const runner = build([rule()], notifier);
  await runner.evaluateAddress('0xaaa');
  assert.match(notifier.sent[0].text, /Equity: \$1,000/);
});

test('a non-firing rule persists state and no timestamps', async () => {
  const notifier = fakeNotifier();
  // equity 1000 is not above 5000 -> condition false.
  const runner = build([rule({ operator: 'above' })], notifier);
  await runner.evaluateAddress('0xaaa');

  assert.equal(notifier.sent.length, 0);
  assert.deepEqual(runner.db.saved, [{ id: 1, lastState: 0 }]);
});

test('a send failure keeps the old state so the rule retries', async () => {
  const notifier = fakeNotifier({ fail: true });
  const runner = build([rule({ last_state: 0 })], notifier);
  await runner.evaluateAddress('0xaaa');

  // last_state stays 0 -> the next pass past the cooldown fires again.
  // attemptAt advances -> that retry is throttled, not immediate.
  assert.deepEqual(runner.db.saved, [{ id: 1, lastState: 0, attemptAt: NOW }]);
});

test('an unconfigured notifier advances state but never claims it fired', async () => {
  const notifier = fakeNotifier({ configured: false });
  const runner = build([rule()], notifier);
  await runner.evaluateAddress('0xaaa');

  // firedAt stays null: last_fired_at must never assert an email that did not go out.
  assert.deepEqual(runner.db.saved, [{ id: 1, lastState: 1, attemptAt: NOW, firedAt: null }]);
});

test('an assembleAccount failure is caught and changes nothing', async () => {
  const notifier = fakeNotifier();
  const runner = build([rule()], notifier, { assemble: async () => { throw new Error('hyperliquid down'); } });
  await runner.evaluateAddress('0xaaa'); // must not reject

  assert.equal(notifier.sent.length, 0);
  assert.deepEqual(runner.db.saved, []);
});

test('an address with no enabled rules does no work', async () => {
  let assembled = 0;
  const runner = build([], fakeNotifier(), { assemble: async () => { assembled++; return PAYLOAD; } });
  await runner.evaluateAddress('0xzzz');
  assert.equal(assembled, 0);
});

test('start watches each alerting address exactly once', () => {
  const watched = [];
  const stream = Object.assign(new EventEmitter(), { watch: (a) => watched.push(a) });
  const runner = build([rule({ id: 1 }), rule({ id: 2 })], fakeNotifier(), { stream });

  runner.start();
  runner.watch('0xaaa');  // a newly created rule for an address already watched
  assert.deepEqual(watched, ['0xaaa']); // two rules, one subscription, no refcount leak

  runner.watch('0xbbb');
  assert.deepEqual(watched, ['0xaaa', '0xbbb']);
  runner.stop();
});

test('sweep evaluates every alerting address', async () => {
  const notifier = fakeNotifier();
  const runner = build([rule({ id: 1, address: '0xaaa' }), rule({ id: 2, address: '0xbbb' })], notifier);
  await runner.sweep();
  assert.deepEqual(runner.db.saved.map((s) => s.id), [1, 2]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/alert-runner.test.js`
Expected: FAIL — `Cannot find module '../alert-runner.js'`

- [ ] **Step 3: Create `alert-runner.js`**

```js
import { evaluateRules, describeRule, formatValue, METRICS } from './alerts.js';
import { assembleAccount } from './account.js';

// Builds the plain-text alert email. Kept module-level and pure so the runner body
// stays about scheduling rather than string assembly.
function buildEmail({ rule, value }, payload, ts, opts) {
  const meta = METRICS[rule.scope]?.[rule.metric];
  const desc = describeRule(rule);
  const subject = `[Hyperbal] ${desc} (now ${formatValue(value, meta?.unit)})`;

  const lines = [
    `Rule: ${desc}`,
    `Observed: ${formatValue(value, meta?.unit)}`,
    `Wallet: ${rule.address}`,
    `Time: ${new Date(ts).toISOString()}`,
    '',
  ];

  if (rule.scope === 'position') {
    const pos = (payload.positions || []).find((p) => p.coin === rule.coin);
    if (pos) {
      lines.push(
        `${pos.coin} ${pos.side} size ${pos.size} · entry ${formatValue(pos.entryPrice, 'usd')}`
        + ` · mark ${formatValue(pos.markPrice, 'usd')} · liq ${formatValue(pos.liquidationPrice, 'usd')}`
        + ` · uPnL ${formatValue(pos.unrealizedPnl, 'usd')}`,
      );
    }
  } else {
    lines.push(
      `Equity: ${formatValue(payload.equity, 'usd')}`
      + ` · unrealized PnL: ${formatValue(payload.totalUnrealizedPnl, 'usd')}`
      + ` · open positions: ${payload.openPositionsCount}`,
    );
  }

  lines.push('', opts.dashboardUrl);
  return { subject, text: lines.join('\n') };
}

// The only stateful piece of the alerts feature: it owns the debounce timers, the
// backstop interval, and the read -> evaluate -> send -> persist cycle.
//
// `now` and `assemble` are injectable so the tests control time and never touch
// the network.
export function createAlertRunner({ db, stream, notifier, opts = {}, now = Date.now, assemble = assembleAccount }) {
  const timers = new Map();   // address -> pending debounce timer
  const watched = new Set();  // addresses we hold a stream.watch reference for
  let pollTimer = null;
  let onAccount = null;

  // stream.watch/unwatch are ref-counted upstream, so calling watch twice for the
  // same address would leave a reference no unwatch ever balances. One rule or ten
  // for a wallet is still exactly one subscription held by the runner.
  function ensureWatched(address) {
    if (watched.has(address)) return;
    watched.add(address);
    stream?.watch(address);
  }

  async function evaluateAddress(address) {
    const rules = db.listEnabledAlerts(address);
    if (!rules.length) return;

    let payload;
    try {
      // webData2 carries main-dex state only, so the stream is a trigger and this
      // is the source: the same aggregated payload the dashboard renders, which is
      // the number the user was looking at when they set the threshold.
      payload = await assemble(address, db, opts);
    } catch (err) {
      // Hyperliquid unreachable. Log and return — this must never kill the
      // interval or break the debounce chain, and no rule state may move on the
      // strength of data we don't have.
      console.warn(`[alerts] skipping ${address}: ${err.message}`);
      return;
    }

    const ts = now();
    for (const decision of evaluateRules(rules, payload, ts, opts.alertCooldownMs)) {
      if (!decision.fire) {
        db.saveAlertResult(decision.rule.id, { lastState: decision.nextState });
        continue;
      }
      try {
        const result = await notifier.send(buildEmail(decision, payload, ts, opts));
        db.saveAlertResult(decision.rule.id, {
          lastState: 1,
          attemptAt: ts,
          // Only a real send advances last_fired_at. With mail unconfigured the
          // rule still advances (so the log doesn't repeat every tick) but the UI
          // must not claim an email that never left the machine.
          firedAt: result?.sent ? ts : null,
        });
      } catch (err) {
        // Leave last_state exactly as it was so the rule retries; last_attempt_at
        // throttles that retry to the cooldown cadence rather than every tick.
        console.warn(`[alerts] send failed for rule ${decision.rule.id}: ${err.message}`);
        db.saveAlertResult(decision.rule.id, { lastState: decision.rule.last_state ?? null, attemptAt: ts });
      }
    }
  }

  // Collapse a burst of stream ticks into one evaluation per address.
  function schedule(address) {
    if (timers.has(address)) return;
    const t = setTimeout(() => {
      timers.delete(address);
      evaluateAddress(address).catch((err) => console.warn(`[alerts] ${address}: ${err.message}`));
    }, opts.alertDebounceMs);
    t.unref?.();
    timers.set(address, t);
  }

  async function sweep() {
    for (const address of db.alertAddresses()) await evaluateAddress(address);
  }

  return {
    db, // exposed for tests; the runner itself always goes through the methods above
    evaluateAddress,
    sweep,
    watch: ensureWatched,

    start() {
      // A persistent webData2 subscription per alerting wallet is what makes alerts
      // fire with no browser open — the same thing stream.track() already does for
      // fills. Ref-counting means a browser watching the same wallet composes with
      // this reference rather than cancelling it.
      for (const address of db.alertAddresses()) ensureWatched(address);

      onAccount = ({ address }) => { if (address) schedule(address); };
      stream?.on('account', onAccount);

      // Backstop: the stream can stall without closing, and an alert that silently
      // stops working is worse than one that never existed.
      pollTimer = setInterval(() => {
        sweep().catch((err) => console.warn(`[alerts] sweep: ${err.message}`));
      }, opts.alertPollIntervalMs);
      pollTimer.unref?.();
    },

    stop() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      clearInterval(pollTimer);
      pollTimer = null;
      if (onAccount) stream?.off('account', onAccount);
      onAccount = null;
    },

    // Called when a wallet is deleted, so the runner releases its subscription.
    unwatch(address) {
      if (!watched.delete(address)) return;
      stream?.unwatch(address);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/alert-runner.test.js`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add alert-runner.js test/alert-runner.test.js
git commit -m "feat(alerts): add the stream-triggered alert runner"
```

---

## Task 6: HTTP routes

**Goal:** Five `/api/alerts` routes with validation that rejects every malformed rule shape.

**Files:**
- Modify: `server.js`
- Test: `test/server.test.js`

**Acceptance Criteria:**
- [ ] `GET /api/alerts` requires `address`; a missing or invalid one is a 400
- [ ] `GET` returns the rules, the metric whitelist, and `emailConfigured`
- [ ] `POST` rejects a bad address, scope, metric, wrong-scope metric, missing coin, bad operator, and non-finite threshold — each a 400
- [ ] `POST` for a wallet not on the watch list is a 400
- [ ] `PATCH` updates `enabled`/`threshold`, 404s an unknown id, 400s an empty patch
- [ ] `DELETE` removes a rule and 404s an unknown id
- [ ] `POST /api/alerts/test` returns 503 when mail is unconfigured

**Verify:** `node --test test/server.test.js` → all tests pass

**Steps:**

- [ ] **Step 1: Extend the test's `fakeDb` with alert methods**

In `test/server.test.js`, add to the object `fakeDb` returns (an in-memory stand-in for Task 3's SQL):

```js
    // --- alerts ---
    alerts: [],
    createAlert(rule) {
      const row = { id: this.alerts.length + 1, enabled: 1, last_state: null,
        last_attempt_at: null, last_fired_at: null, created_at: 1, ...rule };
      this.alerts.push(row);
      return row;
    },
    listAlerts(address) { return this.alerts.filter((a) => a.address === address); },
    listEnabledAlerts(address) { return this.alerts.filter((a) => a.address === address && a.enabled); },
    alertAddresses() { return [...new Set(this.alerts.filter((a) => a.enabled).map((a) => a.address))]; },
    updateAlert(id, patch) {
      const row = this.alerts.find((a) => a.id === id);
      if (!row) return null;
      if (patch.enabled != null) row.enabled = patch.enabled ? 1 : 0;
      if (patch.threshold != null) row.threshold = Number(patch.threshold);
      row.last_state = null;
      return row;
    },
    deleteAlert(id) {
      const i = this.alerts.findIndex((a) => a.id === id);
      if (i < 0) return false;
      this.alerts.splice(i, 1);
      return true;
    },
    saveAlertResult() {},
```

- [ ] **Step 2: Write the failing tests**

Append to `test/server.test.js`:

```js
const ADDR = '0x' + '3'.repeat(40);

// POST /api/wallets requires a live userRole lookup; this stub answers it so the
// alert tests can get a wallet onto the watch list.
const roleFetch = async () => ({ ok: true, json: async () => ({ role: 'user' }) });

async function withWallet(fn, overrides = {}) {
  await withServer({ fetchImpl: roleFetch, ...overrides }, async (base) => {
    await fetch(`${base}/api/wallets`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: ADDR }),
    });
    return fn(base);
  });
}

const postAlert = (base, body) => fetch(`${base}/api/alerts`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const VALID = { address: ADDR, scope: 'account', metric: 'equity', operator: 'below', threshold: 5000 };

test('GET /api/alerts requires a valid address', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/api/alerts`)).status, 400);
    assert.equal((await fetch(`${base}/api/alerts?address=nope`)).status, 400);
  });
});

test('GET /api/alerts returns rules, the whitelist, and mail status', async () => {
  await withWallet(async (base) => {
    await postAlert(base, VALID);
    const res = await fetch(`${base}/api/alerts?address=${ADDR}`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.alerts.length, 1);
    assert.equal(json.alerts[0].metric, 'equity');
    // The UI builds its dropdowns from this, so it cannot drift from the server.
    assert.ok(json.metrics.account.equity);
    assert.ok(json.metrics.position.markPrice);
    assert.equal(json.emailConfigured, false);
  });
});

test('POST /api/alerts creates a rule', async () => {
  await withWallet(async (base) => {
    const res = await postAlert(base, VALID);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.alert.scope, 'account');
    assert.equal(json.alert.threshold, 5000);
    assert.equal(json.alert.coin, null);
  });
});

test('POST /api/alerts creates a position rule with its coin', async () => {
  await withWallet(async (base) => {
    const res = await postAlert(base, { ...VALID, scope: 'position', coin: 'BTC', metric: 'liquidationDistancePct', threshold: 5 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).alert.coin, 'BTC');
  });
});

test('POST /api/alerts rejects every malformed shape', async () => {
  await withWallet(async (base) => {
    const bad = [
      { ...VALID, address: 'nope' },
      { ...VALID, scope: 'galaxy' },
      { ...VALID, metric: 'nonsense' },
      { ...VALID, metric: 'markPrice' },                          // position metric, account scope
      { ...VALID, scope: 'position', metric: 'markPrice' },       // position scope, no coin
      { ...VALID, operator: 'equals' },
      { ...VALID, threshold: 'abc' },
      { ...VALID, threshold: Infinity },
    ];
    for (const body of bad) {
      const res = await postAlert(base, body);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.ok((await res.json()).error);
    }
  });
});

test('POST /api/alerts refuses a wallet that is not on the watch list', async () => {
  await withServer({}, async (base) => {
    const res = await postAlert(base, VALID);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /watch list/);
  });
});

test('PATCH /api/alerts/:id updates and validates', async () => {
  await withWallet(async (base) => {
    const { alert } = await (await postAlert(base, VALID)).json();
    const patch = (body) => fetch(`${base}/api/alerts/${alert.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    assert.equal((await (await patch({ threshold: 7000 })).json()).alert.threshold, 7000);
    assert.equal((await (await patch({ enabled: false })).json()).alert.enabled, 0);
    assert.equal((await patch({})).status, 400);              // nothing to update
    assert.equal((await patch({ threshold: 'abc' })).status, 400);

    const missing = await fetch(`${base}/api/alerts/9999`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threshold: 1 }),
    });
    assert.equal(missing.status, 404);
  });
});

test('DELETE /api/alerts/:id removes a rule', async () => {
  await withWallet(async (base) => {
    const { alert } = await (await postAlert(base, VALID)).json();
    assert.equal((await fetch(`${base}/api/alerts/${alert.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${base}/api/alerts/${alert.id}`, { method: 'DELETE' })).status, 404);
  });
});

test('POST /api/alerts/test reports unconfigured mail rather than pretending', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/alerts/test`, { method: 'POST' });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /not configured/i);
  });
});

test('POST /api/alerts/test sends through a configured notifier', async () => {
  const sent = [];
  const notifier = { configured: true, send: async (m) => { sent.push(m); return { sent: true }; } };
  await withServer({ notifier }, async (base) => {
    const res = await fetch(`${base}/api/alerts/test`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/server.test.js`
Expected: FAIL — the alert requests 404 because no route matches

- [ ] **Step 4: Import the whitelist in `server.js`**

Add near the other imports:

```js
import { METRICS, SCOPES, OPERATORS, isValidMetric } from './alerts.js';
```

- [ ] **Step 5: Accept `notifier` and `runner` in `createApp`**

Replace the destructure at the top of `createApp`:

```js
  // A default no-op notifier keeps every existing test — and a server started
  // without alerts wired — working unchanged.
  const {
    stream = null,
    runner = null,
    notifier = { configured: false, send: async () => ({ sent: false, reason: 'not-configured' }) },
    ...rest
  } = overrides;
```

- [ ] **Step 6: Add the validator and the routes**

Add above `createApp`:

```js
// Validates an incoming alert rule. Returns { rule } or { error }; every rejection
// names the offending field, matching how the export and wallet routes explain
// themselves.
function validateAlert(body) {
  const address = String(body?.address || '').toLowerCase();
  if (!isValidAddress(address)) return { error: 'Invalid wallet address. Expected 0x followed by 40 hex characters.' };

  const scope = String(body?.scope || '');
  if (!SCOPES.includes(scope)) return { error: `Unknown scope "${scope}". Expected "account" or "position".` };

  const metric = String(body?.metric || '');
  if (!isValidMetric(scope, metric)) return { error: `Metric "${metric}" is not available for scope "${scope}".` };

  const operator = String(body?.operator || '');
  if (!OPERATORS.includes(operator)) return { error: `Unknown operator "${operator}". Expected "above" or "below".` };

  // Number('') is 0, so an empty threshold would otherwise sail through as a
  // legitimate zero — a rule the user never meant to write.
  const raw = body?.threshold;
  const threshold = raw === '' || raw == null ? NaN : Number(raw);
  if (!Number.isFinite(threshold)) return { error: 'Threshold must be a finite number.' };

  const coin = scope === 'position' ? String(body?.coin || '').trim() : null;
  if (scope === 'position' && !coin) return { error: 'A position alert requires a coin.' };

  return { rule: { address, scope, coin, metric, operator, threshold } };
}
```

Add inside `createApp`, after the `/api/agents/:address` route:

```js
  app.get('/api/alerts', (req, res) => {
    const address = String(req.query.address || '').toLowerCase();
    // Required, deliberately: without it this would list every wallet's rules.
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    // METRICS rides along so the UI builds its dropdowns from the same whitelist
    // the validator enforces, rather than a hand-copied duplicate that can drift.
    res.json({ address, alerts: db.listAlerts(address), metrics: METRICS, emailConfigured: notifier.configured });
  });

  app.post('/api/alerts', (req, res) => {
    const { error, rule } = validateAlert(req.body);
    if (error) return res.status(400).json({ error });
    // Alerts are evaluated per watched wallet, so a rule on an unwatched address
    // would never fire — refuse it rather than store something inert.
    if (!db.hasWallet(rule.address)) {
      return res.status(400).json({ error: 'Add the wallet to the watch list before creating alerts for it.' });
    }
    const alert = db.createAlert(rule);
    // A brand new alerting wallet needs its webData2 subscription now, not at the
    // next restart.
    runner?.watch(rule.address);
    res.json({ alert });
  });

  app.patch('/api/alerts/:id', (req, res) => {
    const id = toSafeInt(req.params.id, NaN);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid alert id.' });

    const body = req.body || {};
    const patch = {};
    if ('enabled' in body) patch.enabled = body.enabled ? 1 : 0;
    if ('threshold' in body) {
      const threshold = body.threshold === '' || body.threshold == null ? NaN : Number(body.threshold);
      if (!Number.isFinite(threshold)) return res.status(400).json({ error: 'Threshold must be a finite number.' });
      patch.threshold = threshold;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update. Send "enabled" or "threshold".' });

    const alert = db.updateAlert(id, patch);
    if (!alert) return res.status(404).json({ error: 'No such alert.' });
    res.json({ alert });
  });

  app.delete('/api/alerts/:id', (req, res) => {
    const id = toSafeInt(req.params.id, NaN);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid alert id.' });
    if (!db.deleteAlert(id)) return res.status(404).json({ error: 'No such alert.' });
    res.json({ ok: true });
  });

  app.post('/api/alerts/test', async (req, res) => {
    // 503 rather than a cheerful 200: a test button that succeeds without sending
    // anything is worse than no button.
    if (!notifier.configured) {
      return res.status(503).json({ error: 'Email is not configured. Set SMTP_HOST and ALERT_EMAIL_TO in .env.' });
    }
    try {
      await notifier.send({ subject: '[Hyperbal] Test alert', text: 'Email is configured correctly.' });
      res.json({ sent: true });
    } catch (err) {
      res.status(502).json({ error: `Failed to send: ${err.message}` });
    }
  });
```

> **Route order matters:** `/api/alerts/test` is a POST and `/api/alerts/:id` is a PATCH/DELETE, so they cannot collide. Keep it that way — adding a `POST /api/alerts/:id` later would shadow the test route.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/server.test.js`
Expected: PASS — the existing server tests plus 10 new ones

- [ ] **Step 8: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat(api): add the alerts CRUD and test-email routes"
```

---

## Task 7: Bootstrap wiring

**Goal:** The real server builds a notifier and a runner, starts it, and releases a deleted wallet's subscription.

**Files:**
- Modify: `server.js`

**Acceptance Criteria:**
- [ ] `createNotifier(config)` and `createAlertRunner(...)` are built in the bootstrap block and passed to `createApp`
- [ ] `runner.start()` runs after `stream.start()`
- [ ] Deleting a wallet calls `runner.unwatch(address)` alongside the existing `stream.untrack(address)`
- [ ] `npm test` passes and `npm start` boots with an empty `.env`

**Verify:** `npm test` → all tests pass; then `npm start` → logs `Dashboard on http://localhost:3005` with no unhandled rejection

**Steps:**

- [ ] **Step 1: Import the two factories in `server.js`**

```js
import { createNotifier } from './notifier.js';
import { createAlertRunner } from './alert-runner.js';
```

- [ ] **Step 2: Release the subscription on wallet delete**

In the existing `app.delete('/api/wallets/:address', ...)` handler, alongside `stream?.untrack(address)`:

```js
    db.deleteWallet(address);
    // Without this the live userFills subscription re-inserts the fills we just purged.
    stream?.untrack(address);
    // The alerts cascade away with the wallet, so the runner's webData2 reference
    // for it is now paying for data nothing reads.
    runner?.unwatch(address);
    res.json({ wallets: db.listWallets() });
```

- [ ] **Step 3: Rewrite the bootstrap block at the bottom of `server.js`**

```js
if (process.argv[1]?.endsWith('server.js')) {
  const db = openDb(config.dbPath);
  const stream = createStream({ wsUrl: config.hlWsUrl });
  const notifier = createNotifier(config);
  const runner = createAlertRunner({
    db,
    stream,
    notifier,
    opts: {
      apiUrl: config.hlApiUrl,
      snapshotMinIntervalMs: config.snapshotMinIntervalMs,
      alertCooldownMs: config.alertCooldownMs,
      alertDebounceMs: config.alertDebounceMs,
      alertPollIntervalMs: config.alertPollIntervalMs,
      dashboardUrl: config.dashboardUrl,
    },
  });
  const app = createApp(db, { stream, notifier, runner });
  const server = app.listen(config.port, () => console.log(`Dashboard on http://localhost:${config.port}`));

  stream.start();
  // Re-track all previously-watched wallets so fills accumulate even before a browser connects.
  for (const w of db.listWallets()) stream.track(w.address);
  // Same idea for account state: one webData2 subscription per alerting wallet, so
  // alerts fire with no browser open.
  runner.start();

  if (!notifier.configured) {
    console.log('[alerts] SMTP is not configured — alerts will evaluate and log, but not email.');
  }

  attachWsHub(server, { db, stream });
}
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, every test file

- [ ] **Step 5: Boot the server**

Run: `npm start`
Expected: `Dashboard on http://localhost:3005` followed by the `[alerts] SMTP is not configured` notice (assuming an empty `.env`). Stop it with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(alerts): wire the notifier and runner into the server bootstrap"
```

---

## Task 8: API client, markup, and styles

**Goal:** The browser can reach the five routes, and the panel has a place to render.

**Files:**
- Modify: `public/js/api.js`
- Modify: `public/index.html`
- Modify: `public/styles.css`

**Acceptance Criteria:**
- [ ] `api.js` exports `getAlerts`, `createAlert`, `updateAlert`, `deleteAlert`, `testAlertEmail`
- [ ] `index.html` has the Alerts panel with every id the panel module reads
- [ ] The page still renders with no console errors

**Verify:** `npm start`, open `http://localhost:3005` → the Alerts panel is visible and the browser console is clean

**Steps:**

- [ ] **Step 1: Add the route wrappers to `public/js/api.js`**

Append (the existing `json()` helper hardcodes POST, so PATCH is spelled out):

```js
export const getAlerts = (address) => request(`/api/alerts?address=${address}`);
export const createAlert = (rule) => request('/api/alerts', json(rule));
export const updateAlert = (id, patch) => request(`/api/alerts/${id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(patch),
});
export const deleteAlert = (id) => request(`/api/alerts/${id}`, { method: 'DELETE' });
export const testAlertEmail = () => request('/api/alerts/test', { method: 'POST' });
```

- [ ] **Step 2: Add the panel to `public/index.html`**

Insert immediately before the `<section class="panel">` holding `Connected Agent Wallets`:

```html
    <section class="panel">
      <div class="panel-head">
        <h2>Alerts</h2>
        <button id="alertTestBtn" title="Send a test email to check your SMTP settings">✉ Send test email</button>
      </div>
      <div id="alertEmailWarn" class="export-note hidden"></div>
      <div id="alertList" class="alerts"></div>
      <div id="alertsEmpty" class="empty hidden"><span class="empty-icon">◎</span>No alerts yet.</div>
      <div class="alert-add">
        <select id="alertScope" aria-label="Alert scope">
          <option value="account">Account</option>
          <option value="position">Position</option>
        </select>
        <select id="alertCoin" class="hidden" aria-label="Coin"></select>
        <select id="alertMetric" aria-label="Metric"></select>
        <select id="alertOperator" aria-label="Operator">
          <option value="above">above</option>
          <option value="below">below</option>
        </select>
        <input id="alertThreshold" type="number" step="any" placeholder="Threshold" aria-label="Threshold" />
        <button id="alertAddBtn">Add alert</button>
      </div>
      <p class="export-note">
        Alerts are evaluated on the server every time your account changes, and swept
        every few minutes as a backstop — they fire whether or not this page is open.
        Each rule emails once per crossing and re-arms when the condition goes false.
      </p>
    </section>
```

- [ ] **Step 3: Add the styles to `public/styles.css`**

Append:

```css
/* --- Alerts panel --- */
.alerts{display:flex;flex-direction:column;gap:var(--sp-2)}
.alert-row{display:flex;align-items:center;gap:var(--sp-3);
  padding:var(--sp-3);border:1px solid var(--line);border-radius:var(--r-sm)}
/* A paused rule stays legible but reads as inactive at a glance. */
.alert-row.is-off{opacity:.55}
/* min-width:0 is what actually lets the ellipsis engage inside a flex child. */
.alert-desc{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.alert-meta{font-size:var(--fs-sm);color:var(--muted);white-space:nowrap}
.alert-add{display:flex;flex-wrap:wrap;gap:var(--sp-2);align-items:center;
  margin-top:var(--sp-4);padding-top:var(--sp-4);border-top:1px solid var(--line)}
.alert-add input[type="number"]{width:140px}
```

Every value here is an existing `:root` token — this file's `:root` defines `--line`
(not `--border`), `--muted`, the `--sp-*` scale, `--fs-sm`, and `--r-sm`. A literal
hex color outside `:root` is flagged by the repo's own check, so do not add one.

- [ ] **Step 4: Verify the page renders**

Run: `npm start`, open `http://localhost:3005`
Expected: an Alerts panel with an empty list and the add-rule row. The metric dropdown is empty until Task 9 populates it. No console errors.

- [ ] **Step 5: Commit**

```bash
git add public/js/api.js public/index.html public/styles.css
git commit -m "feat(ui): add the alerts panel markup, styles, and API client"
```

---

## Task 9: The alerts panel

**Goal:** The panel lists, creates, toggles, and deletes rules, and reports unconfigured email honestly.

**Files:**
- Create: `public/js/alerts.js`
- Modify: `public/js/app.js`

**Acceptance Criteria:**
- [ ] The metric dropdown is built from the server's `metrics`, filtered by the selected scope
- [ ] Choosing `position` reveals a coin dropdown populated from the wallet's open positions
- [ ] Adding, toggling, and deleting a rule each reload the list
- [ ] A failed request surfaces a toast and leaves the list as it was
- [ ] Unconfigured email shows the banner and disables the test button
- [ ] Switching wallets clears the previous wallet's rules before the new ones arrive

**Verify:** `npm start`, add an account-equity rule and a position rule, toggle and delete each → the list reflects every change and the console stays clean

**Steps:**

- [ ] **Step 1: Create `public/js/alerts.js`**

```js
import { fmtTime, esc } from './format.js';
import * as api from './api.js';
import { toast, errMsg, confirmDialog } from './feedback.js';

const $ = (id) => document.getElementById(id);

let address = null;
let metrics = null;       // the server's whitelist; the dropdowns are built from it
let positions = [];       // current open positions, for the coin dropdown
let rows = [];
let emailConfigured = false;
let loadSeq = 0;          // generation guard — same mySeq/want pattern as fills.js

// Mirrors alerts.js describeRule() on the server. Duplicated deliberately and
// kept small: sending the phrasing over the wire per row would mean the list
// couldn't render until a second request landed.
function describe(a) {
  const meta = metrics?.[a.scope]?.[a.metric];
  const name = meta ? meta.label : a.metric;
  const subject = a.scope === 'position' ? `${a.coin} ${name}` : name;
  return `${subject} ${a.operator} ${formatThreshold(a.threshold, meta?.unit)}`;
}

function formatThreshold(v, unit) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (unit === 'usd') return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (unit === 'pct') return `${v}%`;
  if (unit === 'x') return `${v}×`;
  return String(v);
}

function statusText(a) {
  if (!a.enabled) return 'paused';
  const fired = a.last_fired_at ? `last fired ${fmtTime(a.last_fired_at)}` : 'never fired';
  // last_state === null means the metric could not be resolved — usually a rule on
  // a position that is currently closed. Saying "armed" there would overstate it.
  return a.last_state == null ? `waiting for data · ${fired}` : `armed · ${fired}`;
}

function paint() {
  const list = $('alertList');
  list.innerHTML = '';
  $('alertsEmpty').classList.toggle('hidden', rows.length > 0);

  for (const a of rows) {
    const row = document.createElement('div');
    row.className = 'alert-row' + (a.enabled ? '' : ' is-off');
    row.innerHTML = `
      <span class="alert-desc">${esc(describe(a))}</span>
      <span class="alert-meta">${esc(statusText(a))}</span>
      <button class="btn" data-act="toggle">${a.enabled ? 'Pause' : 'Resume'}</button>
      <button class="btn btn-danger" data-act="delete" aria-label="Delete alert">×</button>`;
    row.querySelector('[data-act="toggle"]').addEventListener('click', () => toggle(a));
    row.querySelector('[data-act="delete"]').addEventListener('click', () => remove(a));
    list.appendChild(row);
  }

  const warn = $('alertEmailWarn');
  warn.classList.toggle('hidden', emailConfigured);
  warn.textContent = 'Email is not configured — alerts will be recorded but not sent. Set SMTP_HOST and ALERT_EMAIL_TO in .env.';
  $('alertTestBtn').disabled = !emailConfigured;
}

// Rebuild the metric dropdown for the selected scope, and show the coin dropdown
// only when it is meaningful.
function syncForm() {
  const scope = $('alertScope').value;
  const metricSel = $('alertMetric');
  metricSel.innerHTML = '';
  for (const [name, meta] of Object.entries(metrics?.[scope] || {})) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = meta.label;
    metricSel.appendChild(opt);
  }

  const coinSel = $('alertCoin');
  coinSel.classList.toggle('hidden', scope !== 'position');
  if (scope !== 'position') return;

  coinSel.innerHTML = '';
  if (!positions.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No open positions';
    coinSel.appendChild(opt);
    return;
  }
  for (const p of positions) {
    const opt = document.createElement('option');
    opt.value = p.coin;
    opt.textContent = p.coin;
    coinSel.appendChild(opt);
  }
}

export async function load() {
  if (!address) { rows = []; paint(); return; }
  const want = address;
  const mySeq = ++loadSeq;
  try {
    const data = await api.getAlerts(want);
    // Stale-response guard: a wallet switch mid-flight must not paint the previous
    // wallet's rules over the new one's.
    if (mySeq !== loadSeq || want !== address) return;
    rows = data.alerts;
    metrics = data.metrics;
    emailConfigured = data.emailConfigured;
    paint();
    syncForm();
  } catch (err) {
    if (mySeq !== loadSeq || want !== address) return;
    toast("Couldn't load alerts: " + errMsg(err), 'error');
  }
}

async function add() {
  if (!address) return;
  const scope = $('alertScope').value;
  const coin = $('alertCoin').value;
  if (scope === 'position' && !coin) { toast('This wallet has no open positions to alert on.', 'error'); return; }

  const btn = $('alertAddBtn');
  btn.disabled = true;
  try {
    await api.createAlert({
      address, scope, coin: scope === 'position' ? coin : null,
      metric: $('alertMetric').value,
      operator: $('alertOperator').value,
      // Sent as a string; the server does the finite check and reports the reason.
      threshold: $('alertThreshold').value,
    });
    $('alertThreshold').value = '';
    await load();
  } catch (err) {
    toast("Couldn't add alert: " + errMsg(err), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function toggle(a) {
  try {
    await api.updateAlert(a.id, { enabled: !a.enabled });
    await load();
  } catch (err) {
    toast("Couldn't update alert: " + errMsg(err), 'error');
  }
}

async function remove(a) {
  const ok = await confirmDialog({
    title: 'Delete this alert?',
    body: describe(a),
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  try {
    await api.deleteAlert(a.id);
    await load();
  } catch (err) {
    toast("Couldn't delete alert: " + errMsg(err), 'error');
  }
}

// Called on every account refresh so the coin dropdown tracks what is actually held.
export function setPositions(next) {
  positions = next || [];
  if (metrics) syncForm();
}

export function setAddress(next) {
  address = next;
  // Otherwise the previous wallet's rules stay on screen, mislabelled, for the
  // whole round trip — same reasoning as fills.setAddress().
  rows = [];
  paint();
}

export function reset() {
  address = null;
  rows = [];
  positions = [];
  paint();
}

export function mount() {
  $('alertScope').addEventListener('change', syncForm);
  $('alertAddBtn').addEventListener('click', add);
  $('alertTestBtn').addEventListener('click', async () => {
    const btn = $('alertTestBtn');
    btn.disabled = true;
    try {
      await api.testAlertEmail();
      toast('Test email sent.', 'info');
    } catch (err) {
      toast("Couldn't send test email: " + errMsg(err), 'error');
    } finally {
      btn.disabled = !emailConfigured;
    }
  });
}
```

- [ ] **Step 2: Wire the panel into `public/js/app.js`**

Add the import alongside the others:

```js
import * as alertsPanel from './alerts.js';
```

In `refresh()`, after `account.render(data);`:

```js
      account.render(data);
      alertsPanel.setPositions(data.positions || []);
```

In `resetDashboard()`, alongside the other panel resets:

```js
  chartPanel.reset();
  alertsPanel.reset();
```

In `selectAddress()`, alongside the other `setAddress` calls:

```js
  chartPanel.setAddress(address);
  alertsPanel.setAddress(address);
```

…and after `await exportsPanel.loadPeriods();`:

```js
  await alertsPanel.load();
```

In `init()`, alongside the other mounts:

```js
  wallets.mount({ onSelect: selectAddress, onEmpty: resetDashboard });
  alertsPanel.mount();
```

- [ ] **Step 3: Verify by hand**

Run: `npm start`, open `http://localhost:3005` with a wallet selected.

Check each of these:
1. The Alerts panel shows the "Email is not configured" banner and a disabled test button (with an empty `.env`).
2. Scope `Account` → the metric dropdown lists four metrics; no coin dropdown.
3. Scope `Position` → the coin dropdown appears listing the wallet's open positions; the metric dropdown lists nine metrics.
4. Add `account equity below 999999999` → it appears as `armed · never fired`.
5. Pause it → the row dims and reads `paused`. Resume it → back to `armed`.
6. Delete it → the confirm dialog names the rule; confirming removes the row.
7. Add a rule with a blank threshold → a toast reads `Threshold must be a finite number.` and no row is added.
8. Switch wallets → the list clears immediately, then repopulates for the new wallet.

- [ ] **Step 4: Commit**

```bash
git add public/js/alerts.js public/js/app.js
git commit -m "feat(ui): add the alerts panel"
```

---

## Task 10: Documentation

**Goal:** The README describes the feature, its configuration, and its honest limits.

**Files:**
- Modify: `README.md`

**Acceptance Criteria:**
- [ ] Features section mentions alerts
- [ ] Configure section documents all ten new env vars
- [ ] Project structure lists the four new modules
- [ ] Limitations names the main-dex trigger, the cooldown, and the single recipient
- [ ] Manual verification checklist covers the alerts panel

**Verify:** `npm test` → all tests pass; read the README top to bottom for contradictions

**Steps:**

- [ ] **Step 1: Add to the Features section**

```markdown
- **Account alerts by email.** Threshold rules over account and position metrics —
  equity, unrealized PnL, mark price, ROE, leverage, and distance to liquidation.
  Evaluated on the server whether or not a browser is open, emailed once per
  crossing, and automatically re-armed when the condition goes false.
```

- [ ] **Step 2: Add to the Configure section**

```markdown
### Alerts and email

All of these are optional. With `SMTP_HOST` or `ALERT_EMAIL_TO` unset, alerts still
evaluate and log — they simply are not emailed, and the dashboard says so.

| Variable | Default | Meaning |
|---|---|---|
| `SMTP_HOST` | — | SMTP server hostname |
| `SMTP_PORT` | `587` | SMTP port. `465` uses implicit TLS; anything else uses STARTTLS |
| `SMTP_USER` | — | SMTP username. Omit for a relay that needs no auth |
| `SMTP_PASS` | — | SMTP password or app password |
| `SMTP_FROM` | `SMTP_USER` | Envelope From address |
| `ALERT_EMAIL_TO` | — | Where alerts are delivered |
| `ALERT_COOLDOWN_MS` | `900000` | Quiet period between sends for one rule (15 min) |
| `ALERT_POLL_INTERVAL_MS` | `300000` | Backstop sweep, in case the websocket stalls (5 min) |
| `ALERT_DEBOUNCE_MS` | `5000` | Debounce on websocket-triggered evaluations |
| `DASHBOARD_URL` | `http://localhost:$PORT` | Link target in the alert email |

For Gmail, use an [app password](https://support.google.com/accounts/answer/185833)
with `SMTP_HOST=smtp.gmail.com` and `SMTP_PORT=587` — a normal account password will
be rejected. `.env` is gitignored, so credentials stay out of the repository.

Use **Send test email** in the Alerts panel to confirm the settings before relying
on them.
```

- [ ] **Step 3: Add to the Project structure section**

```markdown
- `alerts.js` — pure alert logic: the metric whitelist, metric resolution, and the
  fire/no-fire decision. No database, clock, or network.
- `alert-runner.js` — subscribes to the account stream, debounces it, re-fetches the
  aggregated account, evaluates the rules, sends, and persists the outcome.
- `notifier.js` — email transport. SMTP via nodemailer, or a logging no-op when
  unconfigured.
- `public/js/alerts.js` — the alerts panel.
```

- [ ] **Step 4: Add to the Limitations section**

```markdown
- **Alerts are triggered by the main-dex feed.** The `webData2` subscription that
  wakes the evaluator carries main-dex state only, so a change confined to a builder
  dex may not trigger an immediate evaluation. The values compared are always the
  full aggregated ones — the evaluator re-fetches across every dex before deciding —
  and the 5-minute backstop sweep catches anything the trigger missed.
- **One recipient, one cooldown.** `ALERT_EMAIL_TO` is global and so is
  `ALERT_COOLDOWN_MS`; there are no per-rule overrides.
- **A rule fires once per crossing.** It re-arms when the condition goes false. If
  the condition is true continuously for a week, that is one email, not a reminder
  stream.
- **No firing history.** Each rule records only when it last fired, not a log of
  every firing.
- **Alerts are not a stop-loss.** They are a notification about data this dashboard
  observed; delivery is best-effort and the app is read-only. Never rely on one to
  manage risk on its own.
```

- [ ] **Step 5: Add to the Manual verification checklist**

```markdown
### Alerts

- [ ] With no SMTP configured, the panel shows the "Email is not configured" banner
      and the test button is disabled
- [ ] With SMTP configured, **Send test email** delivers a message
- [ ] Adding an account rule that is already true delivers one email within about a
      minute, and does not deliver a second on the next tick
- [ ] Pausing a rule stops it firing; resuming re-arms it
- [ ] Deleting the wallet removes its alerts
- [ ] Stopping and restarting the server keeps the rules and keeps them firing
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, every test file

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: describe account alerts and their configuration"
```

---

## Definition of done

- [ ] `npm test` passes with the new `test/alerts.test.js`, `test/notifier.test.js`, and `test/alert-runner.test.js` alongside the existing suite
- [ ] `npm start` boots with an empty `.env` and logs the unconfigured-email notice
- [ ] A rule created in the UI survives a server restart and still fires
- [ ] Deleting a wallet removes its alerts and releases its subscription
- [ ] No test opens a socket or sends mail
