# Account Alerts with Email Notification — Design

**Date:** 2026-08-19
**Status:** Approved

## Problem

The dashboard shows account state only while a browser tab is open. Everything it
knows — equity, per-position unrealized PnL, distance to liquidation — is
knowledge that expires the moment the tab closes. A position moving against you
overnight is exactly the case the dashboard is best positioned to catch and
currently cannot.

There is also a structural gap behind this. The `webData2` subscription that
carries account state is created only when a browser client sends a `watch`
message (`ws-server.js`), and torn down when that client disconnects. Persistent
server-side awareness exists for fills (`stream.track()` is re-armed for every
saved wallet at boot in `server.js`) but not for account state.

## Goals

1. Let the user define threshold rules over account and position metrics.
2. Evaluate them server-side, continuously, with no browser open.
3. Email when a rule crosses, at most once per crossing.

## Non-goals

- **Coin price alerts for coins not held.** Alerts are account-scoped. A rule can
  watch the mark price of a coin the wallet has a position in, but this is not a
  general market alerting tool and does not subscribe to `allMids`.
- A firing-history table. `last_fired_at` on the rule is the whole record.
- Per-rule cooldowns or per-rule recipients. One global cooldown, one recipient.
- SMS, webhook, push, or any channel other than email.
- Alerts on realized PnL or on individual fills.
- One-shot (self-disabling) rules.
- Anything multi-user. This remains a single-operator, self-hosted app.

---

## Rule model

A rule is a whitelisted metric, an operator, and a threshold, scoped to a wallet
and optionally to a coin. It is a general model — any listed metric can pair with
any operator — but not an expression language: `metric` is validated against a
table and never interpolated into SQL or evaluated as code.

### `alerts` schema

```sql
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  scope TEXT NOT NULL,           -- 'account' | 'position'
  coin TEXT,                     -- NULL for account scope, required for position scope
  metric TEXT NOT NULL,
  operator TEXT NOT NULL,        -- 'above' | 'below'
  threshold REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_state INTEGER,            -- 0 | 1 | NULL(unresolvable) — condition at last evaluation
  last_attempt_at INTEGER,       -- throttles retries
  last_fired_at INTEGER,         -- last successful send; shown in the UI
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_addr ON alerts(address);
```

Added through the existing `openDb` schema block. No migration of prior data is
needed — the table is new.

### Metric whitelist

Defined in `alerts.js` as a table keyed by scope. Every metric reads off the
payload `assembleAccount()` already returns.

**Account scope** — `equity`, `marginUsed`, `totalUnrealizedPnl`,
`openPositionsCount`.

**Position scope** — `markPrice`, `entryPrice`, `liquidationPrice`,
`unrealizedPnl`, `roe`, `leverage`, `size`, `marginUsed`.

**Derived** (position scope, computed by the evaluator, not present on the
payload) — `liquidationDistancePct` = `|markPrice − liquidationPrice| / markPrice
× 100`. This is the liquidation-proximity alert expressed inside the general
model rather than as a special case. It resolves to unavailable when either input
is null, which is the normal state for a position with no liquidation price.

### Operators

`above` → `value > threshold`. `below` → `value < threshold`. Nothing else.

---

## Firing semantics

Fire when all three hold:

1. the condition is currently true, **and**
2. `last_state != 1` — the condition was not already true at the previous
   evaluation, **and**
3. `now − last_attempt_at ≥ ALERT_COOLDOWN_MS` (or `last_attempt_at` is NULL).

These comparisons happen in JavaScript inside `evaluateRules`, not in SQL, so
`last_state = NULL` compares as "not 1" rather than propagating NULL the way a
SQL predicate would. The database is a store here, never a rules engine.

Condition 2 is the edge detection: a value that sits above its threshold for an
hour produces one email, not one per tick. Condition 3 is the quiet period that
keeps a value oscillating across its threshold from producing a burst.

Three behaviours follow from this, each deliberate:

