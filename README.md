# Hyperliquid PnL Dashboard

A lightweight, self-hosted web dashboard that shows **live** Hyperliquid account
performance — equity, unrealized PnL, realized PnL, and open positions — for any
**public wallet address**. Dark, premium trading-dashboard UI. Real-time updates
over WebSocket, with a local SQLite store for history and cumulative realized PnL.

> ⚠️ **Read-only & safe.** This app only ever needs a **public wallet address**.
> It never asks for, accepts, or stores private keys or seed phrases, and it never
> places trades. **Never enter a private key or seed phrase into any field.**

---

## Features

- **Live updates** via Hyperliquid's public WebSocket (`webData2` + `userFills`),
  relayed through the backend to your browser. Falls back to REST polling (every
  30s) automatically if the socket drops, and reconnects.
- **Summary cards:** Account Equity, Total Unrealized PnL, Total Realized PnL
  (cumulative), Open Positions count (with a long/short split). Each card carries
  a 20px sparkline and a 24-hour delta — the delta is always 24h, independent of
  whatever range the chart below is showing.
- **Positions table:** Coin, Side, Size, Entry Price, Mark Price, Liquidation
  Price, Leverage, Margin Used, Unrealized PnL, ROE %.
- **Equity / PnL history chart** — hand-drawn on a `<canvas>` (no chart library),
  with dollar and date axes, gridlines, a gradient area fill, a crosshair that
  snaps to the nearest snapshot with a value/timestamp tooltip, a pinned
  last-value pill, and 24h / 7d / 30d / All range selection with a
  change-over-range readout. Gaps in the data (snapshots taken before PnL
  capture, or before the dashboard was running) render as gaps, not as a drop to
  zero. Sparse ranges say how few snapshots they contain rather than drawing a
  confident line through three points.
- **Watched wallets** — a switcher in the header opens a popover listing every
  saved wallet, with an add field and a per-wallet delete (confirmed, since
  deleting also purges that wallet's stored history — see Limitations).
- **Agent wallet recognition** — paste a Hyperliquid agent (API) wallet address and
  it automatically resolves to the master account it signs for (agent wallets hold
  no funds), with a badge showing the relationship. A **Connected Agent Wallets**
  panel lists the agents authorized on the viewed account (name, address, expiry).
- **All perp dexs in one view** — positions and equity are aggregated across
  Hyperliquid's main perp dex **and** HIP-3 builder-deployed dexs (e.g. an
  `xyz:SP500` short on the "XYZ" dex), each labeled with its collateral
  (USDC / USDT0 / USDH / USDE).
- **Cumulative realized PnL** — accumulated by deduping observed trade fills, so it
  keeps growing beyond Hyperliquid's limited recent-fills window.
- **Trade history** — a paginated table of every fill this dashboard has observed
  (time, coin, direction, size, price, fee, realized PnL), with a **closes only**
  filter. New fills append live. Side/direction render as colored chips, and its
  empty state offers an inline **Sync full history** button.
- **Funding payments** — captured alongside fills and included in exports. On perps
  these are a real cash flow, often more numerous than the trades themselves.
- **CSV export for tax** — download a full transaction record for a calendar year
  or all time, with each trade linked to its transaction on the Hyperliquid
  explorer. A Koinly-shaped file is also offered.
- **Sync full history** — pulls everything Hyperliquid still serves via
  `userFillsByTime` and `userFunding`, filling in direction, builder fees, and
  transaction hashes on rows recorded before those were captured. Idempotent —
  safe to re-run.
- **Account alerts by email.** Threshold rules over account and position metrics —
  equity, unrealized PnL, mark price, ROE, leverage, and distance to liquidation.
  Evaluated on the server whether or not a browser is open, emailed once per
  crossing, and automatically re-armed when the condition goes false.
- Shimmer loading skeletons, toasts for non-blocking failures, a focus-trapped
  confirm dialog (no `window.confirm()`), and a persistent inline error region
  for failures that leave the page unusable. Positive/negative PnL coloring.
