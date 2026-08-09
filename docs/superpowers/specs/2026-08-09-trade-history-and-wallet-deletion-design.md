# Trade History Panel & Wallet Deletion — Design

**Date:** 2026-08-09
**Status:** Approved

## Problem

The dashboard shows only *open* positions. Closed trades vanish from the UI
entirely, even though every fill is already persisted to SQLite (deduped by
Hyperliquid `tid`) to back the cumulative realized-PnL figure. The data is
collected and never read.

Separately, wallet deletion exists but is incomplete: it removes the `wallets`
row and nothing else, leaving that address's `snapshots` and `fills` orphaned in
the database forever. Re-adding a previously deleted wallet resurrects its old
realized PnL and equity chart.

## Goals

1. Surface stored fills as a paginated, filterable **Trade History** panel that
   appends new fills live.
2. Make wallet deletion actually delete: purge the wallet's stored data, stop the
   upstream subscription, confirm before destroying, and reset the UI afterward.

## Non-goals

- Backfilling fills from before the dashboard first observed the wallet.
  Hyperliquid only returns a limited recent-fills window; this constraint is
  unchanged and remains documented in the README.
- Fixing `DEFAULT_WALLET` resurrection. If `DEFAULT_WALLET` is set, `public/app.js`
  re-POSTs it on every page load, so deleting that specific wallet does not stick.
  Explicitly deferred; see "Known gap" below.
- Export (CSV/JSON) of trade history.

---

## Feature 1: Trade History panel

### Storage

One additive migration on the `fills` table: a `dir` column (TEXT, nullable).

Hyperliquid's `userFills` returns `dir` — a human-readable direction such as
`"Open Long"`, `"Close Short"`, or `"Long > Short"`. The currently stored `side`
is the raw `"A"`/`"B"` (ask/bid), which is not meaningful in a user-facing table.
`dir` is what makes the history readable.

The migration follows the existing `wallets.via_agent` pattern in `db.js`:
a `PRAGMA table_info` check followed by `ALTER TABLE fills ADD COLUMN dir TEXT`.

Rows written before this change have `dir = NULL` and render from `side` as a
fallback (`B` → `Buy`, `A` → `Sell`, otherwise `—`). No backfill is attempted:
the original `dir` for historical fills is not recoverable, and inventing one
from `side` at write time would misrepresent opens vs. closes.

`normalizeFills` in `hyperliquid.js` gains `dir: f.dir ?? null` in its row shape.
Because `insertFill` uses named parameters, the new key flows through with no
call-site changes.

No dex column is needed. Builder-dex fills already carry the dex in the coin
string (e.g. `xyz:SP500`), matching how positions are labeled today.

### Read path

Two new prepared statements exposed on the db handle:

- `listFills(address, { limit, offset, closesOnly })` — newest first, ordered by
  `ts DESC, tid DESC` so the ordering is total and stable across pages even when
  several fills share a millisecond timestamp.
- `countFills(address, { closesOnly })` — total matching rows, for the pager.

`closesOnly` filters to `closed_pnl != 0`. Both statements apply the same
predicate so the count always agrees with the listing.

### API

`GET /api/fills/:address?limit=&offset=&closesOnly=`

- Address validated with `isValidAddress`, returning 400 on failure, consistent
  with every other address-bearing route.
- `limit` defaults to 50, clamped to 1–200. `offset` defaults to 0, clamped to
  `>= 0`. Clamping is server-side so a hand-crafted request cannot ask for the
  entire table.
- `closesOnly` is true only for the exact string `"true"`.
- Responds `{ address, fills, total, limit, offset }`.

### UI

A `Trade History` panel below Open Positions, matching the existing panel markup
and dark theme. Columns: Time, Coin, Direction, Size, Price, Fee, Realized PnL.
Realized PnL uses the existing positive/negative coloring; it renders `—` rather
than `$0.00` on fills that closed nothing, so opening fills read as "no PnL yet"
instead of "broke even".

Panel header carries a **closes only** toggle. Footer carries prev/next buttons
and an `X–Y of N` range label. Changing the filter resets to offset 0. Empty
state: "No trades recorded yet."

### Live updates

`ws-server.js` already receives new fills from the upstream stream, persists
them, and broadcasts a `realized` message. The new fill rows are added to that
existing broadcast rather than introducing a second message — one upstream event
produces one downstream message.

Client-side append rules:

