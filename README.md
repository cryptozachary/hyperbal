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
  (cumulative), Open Positions count.
- **Positions table:** Coin, Side, Size, Entry Price, Mark Price, Liquidation
  Price, Leverage, Margin Used, Unrealized PnL, ROE %.
- **Equity / PnL history chart** — hand-drawn on a `<canvas>` (no chart library),
  backed by snapshots persisted in SQLite.
- **Watched wallets** — add/remove wallets; they persist across restarts.
- **Agent wallet recognition** — paste a Hyperliquid agent (API) wallet address and
  it automatically resolves to the master account it signs for (agent wallets hold
  no funds), with a badge showing the relationship. A **Connected Agent Wallets**
  panel lists the agents authorized on the viewed account (name, address, expiry).
- **Cumulative realized PnL** — accumulated by deduping observed trade fills, so it
  keeps growing beyond Hyperliquid's limited recent-fills window.
- Clear loading, empty, and error states. Positive/negative PnL coloring.
- Responsive (desktop + mobile).

## Tech stack

Vanilla HTML/CSS/JS frontend (no frameworks, no chart library). Node.js + Express
backend. `better-sqlite3` for persistence, `ws` for WebSockets, `dotenv` for config.

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
2. **In the UI:** type a `0x…` address into the **Add** field. Saved wallets
   appear in the dropdown and persist across restarts; remove with the ✕ button.

To point at **testnet**, set `HL_API_URL=https://api.hyperliquid-testnet.xyz/info`
and `HL_WS_URL=wss://api.hyperliquid-testnet.xyz/ws`.

## Run

```bash
npm start
```

Then open <http://localhost:3000>. Add a wallet address (or set `DEFAULT_WALLET`)
and the dashboard will populate and update live.

## Test

```bash
npm test
```

Runs the unit tests (config, DB layer, normalizers/validation, account assembly,
and the WebSocket stream) via Node's built-in test runner.

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

## Limitations

- **Cumulative realized PnL is "since this dashboard began observing your fills."**
  Hyperliquid only returns a limited window of recent fills. This app stores every
  fill it sees (via the live `userFills` stream and REST calls) and dedupes them,
  so the total grows over time — but fills that occurred **before** you first ran
  the dashboard, or that scrolled out of Hyperliquid's window before being
  observed, are not included. It is **not** a complete lifetime realized PnL.
- **Equity/PnL history snapshots accrue only for wallets you actively view** (and
  are throttled to one per `SNAPSHOT_MIN_INTERVAL_MS`). The chart fills in over
  time as you use the dashboard; it won't show history from before you ran it.
- **Agent wallets resolve to the master account** and have no separate PnL — all
  trading through an agent accrues to the master. The dashboard never approves,
  revokes, or names agents (read-only); it only reads the `userRole`/`extraAgents`
  relationships.
- Single-user, no authentication — intended to run locally on your own machine.

## Security

- The app is **read-only**: it only *reads* public account data from Hyperliquid
  and never performs any trading or signing action.
- It needs **only a public wallet address**. **Never** enter a private key or seed
  phrase — no part of this app asks for one, and you should never give one to any
  dashboard.
- The only data written is to your **own local SQLite file** (watched wallets,
  equity snapshots, observed fills). `.env`, `node_modules/`, and `data/` are
  gitignored.

## Project structure

```
server.js          Express app: static serving, REST routes, starts HTTP + WS
config.js          Env config (dotenv) with defaults
db.js              SQLite: schema + wallet/snapshot/fill queries
hyperliquid.js     HL REST client + normalizers + address validation
account.js         Assembles the normalized account payload (REST path)
hl-stream.js       Upstream WebSocket client to Hyperliquid
ws-server.js       Browser-facing WebSocket hub (/ws)
public/
  index.html       Dashboard markup
  styles.css       Dark theme
  app.js           Client logic: REST load, live WS, fallback polling, chart
test/              Unit tests (node:test)
data/              SQLite DB (created at runtime, gitignored)
```
