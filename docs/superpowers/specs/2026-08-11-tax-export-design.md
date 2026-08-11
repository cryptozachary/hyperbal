# Trade Export for Tax Purposes — Design

**Date:** 2026-08-11
**Status:** Approved

## Problem

The dashboard can show trade history but cannot get it out, and the data it holds
is not accurate enough to file from.

Measured against Hyperliquid's own API for wallet `0xbf7d…c5e5` (128 fills,
Jan–Aug 2026):

| | Stored today | Actual |
|---|---:|---:|
| Realized PnL | −498.16 | −498.16 |
| Exchange fee | −271.17 | −271.17 |
| Builder fee | *not captured* | **−185.72** |
| Funding payments | *not captured* | **+131.39** |
| **Net** | **−769.33** | **−823.67** |

An export built on the current `fills` table would be wrong by **$54.34 (7%)** for
this wallet, and the two omissions do not reliably offset each other.

Three concrete gaps:

1. **`builderFee` is dropped.** Hyperliquid's `userFills` returns both `fee` and
   `builderFee`; `normalizeFills` keeps only `fee`. Builder fees here are 68% the
   size of exchange fees, so this is not a rounding error.
2. **Funding payments are not stored at all.** `userFunding` returns 428 entries
   for this wallet — more rows than it has fills. On perpetuals this is a real
   cash flow, not an incidental.
3. **`dir` is `NULL` on all 168 existing rows** across all three wallets, because
   it was added after they were recorded. Direction would export as `Buy`/`Sell`
   rather than `Open Long`/`Close Short`.

All three are recoverable from public endpoints, verified against the live API on
2026-08-11.

## Goals

1. Make the stored record reconcile with Hyperliquid: capture builder fees, store
   funding, and backfill history.
2. Export it as CSV, scoped to a tax year, with a per-trade audit link.

## Non-goals

- **Tax advice or tax characterization.** This produces raw transaction records.
  How perpetuals are characterized, which lots match, and what is reportable are
  decisions for the filer or their preparer. The export takes no position.
- Cost-basis lot matching (FIFO/LIFO/HIFO). Not attempted.
- Deposits, withdrawals, and transfers (`userNonFundingLedgerUpdates`). Out of
  scope; this covers trading activity and funding only.
- Spot trades. The dashboard is perps-only today and this does not change that.

---

## Phase 1: Make the data correct

### `fills` schema

Four additive columns, following the `dir` / `via_agent` migration pattern in
`db.js` (a `PRAGMA table_info` check plus `ALTER TABLE`):

| Column | Source | Why |
|---|---|---|
| `builder_fee REAL` | `builderFee` | Second fee component; materially affects net |
| `hash TEXT` | `hash` | On-chain reference; becomes the audit link |
| `oid INTEGER` | `oid` | Order id, for cross-referencing |
| `fee_token TEXT` | `feeToken` | Fee denomination (observed `USDC`, not guaranteed) |

`normalizeFills` carries all four, defaulting to `null` when absent. `ingestTxn`
already spreads a `dir: null` default; the same shape extends to the new keys so
callers that omit them keep working.

Pre-existing rows have `NULL` in all four until backfilled (Phase 2).

### `funding` table

```sql
CREATE TABLE IF NOT EXISTS funding (
  address TEXT NOT NULL,
  ts INTEGER NOT NULL,
  coin TEXT NOT NULL,
  usdc REAL,
  funding_rate REAL,
  szi REAL,
  PRIMARY KEY (address, ts, coin)
);
```

`userFunding` returns no unique id per entry, so the primary key does the
deduping that `tid` does for fills. Funding settles hourly per coin, making
`(address, ts, coin)` a natural key — and it makes re-ingestion idempotent, which
the backfill depends on.

`normalizeFunding(entries)` flattens the nested shape
(`{ time, delta: { coin, usdc, fundingRate, szi } }`) into rows, dropping entries
whose `delta.type` is not `funding` and any row missing `time` or `coin`.

### Persistence scoping

Funding ingestion is gated on `db.hasWallet(address)`, exactly as fills are. The
invariant established in the deletion work — nothing is persisted for a wallet
that is not on the saved list — extends to funding, and `deleteWallet`'s
transaction gains a `DELETE FROM funding` so a purge stays complete.