**Cooldown defers, it does not drop.** When the condition is true but the cooldown
window blocks the send, `last_state` is left at `0`. The next evaluation after the
window expires sees a still-true condition against a false prior state and fires.
A suppressed alert is late, never lost. If the condition goes false in the
meantime, `last_state` was already `0` and nothing fires — correct, because the
crossing resolved itself.

**Send failure retries.** A failed send updates `last_attempt_at` but not
`last_state`. The rule therefore retries on the next evaluation past the cooldown,
rather than either hammering the SMTP server every tick or silently swallowing the
alert. `last_fired_at` advances only on a successful send, so the UI's "last
fired" never claims an email that did not go out.

**An unresolvable metric parks the rule.** If the position is closed, the coin is
no longer held, or the metric is null on the payload, `last_state` is set to
`NULL` and nothing fires. Re-opening that position with the condition already true
will then fire, since `NULL != 1`. This is intended: a newly opened position that
is immediately past its threshold is a fresh crossing worth knowing about.

---

## Evaluation pipeline

### Trigger and backstop

`webData2` carries **main-dex state only** — this is why `ws-server.js` currently
treats the event as a "re-fetch over REST" nudge rather than as data. Evaluating
rules directly against it would compare an equity figure that excludes builder-dex
positions against a threshold the user set while looking at the aggregated number
the dashboard displays.

So the stream is a trigger, not a source:

1. `stream.on('account', {address})` schedules a **debounced (5s)** evaluation for
   that address, collapsing bursts of ticks into one pass.
2. The evaluation calls `assembleAccount(address, db, opts)` — the same aggregated
   payload the dashboard renders — and evaluates against that.
3. A **5-minute `unref`'d interval** sweeps every address with enabled rules, so
   alerts still fire if the stream stalls silently.

At boot the runner calls `stream.watch(address)` once for every wallet holding at
least one enabled rule. `watch`/`unwatch` are ref-counted in `hl-stream.js`, so a
browser watching the same wallet composes correctly and releases without
disturbing the runner's reference.

Every evaluation is wrapped in `try/catch`. Hyperliquid being unreachable logs and
returns; it must never kill the interval or the debounce chain.

### Consequences

**Alerts bind to saved wallets.** `deleteWalletTxn` gains an alerts purge, so
deleting a wallet removes its rules in the same transaction that removes its
fills, snapshots, and funding.

**Snapshot history becomes continuous for alerting wallets.** Because the backstop
calls `assembleAccount()`, a wallet with enabled rules now records equity
snapshots with no browser open — gaps in the equity chart close. Growth stays
bounded by the existing `SNAPSHOT_MIN_INTERVAL_MS` throttle in
`insertSnapshotThrottled`.

---

## Modules

Four new files, each with a single responsibility, following the existing split
where `export.js` is pure functions and `server.js` does the I/O around them.

**`alerts.js` — pure.** The metric whitelist, `resolveMetric(payload, rule)`, and
`evaluateRules(rules, payload, now, cooldownMs)` returning
`[{rule, value, fire, nextState}]`. No database, no clock, no network; `now`
arrives as a parameter. This is where the firing semantics live and where the
tests concentrate.

**`notifier.js` — transport.** `createNotifier(config)` returns
`{ send({to, subject, text}), configured }`. Nodemailer over SMTP when the env
vars are present; a logging no-op when they are not, with `configured: false` so
the UI can say so. One interface, two implementations, and a fake in tests.

**`alert-runner.js` — the stateful piece.** Owns the debounce timers, the backstop
interval, and the read → evaluate → send → persist cycle. Constructed as
`createAlertRunner({ db, stream, notifier, opts })` with an injectable `now()` so
its tests control time.

**`public/js/alerts.js` — the panel.** Matches the existing one-module-per-panel
layout in `public/js/`.

`db.js` gains the table and its CRUD statements. `server.js` gains the routes.
`config.js` gains the new env vars.

---

## HTTP API

