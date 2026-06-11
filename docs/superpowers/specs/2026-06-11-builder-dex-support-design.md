# Builder-Dex (HIP-3) Support — Design Spec

**Date:** 2026-06-11
**Status:** Approved

## 1. Purpose

Surface the user's positions on Hyperliquid's **builder-deployed perp DEXs**
(HIP-3), not just the main perp dex. The dashboard currently queries only the
default dex, so positions on builder dexs (e.g. an `xyz:SP500` short on the
"XYZ" dex) are invisible — which is exactly why a live account shows "no trades."

The dashboard will **auto-aggregate** across all dexs into a single unified view:
one equity figure, one positions table, one realized-PnL total — spanning every
Hyperliquid dex the wallet has activity on.

## 2. Background (verified against the live API)

- Hyperliquid has a **main perp dex** (USDC-collateralized) plus multiple **HIP-3
  builder-deployed perp dexs**, each a separate collateral pool. `{type:"perpDexs"}`
  lists them: the array's first element is `null` (the main dex); the rest are
  objects with `name` (e.g. `"xyz"`) and `fullName` (e.g. `"XYZ"`).
- Per-dex account state: `{type:"clearinghouseState", user, dex:"<name>"}`. The
  main dex uses the same call **without** a `dex` field. The per-position shape
  (`szi`, `entryPx`, `positionValue`, `leverage`, `liquidationPx`,
  `unrealizedPnl`, `returnOnEquity`, `marginUsed`) is **identical** across dexs.
- Builder-dex coins are **namespaced**: `xyz:SP500`. Main-dex coins are bare:
  `BTC`. So the coin string already identifies the dex.
- Collateral differs per dex. `{type:"meta", dex:"<name>"}` returns
  `collateralToken` (a spot-token index); `{type:"spotMeta"}` maps index → symbol
  (verified: `0`→USDC, `268`→USDT0, `360`→USDH, `235`→USDE). The main dex is USDC.
- `{type:"userFills", user}` (no `dex`) **already returns fills from all dexs**
  (verified — namespaced coins appear), so realized-PnL ingestion needs no change.

**Out of scope — not on Hyperliquid:** the wallet's USDT-margined perps seen in
Bitget Wallet's "Perps" tab (e.g. `BTCUSDT`) are **not** on the user's Hyperliquid
address (confirmed: zero positions/orders across all dexs incl. the USDT0 dex,
sub-accounts, and agents). Those are Bitget's own perps engine and are
unreadable via a public Hyperliquid address. They are explicitly out of scope
(see §13); a separate feasibility spike may follow.

## 3. Constraints

- No new dependencies. Read-only public-address model preserved.
- **Backend remains the single Hyperliquid caller / normalization point** (per the
  original dashboard design); the browser never calls Hyperliquid directly.
- Reuse the existing `normalizeAccount` per dex — no parallel normalizer.
- Preserve the existing realized-PnL / fills accumulation behavior.

## 4. Core Decisions (approved)

1. **Auto-aggregate** all dexs into one view (no dex selector, no per-dex UI
   sections). Empty dexs simply contribute nothing.
2. **Sum equity / margin / unrealized PnL across dexs as one ≈USD total.** Each
   dex's collateral is a dollar-pegged stablecoin (USDC/USDT0/USDH/USDE), so they
   are summed as approximately USD. Each position is labeled with its collateral
   so the mixing is transparent.
3. **Backend REST aggregation is the source of truth.** Builder-dex positions
   refresh at **≤30s** (initial load + existing 30s poll + manual refresh +
   a WS-driven refetch nudge). Instant per-dex `webData2` streaming is **not**
   pursued in v1.

## 5. Data Flow

```
/api/account/:address
  → assembleAccount(address)
      → getPerpDexs() (cached)                     // list of dexs
      → for main dex + each builder dex, in parallel:
            clearinghouseState{user[, dex]} → normalizeAccount → tag {dex, collateral}
      → merge: sum equity/margin/uPnl, concat positions, total openPositionsCount
      → userFills{user} (cross-dex) → ingest → cumulative realized
      → write throttled AGGREGATED equity snapshot
  → returns one merged account payload (positions carry dex + collateral)

WS (/ws): on a main-dex webData2 change for the watched address, server sends
  {type:"refresh"} → browser debounced re-fetch of /api/account (near-instant
  main-dex updates). Live cross-dex fills still push {type:"realized"}.
```

