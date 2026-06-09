# Live Hyperliquid PnL Dashboard — Design Spec

**Date:** 2026-06-09
**Status:** Approved

## 1. Purpose

A lightweight, self-hosted web dashboard that displays Hyperliquid account
performance (PnL, equity, open positions) for a **public wallet address**, in
real time. Dark, premium trading-dashboard UI. Read-only: it never touches
private keys or places trades. It persists data locally (SQLite) so it can show
historical trends and accumulate realized PnL beyond Hyperliquid's limited
fills window.

## 2. Tech Stack & Constraints

- **Backend:** Node.js (18+), Express.
- **Frontend:** vanilla HTML/CSS/JS only. No React/Vue/Angular/Tailwind, no
  frontend frameworks, no chart library (chart is hand-drawn on `<canvas>`).
- **Persistence:** SQLite via `better-sqlite3` (single file, prebuilt binaries
  install cleanly on Windows without build tools).
- **Realtime:** WebSocket via the `ws` package — both upstream (to Hyperliquid)
  and downstream (backend → browser).
- **Config:** `dotenv`. No wallet addresses, API URLs, or secrets hardcoded.
- **Node 18+** required: global `fetch` (no `node-fetch` dependency) and
  `better-sqlite3` prebuilt binary availability.

Dependencies: `express`, `better-sqlite3`, `ws`, `dotenv`.

## 3. Architecture & Data Flow

```
Hyperliquid WS  ──(webData2, userFills)──▶  Backend  ──normalize──▶  SQLite (fills, snapshots, wallets)
                                              │
                                    browser WS (/ws) push
                                              ▼
                                      Browser (live cards, table, chart)
REST /api/account ──▶ instant initial paint + fallback when WS drops
```

- The browser never talks to Hyperliquid directly. The backend is the single
  normalization point and the only writer to the DB.
- Initial paint and fallback come from REST; live updates come over WebSocket.

## 4. Backend Modules

Kept small and single-purpose so each file is easy to reason about and test.

| Module           | Responsibility |
|------------------|----------------|
| `server.js`      | Express app, static file serving from `public/`, REST routes, wires DB + stream + ws-hub, starts HTTP + WS servers. |
| `hyperliquid.js` | REST calls to the HL `info` endpoint (`clearinghouseState`, `userFills`) and the **shared normalizers** used by both REST and WS paths. |
| `hl-stream.js`   | Upstream WS client to Hyperliquid: subscription management, ping keep-alive, reconnect-with-backoff + re-subscribe. Emits normalized events. |
| `ws-server.js`   | Browser-facing WS hub at `/ws`: client registry, `watch` handling, broadcast to clients interested in an address. |
| `db.js`          | Opens SQLite, runs schema/migrations, exposes query functions. |

## 5. Hyperliquid API Usage

All REST calls: `POST {HL_API_URL}` (default `https://api.hyperliquid.xyz/info`),
JSON body. WS: `{HL_WS_URL}` (default `wss://api.hyperliquid.xyz/ws`).

**REST:**
- `{type:"clearinghouseState", user}` → `marginSummary.accountValue` (equity),
  `totalMarginUsed`, `assetPositions[].position` (coin, `szi` size, `entryPx`,
  `positionValue`, `unrealizedPnl`, `returnOnEquity`, `leverage`,
  `liquidationPx`, `marginUsed`).
- `{type:"userFills", user}` → array of fills with `tid`, `coin`, `closedPnl`,
  `fee`, `px`, `sz`, `side`, `time`.

**WS subscriptions:**
- `{method:"subscribe", subscription:{type:"webData2", user}}` → rich live
  payload including clearinghouseState (positions, equity, uPnL). Subscribed for
  the **currently-viewed** wallet (on demand).
- `{method:"subscribe", subscription:{type:"userFills", user}}` → live fills.
  Subscribed for **every watched wallet** (persistent) so the DB keeps
  accumulating realized PnL even with no browser open.
- Keep-alive: send `{method:"ping"}` (~30s); server replies `pong`.

## 6. Data Normalization