- Responsive (desktop + mobile): tables scroll horizontally within their panel
  with the first column pinned, and the wallet popover becomes a bottom sheet
  on narrow screens.

## Tech stack

Vanilla HTML/CSS/JS frontend, split into native ES modules with no build step
(no frameworks, no bundler, no chart library). Node.js + Express backend.
`better-sqlite3` for persistence, `ws` for WebSockets, `dotenv` for config,
`nodemailer` for alert email.

## Requirements

- **Node.js 18+** (developed/tested on Node 24). Node 18+ provides global `fetch`,
  and `better-sqlite3` ships prebuilt binaries so no C++ build tools are needed.

## Install

```bash
npm install
```

## Configure

Copy the example env file and edit as needed (all values have sensible defaults):

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | Port the dashboard listens on. |
| `HL_API_URL` | `https://api.hyperliquid.xyz/info` | Hyperliquid REST info endpoint. |
| `HL_WS_URL` | `wss://api.hyperliquid.xyz/ws` | Hyperliquid WebSocket endpoint. |
| `DEFAULT_WALLET` | *(empty)* | Optional public address to pre-load in the UI. |
| `DB_PATH` | `./data/hyperliquid.db` | SQLite database file location. |
| `SNAPSHOT_MIN_INTERVAL_MS` | `60000` | Minimum spacing between equity snapshots per wallet (limits DB growth). |

### Configuring the wallet address

You can set the wallet **two ways** (no address is hardcoded anywhere):

1. **Environment:** set `DEFAULT_WALLET=0x...` to pre-load a wallet on startup.
2. **In the UI:** open the wallet switcher in the header and type a `0x…`
   address into its **Add a wallet** field. Saved wallets appear in the
   switcher's popover list and persist across restarts; delete one with its
   **✕** (this also erases its stored history — see Limitations).

To point at **testnet**, set `HL_API_URL=https://api.hyperliquid-testnet.xyz/info`
and `HL_WS_URL=wss://api.hyperliquid-testnet.xyz/ws`.

### Alerts and email

All of these are optional. With `SMTP_HOST` or `ALERT_EMAIL_TO` unset, alerts still
evaluate and log — they simply are not emailed, and the dashboard says so.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SMTP_HOST` | *(empty)* | SMTP server hostname. |
| `SMTP_PORT` | `587` | SMTP port. `465` uses implicit TLS; anything else uses STARTTLS. |
| `SMTP_USER` | *(empty)* | SMTP username. Omit for a relay that needs no auth. |
| `SMTP_PASS` | *(empty)* | SMTP password or app password. |
| `SMTP_FROM` | `SMTP_USER` | Envelope From address. |
| `ALERT_EMAIL_TO` | *(empty)* | Where alerts are delivered. |
| `ALERT_COOLDOWN_MS` | `900000` | Quiet period between sends for one rule (15 min). |
| `ALERT_POLL_INTERVAL_MS` | `300000` | Backstop sweep, in case the websocket stalls (5 min). |
| `ALERT_DEBOUNCE_MS` | `5000` | Debounce on websocket-triggered evaluations. |
| `DASHBOARD_URL` | `http://localhost:$PORT` | Link target in the alert email. |