Following the existing validate-then-act shape.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/alerts?address=0x…` | list rules for a wallet (`address` required) |
| POST | `/api/alerts` | create a rule |
| PATCH | `/api/alerts/:id` | toggle `enabled`, edit `threshold` |
| DELETE | `/api/alerts/:id` | remove a rule |
| POST | `/api/alerts/test` | send a test email to verify SMTP config |

`GET` requires `address`; a missing or invalid one is a `400`, never a listing of
every wallet's rules.

Creation returns `400` with a specific message for: an invalid address, a `scope`
outside the set, a `metric` not in the whitelist, a `metric` that belongs to a
different scope than the one given, a `position` rule with no `coin`, an
`operator` outside the set, and a non-finite `threshold`.

`POST /api/alerts/test` returns `503` when the notifier is unconfigured, so the
button reports the real reason rather than appearing to succeed.

---

## Email

Subject carries the whole alert, so it is readable from a phone lock screen:

```
[Hyperbal] BTC unrealized PnL below -$500 (now -$612.40)
```

Body: wallet label and address, the rule in words, the observed value, the
timestamp, a one-line summary of the relevant position, and a link to the
dashboard (`DASHBOARD_URL`). Plain text — no HTML, no tracking, no images.

---

## Configuration

All optional, all in `.env` (already gitignored), all documented in
`.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `SMTP_HOST` | — | SMTP server |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_USER` | — | username |
| `SMTP_PASS` | — | password or app password |
| `SMTP_FROM` | `SMTP_USER` | envelope From |
| `ALERT_EMAIL_TO` | — | recipient |
| `ALERT_COOLDOWN_MS` | `900000` (15 min) | quiet period between sends per rule |
| `ALERT_POLL_INTERVAL_MS` | `300000` (5 min) | backstop sweep interval |
| `ALERT_DEBOUNCE_MS` | `5000` | stream-tick debounce |
| `DASHBOARD_URL` | `http://localhost:${PORT}` | link target in the email body |

**With no SMTP configuration the feature still works** — rules evaluate, state
advances, firings are logged — it simply does not email. This matches how
`DEFAULT_WALLET` is already optional and keeps the app runnable with an empty
`.env`.

`nodemailer` is the one new dependency. It has zero transitive dependencies,
which is why it suits a project deliberately holding at four.

---

## UI

A panel scoped to the currently selected wallet, listing its rules:

```
BTC unrealized PnL below -$500        armed · last fired 2h ago   [on] [×]
Account equity below $5,000           armed · never fired         [on] [×]
```

The add form is progressive: choosing a scope filters the metric dropdown to that
scope's metrics; choosing `position` reveals a coin dropdown populated from the
wallet's actual open positions. Threshold is a number input labelled with the
metric's unit (USD, %, ×).

When the notifier is unconfigured the panel shows a banner — *Email not
configured; alerts will be recorded but not sent* — alongside the test-email
button.

---

## Testing

The evaluator holds all the subtle behaviour, so it holds most of the tests
(`test/alerts.test.js`, pure, no fixtures beyond a payload literal):

- every whitelisted metric resolves from a representative payload
- both operators, including the boundary (`value == threshold` fires neither)
- edge detection: a condition true across consecutive evaluations fires once
- cooldown defers: blocked while inside the window, fires once past it, with
  `last_state` unchanged in between
- send failure advances `last_attempt_at` but not `last_state` or `last_fired_at`
- unresolvable metric sets `last_state = NULL`; the subsequent true condition
  fires
- `liquidationDistancePct` arithmetic, including null inputs
- an unknown metric, and a metric used under the wrong scope, are both rejected

`test/alert-runner.test.js` uses a fake stream, a fake notifier, and an injected
clock to assert the sequence end to end: one email on a crossing, none on the
next tick, a second only after the condition goes false and re-crosses.

`db.test.js` covers alerts CRUD and the cascade delete with its wallet.
`server.test.js` covers each `400` path and the `503` from the test endpoint.

No test opens a socket or sends mail.