---

## Phase 2: Backfill

`POST /api/backfill/:address` pages both endpoints forward and upserts.

**Two write paths, deliberately different.** The live path
(`db.ingestFills`, used by the REST load and the WebSocket stream) keeps its
existing `INSERT OR IGNORE`: it is hot, and a duplicate there is genuinely
nothing to do. The backfill needs the opposite behaviour, because its whole
purpose is to enrich rows that already exist with `NULL` in the new columns. So
`db.backfillFills` uses a separate statement:

```sql
INSERT INTO fills (…) VALUES (…)
ON CONFLICT(address, tid) DO UPDATE SET
  dir         = COALESCE(fills.dir,         excluded.dir),
  builder_fee = COALESCE(fills.builder_fee, excluded.builder_fee),
  hash        = COALESCE(fills.hash,        excluded.hash),
  oid         = COALESCE(fills.oid,         excluded.oid),
  fee_token   = COALESCE(fills.fee_token,   excluded.fee_token)
```

`COALESCE(existing, incoming)` fills gaps without overwriting anything already
recorded — the same defensive shape `upsertWallet` already uses for `via_agent`.
Money columns (`closed_pnl`, `fee`, `px`, `sz`) are deliberately **not** in the
`DO UPDATE` list: a fill's economics are fixed once observed, and silently
rewriting them from a later API response is not a behaviour this should have.

**Pagination.** Both endpoints cap rows per call. The loop advances its window to
the newest timestamp seen, **not** `timestamp + 1`, because several fills can
share a millisecond and `+1` would skip them — the live data already contains
same-millisecond fills. The resulting overlap is absorbed by the upsert above and
by the funding primary key. Termination is on a page that yields **no new rows**,
rather than on a short page, so a page consisting entirely of duplicates ends the
loop instead of spinning forever.

A ceiling of **50 pages per endpoint** guards against a pathological response
keeping the loop alive. Hitting it sets `truncated: true` in the response and is
surfaced in the UI, rather than being reported as a completed sync.

**Response:** `{ address, fills: { scanned, inserted, updated }, funding: { scanned, inserted }, from, truncated }`
so the UI can state what actually happened rather than claiming success.

**Idempotent.** A second run scans the same rows and writes nothing, because
every `COALESCE` target is already populated.

**UI:** a "Sync full history" button in the export panel, reporting inserted
counts on completion. It is explicit rather than automatic — it issues a burst of
API calls and the user should choose when.

---

## Phase 3: Export

### Route

`GET /api/export/:address.csv?from=&to=&format=detailed|koinly`

- `from`/`to` are epoch-ms bounds, **computed by the client** from the selected
  year in the browser's local timezone. Sending explicit bounds rather than a
  year number removes any possibility of the server and client disagreeing about
  where a year begins. The range is half-open — `ts >= from AND ts < to` — so
  consecutive years tile exactly, with no event counted twice or dropped at the
  boundary. **All time** omits both parameters.
- Responds `text/csv` with `Content-Disposition: attachment; filename="…"`,
  named `hyperliquid-<short-address>-<year>-<format>.csv`.
- Address validated like every other route; unknown `format` → 400.

### Detailed format (source of truth)

One row per event, fills and funding merged in chronological order:

```
time_utc, time_local, type, coin, direction, size, price, notional,
fee, builder_fee, fee_token, funding, realized_pnl, order_id, tx_hash, explorer_url
```

- `type` is `fill` or `funding`.
- Funding rows populate `time_*`, `coin`, `funding`; trade-only columns are empty.
- `notional` is `price × size`, computed at export time rather than stored.
- `explorer_url` is `https://app.hyperliquid.xyz/explorer/tx/<hash>` — verified
  on 2026-08-11 to resolve to the correct transaction via
  `POST https://rpc.hyperliquid.xyz/explorer {"type":"txDetails","hash":…}`.
  All 128 fills checked carried a real (non-zero) hash.
- **Funding rows carry no link.** Their hash is zero-filled because funding is an
  internal ledger event, not an on-chain transaction. The column is left empty
  rather than filled with a URL that would 404.