- Dedupe by `tid`. The upstream `userFills` subscription can resend fills, and
  `INSERT OR IGNORE` absorbs that server-side but the broadcast still carries
  them.
- Append only when viewing offset 0 and the fill matches the active filter.
  On any other page, the row is already committed to the database and appears on
  navigation, so nothing is lost by ignoring it.
- Increment the total count so the pager stays accurate.

---

## Feature 2: Wallet deletion

### Purge

`db.deleteWallet(address)` becomes a transaction deleting from `wallets`,
`snapshots`, and `fills`. A transaction so a mid-delete failure cannot leave a
wallet whose row is gone but whose fills remain.

### Required companion change: `stream.untrack`

`hl-stream.js` exposes `track()` but no `untrack()`. Its persistent `userFills`
subscription feeds `db.ingestFills` in `ws-server.js` regardless of whether a
`wallets` row exists.

**Without an `untrack`, the purge does not stick:** deleting a wallet would drop
its fills, and the still-live subscription would re-insert them on the next fill
event. So:

- `hl-stream.js` gains `untrack(address)` — removes the address from the
  `tracked` set and sends the corresponding `unsubscribe` frame. It is
  independent of the ref-counted `watch`/`unwatch` pair, which governs live
  `webData2` for connected browsers; `track` is a separate, non-ref-counted set.
- `createApp(db, overrides)` accepts an optional `stream` in `overrides` so the
  DELETE route can call `untrack`. Optional because the existing server tests
  construct the app without a stream; the route no-ops that call when absent.

### Route

`DELETE /api/wallets/:address` gains `isValidAddress` validation (400 on
failure), which it currently lacks while every other address route has it.
It then purges, untracks, and returns the updated wallet list as before.

### UI

- The bare `✕` becomes a labeled control (visible text, not a tooltip-only glyph).
- A `confirm()` names the wallet and states that its stored history will be
  erased — deletion is irreversible in a way that matters (see Risks).
- After deletion, when no wallets remain: clear `state.address`, `state.history`,
  and reset cards, positions table, chart, agent panel, and wallet badge to their
  empty states, with status "Enter a wallet". Currently the UI keeps rendering the
  deleted wallet's data.

---

## Testing

| File | Coverage |
|------|----------|
| `test/db.test.js` | `dir` migration is additive and preserves existing rows; `listFills` ordering, pagination, and `closesOnly` filter; `countFills` agrees with `listFills`; `deleteWallet` removes rows from all three tables and leaves other wallets untouched. |
| `test/server.test.js` | `/api/fills/:address` rejects bad addresses, clamps `limit`/`offset`, honors `closesOnly`, returns correct `total`. DELETE rejects bad addresses, purges data, and calls `untrack` when a stream is supplied. |
| `test/hl-stream.test.js` | `untrack` sends `unsubscribe` and removes the address from the resubscribe set used on reconnect. |
| `test/hyperliquid.test.js` | `normalizeFills` carries `dir` through and tolerates its absence. |

## Risks

**Purging is irreversible and loses data Hyperliquid cannot re-supply.** Realized
PnL is cumulative *since this dashboard began observing fills*; Hyperliquid only
serves a limited recent window. Deleting a wallet watched for months permanently
destroys history that cannot be rebuilt. This is the explicit purpose of the
confirmation dialog, and the reason purge is coupled to deletion rather than
offered as a silent background cleanup.

**Live-append correctness depends on `tid` dedupe.** If the upstream stream ever
emits fills without a valid `tid`, `normalizeFills` already filters them out
before they reach either the database or the broadcast.

## Known gap (deferred)

`DEFAULT_WALLET` is re-added on every page load by `public/app.js`. Deleting a
wallet configured that way removes its data, but the wallet reappears (empty) on
the next load. Clearing the env var is the workaround. Fixing this properly means
persisting a "deleted" tombstone or having the client skip the default when it
was explicitly removed — out of scope here.

## Files touched

```
db.js               dir migration; listFills/countFills; deleteWallet transaction
hyperliquid.js      normalizeFills carries dir
hl-stream.js        untrack()
server.js           GET /api/fills/:address; DELETE validation + purge + untrack; stream in overrides
ws-server.js        include new fill rows in the existing broadcast
public/index.html   Trade History panel markup; labeled delete control
public/app.js       fills fetch/render/paginate/filter; live append; post-delete reset
public/styles.css   panel, toggle, pager styling
README.md           document the panel and that deletion purges data
test/               db, server, hl-stream, hyperliquid coverage above
```