## 6. Modules & Changes

### `hyperliquid.js`

- `getPerpDexs(opts)` → `fetchInfo({type:"perpDexs"}, opts)`, **cached in-process**
  with a TTL (~10 min; the list changes rarely). Normalizes to
  `[{ name, fullName }]` for builder dexs plus the implicit main dex (represented
  as `{ name: null, fullName: "Main" }`).
- Dex→collateral resolution, cached with the same TTL: for each builder dex,
  `meta{dex}` → `collateralToken` index, mapped to a symbol via a single cached
  `spotMeta` fetch. Main dex → `"USDC"`. Exposed as `getDexCollateral(opts)` →
  `Map<dexName|null, symbol>`. On failure, collateral degrades to `null` (the dex
  still shows; the label is just omitted).
- `mergeAccounts(perDex)` (pure): given an array of
  `{ dex, collateral, account }` (each `account` from `normalizeAccount`), returns
  one merged account: `equity`/`marginUsed`/`totalUnrealizedPnl` summed (null-safe),
  `positions` concatenated with each position tagged `{ dex, collateral }`,
  `openPositionsCount` = total non-zero positions.

### `account.js` — `assembleAccount`

- Replace the single `getClearinghouseState(address)` with a multi-dex fetch:
  `getPerpDexs` → fetch `clearinghouseState` for the main dex (no `dex`) and each
  builder dex (`{dex:name}`) **in parallel via `Promise.allSettled`**; a dex that
  errors is **skipped** (logged), never failing the whole load. Each result →
  `normalizeAccount` → tagged with `{ dex, collateral }` (collateral from the
  cached map). Merge via `mergeAccounts`.
- `userFills` ingestion unchanged (already cross-dex). Cumulative realized =
  `SUM(closed_pnl)` over all stored fills (mixed stables ≈ USD).
- Snapshot now stores the **aggregated** equity/uPnL (total Hyperliquid equity).
- Returned payload unchanged in shape except each `positions[i]` gains `dex` and
  `collateral`.

### `server.js`

- No new route required. `/api/account/:address` returns the merged payload.
  (`opts` already threads `fetchImpl`/`apiUrl`, so the new HL calls are testable.)

### `hl-stream.js` / `ws-server.js`

- Keep the persistent `userFills` subscription (cross-dex) → live `realized`
  updates (unchanged).
- The watched-address `webData2` (main-dex) handler **no longer broadcasts a
  main-dex-only `account`** (which would clobber builder-dex rows in the unified
  view). Instead it broadcasts a lightweight `{type:"refresh"}` to clients
  watching that address.