`clearinghouseState` → normalized account object:

- `equity` = `marginSummary.accountValue` (float).
- `marginUsed` = `marginSummary.totalMarginUsed`.
- For each `assetPositions[i].position`:
  - `coin`, `size` = `szi` (signed; sign → side).
  - `side` = `szi >= 0 ? "LONG" : "SHORT"`.
  - `entryPrice` = `entryPx`.
  - **`markPrice` = `positionValue / |szi|`** (derived; HL doesn't return mark
    price in this payload). Guard against divide-by-zero.
  - `liquidationPrice` = `liquidationPx` (may be null).
  - `leverage` = `leverage.value` (+ `leverage.type` cross/isolated).
  - `marginUsed`, `unrealizedPnl`, `roe` = `returnOnEquity` (×100 for %).
- `totalUnrealizedPnl` = sum of position `unrealizedPnl`.
- `openPositionsCount` = positions with non-zero size.

`userFills` → ingested into `fills` table (`INSERT OR IGNORE` on `tid`).
**Cumulative realized PnL** = `SUM(closed_pnl)` over stored fills for the
address. A separate **recent-window realized PnL** (sum over the live fills
payload) is returned for reference/labeling.

All numeric strings from the API are parsed to numbers; missing/unexpected
fields normalize to `null` rather than throwing.

## 7. SQLite Schema

File at `DB_PATH` (default `./data/hyperliquid.db`).

```sql
CREATE TABLE IF NOT EXISTS wallets (
  address        TEXT PRIMARY KEY,   -- normalized lowercase 0x...
  label          TEXT,
  added_at       INTEGER NOT NULL,   -- unix ms
  last_viewed_at INTEGER
);

CREATE TABLE IF NOT EXISTS snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  address         TEXT NOT NULL,
  ts              INTEGER NOT NULL,  -- unix ms
  equity          REAL,
  unrealized_pnl  REAL,
  realized_pnl_cum REAL,
  open_positions  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snapshots_addr_ts ON snapshots(address, ts);

CREATE TABLE IF NOT EXISTS fills (
  address    TEXT NOT NULL,
  tid        INTEGER NOT NULL,        -- Hyperliquid trade id (dedupe key)
  coin       TEXT,
  closed_pnl REAL,
  fee        REAL,
  px         REAL,
  sz         REAL,
  side       TEXT,
  ts         INTEGER,
  PRIMARY KEY (address, tid)
);
```

**Snapshot throttling:** a snapshot is written only if the latest snapshot for
that address is older than `SNAPSHOT_MIN_INTERVAL_MS` (default 60000), so the
fast live updates / 30s fallback don't bloat the DB.

## 8. REST Routes

- `GET /api/health` → `{status:"ok", time}`.
- `GET /api/account/:address` → validate address → fetch HL
  `clearinghouseState` + `userFills` in parallel → ingest fills, write throttled
  snapshot, upsert wallet `last_viewed_at` → return normalized JSON:
  `{address, equity, totalUnrealizedPnl, realizedPnlCumulative,
  realizedPnlRecent, openPositionsCount, positions:[...], asOf, notes}`.
- `GET /api/history/:address?since=<ms>` → snapshots for the chart (asc by ts).
- `GET /api/wallets` → list watched wallets.
- `POST /api/wallets` `{address, label?}` → validate + upsert.
- `DELETE /api/wallets/:address` → remove from watched list.

**Validation:** address must match `^0x[0-9a-fA-F]{40}$` (case-insensitive),
normalized to lowercase. Invalid → `400` with a clear message.

**Error handling:** HL fetch failure / non-OK / unexpected shape → `502` with a
clear message; the frontend renders an error state. Timeouts via `AbortController`.

## 9. Browser ↔ Backend WebSocket

Hub at `/ws` (same HTTP server, `ws://`/`wss://` per page protocol).