A leading comment line records the wallet, the range in both UTC and local time,
the timezone used, and the generation timestamp — so the file is self-describing
if it is opened months later.

### Koinly format

Koinly's generic CSV columns, so it imports without manual mapping.

**This mapping is explicitly best-effort and is flagged as such in the UI and in
the spec.** Koinly's generic CSV is built around acquiring and disposing of a
held asset. A perpetual fill is not a disposal of a held asset, and a realized-PnL
event has no cost basis in that model. Producing Koinly rows therefore requires
judgment calls, and different reasonable calls yield different reported outcomes.
The detailed CSV is the artifact to hand a preparer; the Koinly file is a
convenience to be verified, not trusted.

### CSV correctness

A single `toCsv(rows, columns)` helper handles quoting: any field containing a
comma, quote, or newline is wrapped in double quotes with internal quotes
doubled. Coin names such as `xyz:SP500` are safe today, but builder dexes name
their own markets and the escaping should not depend on that staying true.

Numbers are written at full stored precision — no display rounding. Fees here run
to six decimal places and rounding them would break reconciliation.

### UI

An **Export** panel below Trade History:

- Year dropdown, populated from the years actually present in the data, plus
  **All time**.
- Two download buttons (Detailed CSV, Koinly CSV) with the caveat above stated
  next to the Koinly one.
- The "Sync full history" button, with its result count.
- A line stating what the export covers and that the record begins when the
  dashboard first observed the wallet.

---

## Testing

| File | Coverage |
|---|---|
| `test/db.test.js` | Additive migration for the four fill columns preserves rows; `funding` dedupes on `(address, ts, coin)`; `deleteWallet` purges funding; the fills upsert fills `NULL` columns without overwriting present values. |
| `test/hyperliquid.test.js` | `normalizeFills` carries the four new fields and tolerates their absence; `normalizeFunding` flattens correctly, drops non-`funding` delta types, and drops malformed rows. |
| `test/export.test.js` (new) | `toCsv` escapes commas, quotes, and newlines; fills and funding merge in chronological order; funding rows carry no explorer URL; numeric precision is preserved; empty range yields headers only. |
| `test/server.test.js` | Export route validates address, rejects unknown `format`, sets `Content-Disposition`, honors `from`/`to`. Backfill route validates address and reports counts. |
| `test/backfill.test.js` (new) | Pagination advances on the newest timestamp and does not skip same-millisecond rows; terminates on a page with no new rows; is idempotent across two runs; respects the iteration ceiling and reports `truncated`. |

A reconciliation check belongs in the export tests: summing the detailed CSV's
`realized_pnl`, `fee`, `builder_fee`, and `funding` columns must equal the direct
SQL sums over the same range.

## Risks

**The record is only as complete as what was observed.** Backfill pulls what
Hyperliquid still serves; anything aged out before the first sync is
unrecoverable. The export states its own coverage window, and the README already
documents this limitation for realized PnL. A user filing from this should
reconcile the totals against their own records — the export makes that possible
by including the explorer link per row.

**Timezone boundaries.** Year bounds are computed in the browser's local
timezone and written into the file. A user who moves timezones between exports
will get different boundaries; stating the timezone in the file makes that
visible rather than silent.

**Vendor format drift.** Koinly can change its import schema. The detailed format
is stable and under our control; the Koinly one is not, which is a second reason
to treat it as the convenience artifact.

## Files touched

```
db.js                fills columns + migration; funding table, insert, queries;
                     deleteWallet purges funding; fills upsert for backfill
hyperliquid.js       normalizeFills carries 4 fields; normalizeFunding;
                     getUserFillsByTime / getUserFunding wrappers
backfill.js          NEW — paginated history sync for fills + funding
export.js            NEW — toCsv helper, detailed and Koinly row builders
server.js            GET /api/export/:address.csv; POST /api/backfill/:address
ws-server.js         gate funding ingest on hasWallet (consistency)
public/index.html    Export panel markup
public/app.js        year list, download links, sync button
public/styles.css    export panel styling
README.md            document export, funding capture, and coverage caveat
test/                per the table above
```