For Gmail, use an [app password](https://support.google.com/accounts/answer/185833)
with `SMTP_HOST=smtp.gmail.com` and `SMTP_PORT=587` — a normal account password will
be rejected. `.env` is gitignored, so credentials stay out of the repository.

Use **Send test email** in the Alerts panel to confirm the settings before relying
on them.

## Run

```bash
npm start
```

Then open <http://localhost:3000>. Add a wallet address via the wallet switcher
in the header (or set `DEFAULT_WALLET`) and the dashboard will populate and
update live.

## Test

```bash
npm test
```

Runs the unit tests (config, DB layer, normalizers/validation, account assembly,
the WebSocket stream, CSV export, the alert evaluator, runner, and email
notifier, plus the frontend formatters and chart geometry) via Node's built-in
test runner. No test opens a socket or sends mail.

### Manual verification checklist

The automated suite covers logic and geometry, not rendered pixels or browser
focus behavior. Run `npm start` and check these by hand after any UI change:

- Live WebSocket updates land in the cards and prepend to Trade History; the
  status badge shows Live, and stopping the server flips it to Polling.
- Chart: gridlines align with their y-axis labels; the crosshair snaps to the
  nearest snapshot and its tooltip flips to the left when hovering near the
  right edge; the pinned last-value pill hides itself when the tooltip would
  otherwise cover it; the PnL series renders gaps (not a drop to zero) where
  snapshots predate PnL capture.
- Range pills (24h/7d/30d/All): clicking one refetches and redraws only the
  chart and its change readout — the card deltas do not move.
- The Equity/PnL toggle updates both the chart and the change readout.
- Trade History paging, the closes-only filter, and the page clamp (page to
  the end, then Sync) all behave.
- Click **Sync full history** twice, then open the period picker — the year
  options must not duplicate.
- Switch wallets A→B→A, then open the period picker — it lists only the
  current wallet's years, not both wallets' merged.
- Adding a wallet, switching wallets, and deleting the last wallet all work.
- Delete a wallet that is **not** currently selected — the dashboard on
  screen must not change.
- Wallet popover: Escape, an outside click, and Tab-out of its last control
  all close it, and focus returns sensibly (to the switcher, or wherever the
  user's own tab order was headed).
- Both CSV downloads fire, and the period picker lists years correctly.
- Agent badge and Connected Agent Wallets panel render.
- Layout holds at 1440 / 768 / 375px with no horizontal scroll on the page
  itself. At 375px specifically: tables scroll inside their own panel with
  the first column pinned, and the wallet popover is a bottom sheet.
- OS "reduce motion" disables the loading shimmer, the status dot's pulse,
  and transitions.
- Sticky table headers keep a visible bottom border while the table scrolls
  under them (the tables use `border-collapse:collapse`, which can drop a
  sticky header's border — this one can only be checked in a browser).

#### Alerts

- With no SMTP configured, the panel shows the "Email is not configured" banner
  and the test button is disabled.
- With SMTP configured, **Send test email** delivers a message.
- Adding an account rule that is already true delivers one email within about a
  minute, and does not deliver a second on the next tick.
- Pausing a rule stops it firing; resuming re-arms it.
- Deleting the wallet removes its alerts.
- Stopping and restarting the server keeps the rules and keeps them firing.

## Hyperliquid endpoints used

All public, read-only:

- **REST** `POST {HL_API_URL}`
  - `{ "type": "clearinghouseState", "user": "0x…" }` — equity, margin, and open
    positions (entry price, size, leverage, liquidation price, unrealized PnL, ROE).
  - `{ "type": "userFills", "user": "0x…" }` — recent trade fills (used for realized PnL).
  - `{ "type": "userRole", "user": "0x…" }` — detects whether an address is an
    agent wallet and, if so, returns its master account (used to resolve agent
    addresses on entry).
  - `{ "type": "extraAgents", "user": "0x…" }` — the agent/API wallets approved on
    an account (name, address, valid-until), shown in the Connected Agent Wallets panel.
  - `{ "type": "perpDexs" }` — the list of perp dexs (main + builder-deployed).
  - `{ "type": "clearinghouseState", "user": "0x…", "dex": "<name>" }` — per-dex
    account state (the main dex omits `dex`).
  - `{ "type": "meta", "dex": "<name>" }` + `{ "type": "spotMeta" }` — resolve each
    dex's collateral token to a symbol.
  - `{ "type": "userFillsByTime", "user": "0x…", "startTime": … }` — paginated
    historical fills, used by **Sync full history**.
  - `{ "type": "userFunding", "user": "0x…", "startTime": … }` — the funding
    payment ledger.
- **WebSocket** `{HL_WS_URL}`
  - `webData2` — live account state (positions, equity, unrealized PnL).
  - `userFills` — live trade fills as they happen.

## How the data is normalized

- All numeric fields from Hyperliquid arrive as **strings** and are parsed to
  numbers (invalid/missing → `null` rather than crashing).
- **Mark price** is not returned directly; it's derived as
  `positionValue / |size|`.
- **Side** is inferred from the sign of the position size (`szi`): ≥ 0 → LONG,
  < 0 → SHORT. Zero-size (flat) positions are dropped.
- **ROE %** comes from `returnOnEquity × 100`.
- **Realized PnL** is computed by summing `closedPnl` across trade fills. Fills are
  deduped by Hyperliquid trade id (`tid`) in SQLite, so the cumulative total keeps
  accumulating over time.
- **Builder fees are separate from exchange fees.** Hyperliquid returns both `fee`
  and `builderFee`; both are stored and both appear in exports. An absent
  `builderFee` is stored as unknown rather than zero, so a later sync can fill it
  in.
- **Funding** is flattened from `userFunding`'s nested `delta` and deduped on
  `(address, timestamp, coin)`, since the endpoint returns no unique id per entry.

## Limitations

- **Cumulative realized PnL is "since this dashboard began observing your fills" —
  unless you run Sync full history.** Hyperliquid only returns a limited window of
  recent fills via the live `userFills` stream and REST calls, so by default the
  total only grows from first observation onward. The **Sync full history** button
  pages back through `userFillsByTime` and `userFunding` and can recover fills and
  funding from before you added the wallet, but only as far back as Hyperliquid
  still serves them — anything that aged out of that window first is gone for
  good. It is still **not** guaranteed to be a complete lifetime realized PnL.
- **Nothing is stored for a wallet that isn't on your saved list.** Fills, equity
  snapshots, and the wallet entry itself are only written for wallets added via
  the **Add** field (or `DEFAULT_WALLET`). Viewing an address the dashboard
  doesn't have saved shows live data but persists none of it — this is what keeps
  a deleted wallet deleted when a background poll or a second browser tab is
  still asking for it.
- **Equity/PnL history snapshots accrue only for saved wallets you actively view**
  (and are throttled to one per `SNAPSHOT_MIN_INTERVAL_MS`). The chart fills in
  over time as you use the dashboard; it won't show history from before you ran it.
- **Agent wallets resolve to the master account** and have no separate PnL — all
  trading through an agent accrues to the master. The dashboard never approves,
  revokes, or names agents (read-only); it only reads the `userRole`/`extraAgents`
  relationships.
- **Builder-dex positions refresh within ~30s** (REST poll), while main-dex
  changes update near-instantly. All dex equities are summed as ≈USD (each
  collateral is a dollar-pegged stablecoin).
- **Only Hyperliquid is shown.** Perps that aren't on Hyperliquid — e.g. the
  USDT-margined pairs in some wallets' "Perps" tabs (Bitget's own engine) — are a
  different venue and cannot appear here.
- **Deleting a wallet erases its stored data.** Removing a wallet purges its
  observed fills, funding, equity snapshots, and alert rules along with the
  wallet entry.
  Re-adding it and running **Sync full history** recovers whatever Hyperliquid
  still serves, but equity snapshots are gone for good (they're a local
  observation, not something Hyperliquid replays), and any fills or funding that
  had already aged out of Hyperliquid's window before deletion are gone too. Note
  that a wallet set via `DEFAULT_WALLET` is re-added (empty) on the next page
  load — clear the env var to stop that.
- **The export is transaction data, not tax advice.** It reports what happened:
  fills, fees, funding, and realized PnL, with a link to each on-chain trade. How
  perpetuals are characterised, which lots match, and what is reportable are
  decisions for you or your preparer. Cost-basis lot matching is not attempted,
  and deposits, withdrawals, and transfers are not included.
- **Export coverage is bounded by what Hyperliquid still serves.** **Sync full
  history** pulls everything currently available, but anything that aged out of
  Hyperliquid's window before your first sync cannot be recovered. Reconcile the
  totals against your own records — every trade row carries an explorer link so
  you can.
- **The Koinly file is best-effort.** Koinly's generic CSV assumes you acquired
  and disposed of a held asset; a perp fill is neither, so realized PnL is mapped
  as a bare USDC inflow or outflow with no cost basis. The detailed CSV is the
  file to hand a preparer. Verify the Koinly file before importing.
- **Funding rows carry no explorer link.** Funding settles as an internal ledger
  event rather than an on-chain transaction, so Hyperliquid reports a zero-filled
  hash for it. Trade rows all carry a working link.
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
- **A position alert watches one perp dex.** Positions are aggregated across every
  Hyperliquid perp dex, and a coin can be held on more than one. A rule identifies
  its position by coin alone and resolves against the first match, so for a coin
  held on two dexes it watches one leg and ignores the other. Account-scope rules
  (equity, total unrealized PnL) are unaffected — those are true aggregates.
- **Alerts are not a stop-loss.** They are a notification about data this dashboard
  observed; delivery is best-effort and the app is read-only. Never rely on one to
  manage risk on its own.
- Single-user, no authentication — intended to run locally on your own machine.

## Security

- The app is **read-only**: it only *reads* public account data from Hyperliquid
  and never performs any trading or signing action.
- It needs **only a public wallet address**. **Never** enter a private key or seed
  phrase — no part of this app asks for one, and you should never give one to any
  dashboard.
- The only data written is to your **own local SQLite file** (watched wallets,
  equity snapshots, observed fills, alert rules). `.env`, `node_modules/`, and
  `data/` are gitignored.
- **Configuring alert email is the one thing that sends your data off the
  machine.** With SMTP set up, a firing alert transmits the rule, the observed
  value, and a one-line account or position summary — equity, unrealized PnL,
  entry, mark, and liquidation price — through your SMTP provider to
  `ALERT_EMAIL_TO`, in plain text. Nothing is sent anywhere until you set
  `SMTP_HOST` and `ALERT_EMAIL_TO`, and the credentials live only in your
  gitignored `.env`. Use a provider you trust with that.

## Project structure

```
server.js          Express app: static serving, REST routes, starts HTTP + WS
config.js          Env config (dotenv) with defaults
db.js              SQLite: schema + wallet/snapshot/fill queries
hyperliquid.js     HL REST client + normalizers + address validation
account.js         Assembles the normalized account payload (REST path)
backfill.js        Paginated history sync (fills + funding) from Hyperliquid
export.js          CSV generation: detailed and Koinly row builders
hl-stream.js       Upstream WebSocket client to Hyperliquid
ws-server.js       Browser-facing WebSocket hub (/ws)
alerts.js          Pure alert logic: metric whitelist, resolution, fire/no-fire
alert-runner.js    Subscribes to the account stream, debounces, evaluates rules,
                   sends, and persists the outcome
notifier.js        Email transport: SMTP via nodemailer, or a logging no-op
public/
  index.html       Dashboard markup
  styles.css       Dark theme + design tokens
  js/
    app.js         Entry point: state, WebSocket, polling, wiring
    api.js         Route definitions (the only file holding URL strings)
    format.js      Pure formatters
    chart-math.js  Pure geometry (ticks, scales, nearest point)
    chart.js       Canvas chart: axes, crosshair, sparklines
    chart-panel.js Chart panel state: range/series selection, fetch, readout
    account.js     Summary cards + positions table
    fills.js       Trade history table
    wallets.js     Wallet switcher popover
    exports.js     Export panel + history sync
    feedback.js    Toasts, skeletons, confirm dialog
    alerts.js      Alerts panel: rule list, add/pause/delete, send test email
test/              Unit tests (node:test)
data/              SQLite DB (created at runtime, gitignored)
```