- **Snapshot writing moves out of the `webData2` handler** (it only had main-dex
  equity) and lives solely in the REST `assembleAccount` path, which now produces
  aggregated equity. The separate `{type:"snapshot"}` WS push is therefore
  dropped; the chart stays current because the `refresh`-triggered refetch also
  reloads history. (Fills still accumulate server-side via the persistent
  subscription regardless of a browser being open; aggregated equity snapshots
  accrue while a browser is viewing — consistent with the existing "snapshots
  accrue for wallets you view" behavior.)

### Frontend (`public/app.js`, `public/index.html`)

- On `{type:"refresh"}`: debounced re-fetch of `/api/account` (and history),
  re-render. (Replaces the old direct `account` paint, removing the clobber risk
  — REST aggregation is the single source of truth.)
- **The 30s poll runs continuously**, not only as a WS-down fallback: builder-dex
  changes never produce a `webData2` nudge, so a steady poll is what guarantees
  ≤30s builder-dex freshness while the WS is connected. (The `webData2` nudge is
  an additional low-latency path for *main-dex* changes; manual refresh still
  works.) The old "stop polling when WS opens" behavior is removed.
- `renderAccount` shows each position's collateral alongside the coin so
  `xyz:SP500` reads as e.g. **"S&P500 · USDC"** (coin namespacing already conveys
  the dex; collateral makes USDC-vs-USDT0 explicit). New optional fields are
  rendered defensively (missing collateral → omitted).
- Summary cards already show the totals returned by `/api/account` — now
  aggregated. Add a one-line note that totals span all Hyperliquid dexs.

## 7. Aggregation Details

- **Sums are null-safe:** a dex with `null` equity contributes 0; if *no* dex
  reports a number, the field stays `null` (matches current empty-account
  behavior).
- **Positions:** only non-zero-size positions are included (existing
  `normalizeAccount` already drops flats). Each carries `dex` (e.g. `"xyz"`,
  `null` for main) and `collateral` (e.g. `"USDC"`).
- **Idle collateral:** a dex with funds but no open position still adds to total
  equity (its `accountValue`), with no table rows — correct.

## 8. Performance

Per account load: `1 + N` `clearinghouseState` calls (main + N builder dexs;
~9 today), run in parallel. Metadata (`perpDexs`, per-dex `meta`, `spotMeta`) is
cached with a TTL so it is fetched rarely, not per load. This is acceptable for a
single-user local dashboard. A future optimization (only query dexs known to hold
funds) is explicitly deferred (YAGNI).

## 9. Error Handling

- Per-dex `clearinghouseState` failure → that dex is skipped (logged); the rest of
  the account still loads. The whole request fails (502) only if the **main dex**
  call fails (preserving today's behavior for the primary dex).
- `perpDexs` failure → fall back to main-dex-only (degrades gracefully to current
  behavior).
- Collateral-metadata failure → positions still show; collateral label omitted.

## 10. Testing

- `mergeAccounts` (pure): sums equity/margin/uPnL across dexs; concatenates and
  tags positions with `dex`/`collateral`; null-safety; idle-collateral dex adds
  equity without rows.
- `getPerpDexs`: correct request body; caching (second call within TTL does not
  refetch — assert via call-count on injected `fetchImpl`).
- Dex→collateral mapping: index→symbol via stubbed `meta`/`spotMeta` (0→USDC,
  268→USDT0); failure → `null` label.
- `assembleAccount` aggregation (injected `fetchImpl`): main + one builder dex
  with positions → merged equity/positions; a failing builder dex is skipped;
  main-dex failure → throws (→ 502).
- Route test: `/api/account` returns merged positions spanning a stubbed main +
  builder dex, each with `dex`/`collateral`.

## 11. Streaming/Refresh Behavior (restated)

- Main-dex change → `webData2` → server `{type:"refresh"}` → debounced client
  re-fetch (near-instant).
- Builder-dex change → reflected on the 30s poll / manual refresh (≤30s).
- Realized PnL → live via cross-dex `userFills` push (unchanged).

## 12. Acceptance Criteria

- A wallet with a position only on a builder dex (e.g. `xyz:SP500`) shows that
  position, its equity, and unrealized PnL in the dashboard.
- Equity / unrealized / realized cards reflect **totals summed across all dexs**;
  positions table lists positions from every dex, each labeled with its
  collateral; main-dex-only wallets behave as before.
- A single failing builder dex does not break the load; main-dex failure still
  yields a clear error state.
- Snapshots/chart reflect aggregated equity over time; cumulative realized PnL
  spans all dexs.
- New unit tests for `mergeAccounts`, `getPerpDexs` caching, collateral mapping,
  and the aggregating `assembleAccount`/route pass.

## 13. Out of Scope (YAGNI)

- **Bitget Wallet's USDT-margined perps** (different provider; not on Hyperliquid;
  would require Bitget's authenticated API — separate future project).
- Per-dex live `webData2` streaming (builder dexs are poll-refreshed in v1).
- Open-orders display (the dashboard shows positions only).
- Per-dex equity breakdown UI / a dex selector (auto-aggregate only).
- Server-side aggregated snapshots while no browser is open.