- Client → server: `{type:"watch", address}` when a wallet is selected.
- Server → client:
  - `{type:"account", data:{...normalized...}}` on `webData2` changes.
  - `{type:"realized", realizedPnlCumulative, realizedPnlRecent}` on new fills.
  - `{type:"snapshot", point:{ts, equity, unrealized_pnl, realized_pnl_cum}}`
    when a snapshot is written (keeps the chart live).
  - `{type:"error", message}` on upstream/issue.

Backend ensures the upstream `webData2` subscription exists for the watched
address (ref-counted; unsubscribed when no clients watch it). `userFills`
subscriptions for watched wallets are persistent.

## 10. Frontend (`public/`)

- **`index.html`** — wallet selector (dropdown of saved wallets + add/remove
  input), connection badge (Live / Reconnecting / Polling), 4 summary cards,
  positions table, chart canvas, refresh button.
- **Summary cards:** Account Equity, Total Unrealized PnL, Total Realized PnL
  (cumulative; recent-window shown as subtext), Open Positions Count.
- **Positions table columns:** Coin, Side, Size, Entry Price, Mark Price,
  Liquidation Price, Leverage, Margin Used, Unrealized PnL, ROE %.
- **Chart:** hand-drawn `<canvas>` line chart of equity over stored snapshots,
  with a toggle to PnL. Redraws on resize (responsive).
- **PnL styling:** green for positive, red for negative, neutral for zero.
- **States:** loading (skeleton/spinner), empty (no positions / no wallet),
  error (clear message + retry).
- **Realtime/fallback logic:** initial paint via REST; open `/ws` and `watch`;
  live-update on pushes. If WS not connected, poll REST every 30s; resume WS on
  reconnect. The "30s auto-refresh" requirement is satisfied by live WS, with
  30s REST polling as the fallback.

## 11. Configuration (`.env.example`)

```
PORT=3000
HL_API_URL=https://api.hyperliquid.xyz/info
HL_WS_URL=wss://api.hyperliquid.xyz/ws
DEFAULT_WALLET=
DB_PATH=./data/hyperliquid.db
SNAPSHOT_MIN_INTERVAL_MS=60000
```

`DEFAULT_WALLET` (optional) pre-fills the UI. The user can also enter/save
wallets in the UI.

## 12. Security

- Public wallet address only. **Never** asks for or accepts private keys or seed
  phrases. README states this prominently.
- "Read-only" = never performs trading actions and never sends credentials to
  Hyperliquid; it only *reads* market/account data. It does write to its **own
  local DB** (snapshots/wallets/fills) — this is stated plainly so "read-only"
  isn't misleading.
- `.gitignore` excludes `node_modules/`, `.env`, and `data/`.

## 13. Files

```
package.json
server.js
db.js
hyperliquid.js
hl-stream.js
ws-server.js
.env.example
.gitignore
README.md
public/
  index.html
  styles.css
  app.js
data/            (created at runtime, gitignored)
```

## 14. README Contents

What the app does · install (`npm install`) · run (`npm start`) · configure the
wallet (env + UI) · which HL endpoints are used (REST `clearinghouseState`,
`userFills`; WS `webData2`, `userFills`) · limitations:
- Cumulative realized PnL is **"since you started running this dashboard"**
  (fills observed while polling/streaming); historical fills before first run or
  that fall out of HL's window before capture are not included.
- Snapshots accrue for wallets you actually view.
- Security warning: never enter private keys/seed phrases; the app is read-only.

## 15. Out of Scope (YAGNI)

No auth, no multi-user accounts, no order placement/trading, no historical
candlestick charts, no funding/fee analytics beyond what fills provide.

## 16. Acceptance Criteria

- `npm install` then `npm start` runs the app on `PORT`.
- Entering a valid wallet shows equity, unrealized PnL, realized PnL (cumulative),
  open positions count, and a populated positions table with all 10 columns.
- Invalid address → clear 400/error state; HL failure → clear error state;
  no positions → clear empty state.
- Live updates arrive over WS; killing the WS falls back to 30s REST polling and
  recovers on reconnect.
- Snapshots persist across restarts; chart renders stored history; cumulative
  realized PnL accumulates across refreshes.
- No private-key input anywhere; no hardcoded wallet/API URL/secret.
```
