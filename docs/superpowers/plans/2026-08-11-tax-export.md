# Tax Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the stored trade record reconcile with Hyperliquid (builder fees, funding, full history), then export it as CSV scoped to a tax year with a per-trade explorer link.

**Architecture:** Three phases. First widen `fills` and add a `funding` table so nothing is silently dropped on ingest. Then a paginated backfill that enriches existing rows in place — the live ingest keeps `INSERT OR IGNORE`, the backfill uses a `COALESCE` upsert, because they want opposite behaviour on conflict. Finally two pure modules (`backfill.js`, `export.js`) with injected dependencies, wrapped by thin routes and an Export panel.

**Tech Stack:** Node 18+ ESM, Express 4, better-sqlite3 (synchronous prepared statements), vanilla DOM frontend, `node --test` with `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-11-tax-export-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `db.js` | Schema, migrations, all prepared statements | 4 fill columns + migration; `funding` table + queries; `backfillFills` COALESCE upsert; purge funding on delete; `getRange` |
| `hyperliquid.js` | REST client + normalizers | `normalizeFills` carries 4 fields; new `normalizeFunding`; `getUserFillsByTime`/`getUserFunding` wrappers |
| `backfill.js` | **NEW** — paginated history sync | Pure pagination loop with injected fetchers; no network or Express knowledge |
| `export.js` | **NEW** — CSV generation | `toCsv` escaping, detailed row builder, Koinly row builder; no DB or Express knowledge |
| `server.js` | Routes | `POST /api/backfill/:address`, `GET /api/export/:address.csv`, `GET /api/range/:address` |
| `public/index.html` | Markup | Export panel |
| `public/app.js` | Client | Year list, download links, sync button |
| `public/styles.css` | Theme | Export panel styling |
| `README.md` | Docs | Export, funding capture, coverage caveat |

`backfill.js` and `export.js` are separate files rather than additions to `server.js` because both hold the only non-trivial logic in this feature — pagination termination and CSV correctness — and both are worth testing without booting a server or touching the network. Their dependencies are injected for exactly that reason.

Task order: schema (1–2) → backfill (3–4) → export (5–6) → UI (7) → docs (8).

---

### Task 1: Widen `fills` with the dropped columns

**Goal:** Stop discarding `builderFee`, `hash`, `oid`, and `feeToken` on ingest.

**Files:**
- Modify: `db.js` (SCHEMA, migration block, `insertFill`, `ingestTxn`)
- Modify: `hyperliquid.js` (`normalizeFills`)
- Test: `test/db.test.js`, `test/hyperliquid.test.js`

**Acceptance Criteria:**
- [ ] Fresh databases create `fills` with `builder_fee`, `hash`, `oid`, `fee_token`
- [ ] Pre-existing databases gain all four without losing rows
- [ ] The migration is data-driven, so the existing `dir` migration is not duplicated
- [ ] `normalizeFills` carries all four and tolerates their absence
- [ ] Callers that omit the new keys still insert successfully

**Verify:** `npm test` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

Append to `test/hyperliquid.test.js`:

```js
test('normalizeFills carries builderFee, hash, oid and feeToken', () => {
  const { rows } = normalizeFills([
    { tid: 1, coin: 'BTC', closedPnl: '5', fee: '0.33', builderFee: '0.23', px: '100', sz: '1',
      side: 'A', dir: 'Close Long', hash: '0xabc', oid: 42, feeToken: 'USDC', time: 10 },
    { tid: 2, coin: 'ETH', closedPnl: '0', fee: '0.1', px: '50', sz: '2', side: 'B', time: 20 },
  ]);
  assert.equal(rows[0].builder_fee, 0.23);
  assert.equal(rows[0].hash, '0xabc');
  assert.equal(rows[0].oid, 42);
  assert.equal(rows[0].fee_token, 'USDC');
  // absent builderFee means no builder took a cut, which is 0 — not unknown
  assert.equal(rows[1].builder_fee, 0);
  assert.equal(rows[1].hash, null);
  assert.equal(rows[1].oid, null);
  assert.equal(rows[1].fee_token, null);
});
```

Append to `test/db.test.js`:

```js
test('migration adds all fills columns to a pre-existing table', async () => {
  const Database = (await import('better-sqlite3')).default;
  const p = path.join(os.tmpdir(), `hl-cols-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const old = new Database(p);
  old.exec(`CREATE TABLE fills (address TEXT NOT NULL, tid INTEGER NOT NULL, coin TEXT,
    closed_pnl REAL, fee REAL, px REAL, sz REAL, side TEXT, ts INTEGER, PRIMARY KEY (address, tid))`);
  old.prepare(`INSERT INTO fills (address, tid, coin, closed_pnl, fee, px, sz, side, ts)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('0xold', 1, 'BTC', 5, 0.1, 100, 1, 'B', 10);
  old.close();

  const db = openDb(p);
  const cols = db.raw.prepare(`PRAGMA table_info(fills)`).all().map((c) => c.name);
  for (const c of ['dir', 'builder_fee', 'hash', 'oid', 'fee_token']) {
    assert.ok(cols.includes(c), `missing column ${c}`);
  }
  const row = db.raw.prepare(`SELECT * FROM fills WHERE address = ?`).get('0xold');
  assert.equal(row.tid, 1);
  assert.equal(row.closed_pnl, 5, 'existing data must survive the migration');
  assert.equal(row.builder_fee, null);
});

test('ingestFills stores the new columns and defaults them when omitted', () => {
  const db = freshDb();
  db.ingestFills('0xabc', [
    { tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.33, builder_fee: 0.23, px: 100, sz: 1,
      side: 'A', dir: 'Close Long', hash: '0xabc', oid: 42, fee_token: 'USDC', ts: 10 },
    { tid: 2, coin: 'ETH', closed_pnl: 0, fee: 0.1, px: 50, sz: 2, side: 'B', ts: 20 },
  ]);
  const rows = db.raw.prepare(`SELECT * FROM fills WHERE address = ? ORDER BY tid`).all('0xabc');
  assert.equal(rows[0].builder_fee, 0.23);
  assert.equal(rows[0].hash, '0xabc');
  assert.equal(rows[0].oid, 42);
  assert.equal(rows[1].builder_fee, null);
  assert.equal(rows[1].hash, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `no such column: builder_fee` from the db tests, and `undefined` for the new fields in the hyperliquid test.

- [ ] **Step 3: Add the columns to the schema**

In `db.js`, in the `SCHEMA` string, extend the `fills` table so it reads:

```sql
CREATE TABLE IF NOT EXISTS fills (
  address TEXT NOT NULL,
  tid INTEGER NOT NULL,
  coin TEXT,
  closed_pnl REAL,
  fee REAL,
  px REAL,
  sz REAL,
  side TEXT,
  dir TEXT,
  builder_fee REAL,
  hash TEXT,
  oid INTEGER,
  fee_token TEXT,
  ts INTEGER,
  PRIMARY KEY (address, tid)
);
```

- [ ] **Step 4: Replace the `dir` migration with a data-driven one**

In `db.js`, replace the existing single-column `dir` migration block entirely:

```js
  // Migration: add fills columns introduced after the original schema. Data-driven
  // so each new column is one entry rather than another copy of this block.
  const fillCols = db.prepare(`PRAGMA table_info(fills)`).all().map((c) => c.name);
  for (const [name, type] of [['dir', 'TEXT'], ['builder_fee', 'REAL'], ['hash', 'TEXT'], ['oid', 'INTEGER'], ['fee_token', 'TEXT']]) {
    if (!fillCols.includes(name)) db.exec(`ALTER TABLE fills ADD COLUMN ${name} ${type}`);
  }
```

- [ ] **Step 5: Write the new columns on insert**

In `db.js`, update `insertFill`:

```js
    insertFill: db.prepare(`
      INSERT OR IGNORE INTO fills (address, tid, coin, closed_pnl, fee, px, sz, side, dir, builder_fee, hash, oid, fee_token, ts)
      VALUES (@address, @tid, @coin, @closed_pnl, @fee, @px, @sz, @side, @dir, @builder_fee, @hash, @oid, @fee_token, @ts)
    `),
```

better-sqlite3 throws on a missing named parameter, so extend the defaults in `ingestTxn` — `...f` stays last so supplied values win:

```js
  const FILL_DEFAULTS = { dir: null, builder_fee: null, hash: null, oid: null, fee_token: null };

  const ingestTxn = db.transaction((address, fills) => {
    for (const f of fills) stmts.insertFill.run({ address, ...FILL_DEFAULTS, ...f });
  });
```

- [ ] **Step 6: Carry the fields through the normalizer**

In `hyperliquid.js`, in `normalizeFills`, extend the mapped row:

```js
    side: f.side ?? null,
    dir: f.dir ?? null,
    // An absent builderFee means no builder took a cut — that's 0, not unknown.
    builder_fee: parseNum(f.builderFee) ?? 0,
    hash: f.hash ?? null,
    oid: parseNum(f.oid),
    fee_token: f.feeToken ?? null,
    ts: parseNum(f.time),
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests, including the pre-existing `fills dedupe and cumulative realized` test whose fixtures omit every new key.

- [ ] **Step 8: Commit**

```bash
git add db.js hyperliquid.js test/db.test.js test/hyperliquid.test.js
git commit -m "feat(db): capture builder fee, tx hash, order id and fee token on fills"
```

---

### Task 2: `funding` table

**Goal:** Store funding payments, which are currently not recorded anywhere.

**Files:**
- Modify: `db.js` (SCHEMA, statements, `ingestFunding`, `listFunding`, purge on delete)
- Modify: `hyperliquid.js` (`normalizeFunding`, `getUserFunding`)
- Test: `test/db.test.js`, `test/hyperliquid.test.js`

**Acceptance Criteria:**
- [ ] `funding` table exists with primary key `(address, ts, coin)`
- [ ] `normalizeFunding` flattens the nested `delta` shape
- [ ] Entries whose `delta.type` is not `funding` are dropped
- [ ] Malformed entries (no `time`, no `coin`) are dropped rather than stored as nulls
- [ ] Re-ingesting the same entries inserts nothing
- [ ] `deleteWallet` purges funding along with fills and snapshots

**Verify:** `npm test` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

Append to `test/hyperliquid.test.js` (add `normalizeFunding` to the import list from `../hyperliquid.js`):

```js
test('normalizeFunding flattens delta and drops non-funding or malformed entries', () => {
  const rows = normalizeFunding([
    { time: 100, delta: { type: 'funding', coin: 'BTC', usdc: '-0.5', fundingRate: '0.0000125', szi: '2.0' } },
    { time: 200, delta: { type: 'funding', coin: 'ETH', usdc: '1.25', fundingRate: '-0.00001', szi: '-3.0' } },
    { time: 300, delta: { type: 'deposit', usdc: '100' } },        // wrong type
    { time: 400, delta: { type: 'funding', usdc: '1' } },          // no coin
    { delta: { type: 'funding', coin: 'SOL', usdc: '1' } },        // no time
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { ts: 100, coin: 'BTC', usdc: -0.5, funding_rate: 0.0000125, szi: 2 });
  assert.equal(rows[1].usdc, 1.25);
});

test('normalizeFunding tolerates a non-array', () => {
  assert.deepEqual(normalizeFunding(null), []);
  assert.deepEqual(normalizeFunding(undefined), []);
});
```

Append to `test/db.test.js`:

```js
test('funding dedupes on (address, ts, coin) and reports inserted count', () => {
  const db = freshDb();
  const rows = [
    { ts: 100, coin: 'BTC', usdc: -0.5, funding_rate: 0.0000125, szi: 2 },
    { ts: 100, coin: 'ETH', usdc: 0.25, funding_rate: 0.00001, szi: 1 },  // same ts, different coin
    { ts: 200, coin: 'BTC', usdc: -0.6, funding_rate: 0.0000125, szi: 2 },
  ];
  assert.equal(db.ingestFunding('0xabc', rows), 3);
  assert.equal(db.ingestFunding('0xabc', rows), 0, 're-ingest must insert nothing');
  assert.equal(db.listFunding('0xabc').length, 3);
  assert.equal(db.listFunding('0xabc', 150, 300).length, 1, 'range is half-open');
  // scoped per address
  db.ingestFunding('0xbbb', [{ ts: 100, coin: 'BTC', usdc: -9, funding_rate: 0, szi: 1 }]);
  assert.equal(db.listFunding('0xabc').length, 3);
});

test('deleteWallet purges funding too', () => {
  const db = freshDb();
  db.upsertWallet('0xabc', 'w');
  db.ingestFunding('0xabc', [{ ts: 100, coin: 'BTC', usdc: -0.5, funding_rate: 0, szi: 1 }]);
  db.ingestFills('0xabc', [{ tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1, side: 'A', ts: 10 }]);
  db.deleteWallet('0xabc');
  assert.equal(db.listFunding('0xabc').length, 0);
  assert.equal(db.countFills('0xabc'), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `normalizeFunding is not a function` and `db.ingestFunding is not a function`.

- [ ] **Step 3: Add the table**

In `db.js`, append to the `SCHEMA` string:

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

`userFunding` returns no unique id per entry, so this primary key does the deduping that `tid` does for fills. Funding settles hourly per coin, which makes the triple unique.

- [ ] **Step 4: Add the statements**

In `db.js`, inside `stmts`:

```js
    insertFunding: db.prepare(`
      INSERT OR IGNORE INTO funding (address, ts, coin, usdc, funding_rate, szi)
      VALUES (@address, @ts, @coin, @usdc, @funding_rate, @szi)
    `),
    listFunding: db.prepare(`
      SELECT ts, coin, usdc, funding_rate, szi FROM funding
      WHERE address = ? AND ts >= ? AND ts < ? ORDER BY ts ASC, coin ASC
    `),
    removeFunding: db.prepare(`DELETE FROM funding WHERE address = ?`),
```

- [ ] **Step 5: Add the transaction and methods**

In `db.js`, next to `ingestTxn`:

```js
  const ingestFundingTxn = db.transaction((address, rows) => {
    let inserted = 0;
    for (const r of rows) inserted += stmts.insertFunding.run({ address, ...r }).changes;
    return inserted;
  });
```

Add `stmts.removeFunding.run(address);` to `deleteWalletTxn`.

In the returned object:

```js
    // Returns the number of rows actually inserted (duplicates are ignored).
    ingestFunding(address, rows) { return rows?.length ? ingestFundingTxn(address, rows) : 0; },
    listFunding(address, from = 0, to = Number.MAX_SAFE_INTEGER) { return stmts.listFunding.all(address, from, to); },
```

- [ ] **Step 6: Add the normalizer and fetch wrapper**

In `hyperliquid.js`, after `normalizeFills`:

```js
// userFunding -> DB rows. The payload nests the interesting fields under `delta`,
// and the same endpoint carries non-funding ledger events we don't store.
export function normalizeFunding(entries) {
  const arr = Array.isArray(entries) ? entries : [];
  return arr
    .filter((e) => e?.delta?.type === 'funding')
    .map((e) => ({
      ts: parseNum(e.time),
      coin: e.delta.coin ?? null,
      usdc: parseNum(e.delta.usdc) ?? 0,
      funding_rate: parseNum(e.delta.fundingRate),
      szi: parseNum(e.delta.szi),
    }))
    .filter((r) => Number.isFinite(r.ts) && r.coin);
}
```

And next to `getUserFills`:

```js
export function getUserFunding(address, opts, startTime = 0) {
  return fetchInfo({ type: 'userFunding', user: address, startTime }, opts);
}
export function getUserFillsByTime(address, opts, startTime = 0) {
  return fetchInfo({ type: 'userFillsByTime', user: address, startTime }, opts);
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add db.js hyperliquid.js test/db.test.js test/hyperliquid.test.js
git commit -m "feat(db): store funding payments in a deduped funding table"
```

---

### Task 3: `backfillFills` enrichment upsert

**Goal:** Give the backfill a write path that fills `NULL` columns on existing rows, which `INSERT OR IGNORE` cannot do.

**Files:**
- Modify: `db.js` (statement + method)
- Test: `test/db.test.js`

**Acceptance Criteria:**
- [ ] A new fill inserts normally
- [ ] An existing row's `NULL` `dir`/`builder_fee`/`hash`/`oid`/`fee_token` are filled in
- [ ] An existing row's already-populated values are NOT overwritten
- [ ] Money columns (`closed_pnl`, `fee`, `px`, `sz`) are never rewritten
- [ ] Returns `{ scanned, inserted, enriched }` where `enriched` counts rows that had a `NULL` `dir` and no longer do

**Verify:** `npm test` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing test**

Append to `test/db.test.js`:

```js
test('backfillFills enriches null columns without overwriting existing values', () => {
  const db = freshDb();
  // a legacy row: no dir, no builder_fee, no hash
  db.ingestFills('0xabc', [{ tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.33, px: 100, sz: 1, side: 'A', ts: 10 }]);
  let row = db.raw.prepare(`SELECT * FROM fills WHERE tid = 1`).get();
  assert.equal(row.dir, null);
  assert.equal(row.builder_fee, null);

  const res = db.backfillFills('0xabc', [
    // same tid, now with the enriched fields, plus DIFFERENT money values
    { tid: 1, coin: 'BTC', closed_pnl: 999, fee: 999, px: 999, sz: 999, side: 'A',
      dir: 'Close Long', builder_fee: 0.23, hash: '0xdead', oid: 42, fee_token: 'USDC', ts: 10 },
    // a genuinely new row
    { tid: 2, coin: 'ETH', closed_pnl: 1, fee: 0.1, px: 50, sz: 2, side: 'B',
      dir: 'Open Long', builder_fee: 0.05, hash: '0xbeef', oid: 43, fee_token: 'USDC', ts: 20 },
  ]);

  assert.equal(res.scanned, 2);
  assert.equal(res.inserted, 1, 'only tid 2 is new');
  assert.equal(res.enriched, 1, 'tid 1 gained a dir');

  row = db.raw.prepare(`SELECT * FROM fills WHERE tid = 1`).get();
  assert.equal(row.dir, 'Close Long', 'null dir filled in');
  assert.equal(row.builder_fee, 0.23);
  assert.equal(row.hash, '0xdead');
  assert.equal(row.oid, 42);
  // the economics of an observed fill must never be rewritten by a later sync
  assert.equal(row.closed_pnl, 5);
  assert.equal(row.fee, 0.33);
  assert.equal(row.px, 100);
  assert.equal(row.sz, 1);
});

test('backfillFills does not overwrite an already-populated dir', () => {
  const db = freshDb();
  db.ingestFills('0xabc', [{ tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1,
    side: 'A', dir: 'Close Long', ts: 10 }]);
  const res = db.backfillFills('0xabc', [{ tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1,
    side: 'A', dir: 'WRONG', builder_fee: 0.2, hash: '0xaa', oid: 1, fee_token: 'USDC', ts: 10 }]);
  const row = db.raw.prepare(`SELECT * FROM fills WHERE tid = 1`).get();
  assert.equal(row.dir, 'Close Long', 'existing value wins');
  assert.equal(row.builder_fee, 0.2, 'but a null column is still filled');
  assert.equal(res.enriched, 0, 'dir was already set, so nothing was enriched');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `db.backfillFills is not a function`

- [ ] **Step 3: Add the statement**

In `db.js`, inside `stmts`:

```js
    // The live path uses INSERT OR IGNORE — a duplicate there is nothing to do.
    // Backfill wants the opposite: enrich rows that predate the newer columns.
    // COALESCE(existing, incoming) fills gaps without overwriting what's recorded.
    // Money columns are deliberately absent from DO UPDATE: a fill's economics are
    // fixed once observed, and a sync must never silently rewrite them.
    backfillFill: db.prepare(`
      INSERT INTO fills (address, tid, coin, closed_pnl, fee, px, sz, side, dir, builder_fee, hash, oid, fee_token, ts)
      VALUES (@address, @tid, @coin, @closed_pnl, @fee, @px, @sz, @side, @dir, @builder_fee, @hash, @oid, @fee_token, @ts)
      ON CONFLICT(address, tid) DO UPDATE SET
        dir         = COALESCE(fills.dir,         excluded.dir),
        builder_fee = COALESCE(fills.builder_fee, excluded.builder_fee),
        hash        = COALESCE(fills.hash,        excluded.hash),
        oid         = COALESCE(fills.oid,         excluded.oid),
        fee_token   = COALESCE(fills.fee_token,   excluded.fee_token)
    `),
    countFillsTotal: db.prepare(`SELECT COUNT(*) AS n FROM fills WHERE address = ?`),
    countNullDir: db.prepare(`SELECT COUNT(*) AS n FROM fills WHERE address = ? AND dir IS NULL`),
```

- [ ] **Step 4: Add the transaction and method**

In `db.js`, next to `ingestTxn`:

```js
  const backfillTxn = db.transaction((address, rows) => {
    for (const r of rows) stmts.backfillFill.run({ address, ...FILL_DEFAULTS, ...r });
  });
```

In the returned object:

```js
    // SQLite's upsert reports a change for both an insert and a no-op update, so
    // counts are derived from before/after totals instead of from `changes`.
    backfillFills(address, rows) {
      if (!rows?.length) return { scanned: 0, inserted: 0, enriched: 0 };
      const beforeTotal = stmts.countFillsTotal.get(address).n;
      const beforeNullDir = stmts.countNullDir.get(address).n;
      backfillTxn(address, rows);
      const afterTotal = stmts.countFillsTotal.get(address).n;
      const afterNullDir = stmts.countNullDir.get(address).n;
      const inserted = afterTotal - beforeTotal;
      // new rows arrive with a dir, so subtract them to leave only enriched ones
      const enriched = Math.max(0, beforeNullDir - afterNullDir);
      return { scanned: rows.length, inserted, enriched };
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add db.js test/db.test.js
git commit -m "feat(db): add backfillFills enrichment upsert that preserves observed economics"
```

---

### Task 4: `backfill.js` + backfill route

**Goal:** Page through Hyperliquid's history endpoints and sync them, without skipping same-millisecond rows or looping forever.

**Files:**
- Create: `backfill.js`
- Create: `test/backfill.test.js`
- Modify: `server.js` (route)
- Test: `test/server.test.js`

**Acceptance Criteria:**
- [ ] Advances the window on the newest timestamp seen, not `+1`, so same-millisecond rows are not skipped
- [ ] Terminates on a page that yields no new rows
- [ ] Terminates when the cursor cannot advance
- [ ] Idempotent — a second run inserts nothing
- [ ] Respects a 50-page ceiling per endpoint and reports `truncated: true`
- [ ] Route validates the address and gates on `db.hasWallet`
- [ ] Fetchers are injected, so the tests need no network

**Verify:** `npm test` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

Create `test/backfill.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { backfillWallet } from '../backfill.js';

const A = '0x' + 'a'.repeat(40);
const freshDb = () => openDb(path.join(os.tmpdir(), `hl-bf-${Date.now()}-${Math.random().toString(16).slice(2)}.db`));
const fill = (tid, ts) => ({ tid, coin: 'BTC', closed_pnl: 1, fee: 0.1, px: 100, sz: 1,
  side: 'A', dir: 'Close Long', builder_fee: 0.05, hash: '0x' + tid, oid: tid, fee_token: 'USDC', ts });

test('pages forward and does not skip same-millisecond fills', async () => {
  const db = freshDb();
  db.upsertWallet(A, 'w');
  // Page size 3. tids 2 and 3 share a timestamp and straddle the page boundary —
  // advancing the cursor to newest + 1 would drop tid 3.
  const all = [fill(1, 100), fill(2, 200), fill(3, 200), fill(4, 300)];
  const calls = [];
  const fetchFills = async (since) => {
    calls.push(since);
    return all.filter((f) => f.ts >= since).slice(0, 3);
  };
  const res = await backfillWallet(A, db, { fetchFills, fetchFunding: async () => [] });

  assert.equal(res.fills.inserted, 4, 'every fill must land, including both at ts=200');
  assert.equal(db.countFills(A), 4);
  assert.ok(calls.includes(200), 'cursor advances TO the newest ts, not past it');
  assert.equal(res.truncated, false);
});

test('is idempotent', async () => {
  const db = freshDb();
  db.upsertWallet(A, 'w');
  const all = [fill(1, 100), fill(2, 200)];
  const fetchFills = async (since) => all.filter((f) => f.ts >= since);
  const opts = { fetchFills, fetchFunding: async () => [] };

  const first = await backfillWallet(A, db, opts);
  const second = await backfillWallet(A, db, opts);
  assert.equal(first.fills.inserted, 2);
  assert.equal(second.fills.inserted, 0, 'second run inserts nothing');
  assert.equal(db.countFills(A), 2);
});

test('terminates on a page that yields nothing new', async () => {
  const db = freshDb();
  db.upsertWallet(A, 'w');
  let calls = 0;
  // always returns the same single row — a naive loop would spin forever
  const fetchFills = async () => { calls++; return [fill(1, 100)]; };
  const res = await backfillWallet(A, db, { fetchFills, fetchFunding: async () => [] });
  assert.ok(calls <= 3, `expected quick termination, made ${calls} calls`);
  assert.equal(res.truncated, false);
  assert.equal(db.countFills(A), 1);
});

test('respects the page ceiling and reports truncation', async () => {
  const db = freshDb();
  db.upsertWallet(A, 'w');
  let n = 0;
  // an endless stream of genuinely new rows with advancing timestamps
  const fetchFills = async () => { n++; return [fill(n, n * 100)]; };
  const res = await backfillWallet(A, db, { fetchFills, fetchFunding: async () => [], maxPages: 5 });
  assert.equal(res.truncated, true);
  assert.equal(n, 5, 'stops at the ceiling');
});

test('syncs funding alongside fills', async () => {
  const db = freshDb();
  db.upsertWallet(A, 'w');
  const fund = [{ ts: 100, coin: 'BTC', usdc: -0.5, funding_rate: 0.00001, szi: 2 },
                { ts: 200, coin: 'BTC', usdc: -0.6, funding_rate: 0.00001, szi: 2 }];
  const res = await backfillWallet(A, db, {
    fetchFills: async () => [],
    fetchFunding: async (since) => fund.filter((f) => f.ts >= since),
  });
  assert.equal(res.funding.inserted, 2);
  assert.equal(db.listFunding(A).length, 2);
});

test('refuses a wallet that is not on the watch list', async () => {
  const db = freshDb();
  const res = await backfillWallet(A, db, { fetchFills: async () => [fill(1, 100)], fetchFunding: async () => [] });
  assert.equal(res.skipped, true);
  assert.equal(db.countFills(A), 0, 'must not resurrect an unwatched wallet');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../backfill.js'`

- [ ] **Step 3: Write `backfill.js`**

Create `backfill.js`:

```js
// Paginated history sync for one wallet. Fetchers are injected so this is
// testable without network access and without Express.

const MAX_PAGES = 50;

// Pages one endpoint forward. `fetchPage(since)` returns normalized rows carrying
// a `ts`; `ingest(rows)` returns the number of rows actually inserted.
async function pageForward(fetchPage, ingest, from, maxPages) {
  let cursor = from;
  let scanned = 0, inserted = 0, pages = 0, truncated = false;

  while (true) {
    if (pages >= maxPages) { truncated = true; break; }
    const rows = await fetchPage(cursor);
    pages++;
    if (!Array.isArray(rows) || !rows.length) break;

    scanned += rows.length;
    const pageInserted = ingest(rows);
    inserted += pageInserted;

    const times = rows.map((r) => r.ts).filter(Number.isFinite);
    if (!times.length) break;
    const newest = Math.max(...times);

    // Advance to the newest timestamp, NOT newest + 1: several fills can share a
    // millisecond and +1 would skip the rest of them. The resulting overlap is
    // absorbed by the dedupe on insert.
    if (newest > cursor) { cursor = newest; continue; }

    // The cursor can't advance. If this page still brought new rows, try once
    // more — a repeat page inserts nothing and ends the loop on the next pass.
    // This assumes a page is never entirely filled by a single timestamp, which
    // holds at Hyperliquid's page size against realistic same-millisecond
    // clustering; if it ever didn't, the loop would stop early rather than spin.
    if (pageInserted === 0) break;
  }

  return { scanned, inserted, pages, truncated };
}

// opts: { fetchFills, fetchFunding, from = 0, maxPages = MAX_PAGES }
export async function backfillWallet(address, db, opts) {
  const { fetchFills, fetchFunding, from = 0, maxPages = MAX_PAGES } = opts;

  // Same invariant as everywhere else: nothing is persisted for a wallet that
  // isn't on the watch list, so a backfill can't resurrect a deleted one.
  if (!db.hasWallet(address)) {
    return { address, skipped: true, fills: { scanned: 0, inserted: 0, enriched: 0 }, funding: { scanned: 0, inserted: 0 }, from, truncated: false };
  }

  let enriched = 0;
  const fills = await pageForward(fetchFills, (rows) => {
    const r = db.backfillFills(address, rows);
    enriched += r.enriched;
    return r.inserted;
  }, from, maxPages);

  const funding = await pageForward(fetchFunding, (rows) => db.ingestFunding(address, rows), from, maxPages);

  return {
    address,
    skipped: false,
    fills: { scanned: fills.scanned, inserted: fills.inserted, enriched },
    funding: { scanned: funding.scanned, inserted: funding.inserted },
    from,
    truncated: fills.truncated || funding.truncated,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Add the route**

In `server.js`, add the imports:

```js
import { isValidAddress, resolveAccountAddress, getExtraAgents, normalizeExtraAgents, normalizeFills, normalizeFunding, getUserFillsByTime, getUserFunding } from './hyperliquid.js';
import { backfillWallet } from './backfill.js';
```

Add the route after `POST /api/wallets`:

```js
  app.post('/api/backfill/:address', async (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    try {
      const result = await backfillWallet(address, db, {
        fetchFills: async (since) => normalizeFills(await getUserFillsByTime(address, opts, since)).rows,
        fetchFunding: async (since) => normalizeFunding(await getUserFunding(address, opts, since)),
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: `Backfill failed: ${err.message}` });
    }
  });
```

- [ ] **Step 6: Add the route tests**

Append to `test/server.test.js`. `fakeDb` needs the new methods — add these to its returned object:

```js
    ingestFunding() { return 0; }, listFunding() { return []; },
    backfillFills() { return { scanned: 0, inserted: 0, enriched: 0 }; },
    getRange() { return { minTs: null, maxTs: null }; },
```

Then:

```js
test('POST /api/backfill rejects an invalid address', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/backfill/nope`, { method: 'POST' });
    assert.equal(res.status, 400);
  });
});

test('POST /api/backfill returns counts for a watched wallet', async () => {
  const fetchImpl = async (_url, init) => {
    const b = JSON.parse(init.body);
    if (b.type === 'userRole') return { ok: true, json: async () => ({ role: 'user' }) };
    if (b.type === 'userFillsByTime') return { ok: true, json: async () => ([]) };
    if (b.type === 'userFunding') return { ok: true, json: async () => ([]) };
    return { ok: true, json: async () => ({}) };
  };
  await withServer({ fetchImpl }, async (base) => {
    await fetch(`${base}/api/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: MASTER }) });
    const res = await fetch(`${base}/api/backfill/${MASTER}`, { method: 'POST' });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.address, MASTER);
    assert.equal(json.truncated, false);
  });
});

test('POST /api/backfill returns 502 when Hyperliquid fails', async () => {
  const fetchImpl = async (_url, init) => {
    const b = JSON.parse(init.body);
    if (b.type === 'userRole') return { ok: true, json: async () => ({ role: 'user' }) };
    return { ok: false, status: 500, text: async () => 'boom' };
  };
  await withServer({ fetchImpl }, async (base) => {
    await fetch(`${base}/api/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: MASTER }) });
    const res = await fetch(`${base}/api/backfill/${MASTER}`, { method: 'POST' });
    assert.equal(res.status, 502);
  });
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add backfill.js server.js test/backfill.test.js test/server.test.js
git commit -m "feat: paginated history backfill for fills and funding"
```

---

### Task 5: `export.js` — CSV generation

**Goal:** Turn stored fills and funding into two CSV shapes, correctly escaped and chronologically merged.

**Files:**
- Create: `export.js`
- Create: `test/export.test.js`

**Acceptance Criteria:**
- [ ] `toCsv` quotes fields containing a comma, quote, or newline and doubles internal quotes
- [ ] Fills and funding merge in chronological order
- [ ] Funding rows carry no explorer URL (their hash is zero-filled)
- [ ] Fills with a real hash carry `https://app.hyperliquid.xyz/explorer/tx/<hash>`
- [ ] Numeric precision is preserved — no display rounding
- [ ] An empty dataset yields a header row and nothing else
- [ ] `time_local` reflects the requested IANA timezone
- [ ] `buildPreamble` records wallet, range, timezone, and the not-tax-advice note
- [ ] `toCsv` emits preamble lines as `#` comments above the header when given them

**Verify:** `npm test` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

Create `test/export.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, buildPreamble, buildDetailedRows, buildKoinlyRows, DETAILED_COLUMNS, KOINLY_COLUMNS } from '../export.js';

const FILL = { tid: 1, coin: 'BTC', closed_pnl: 12.5, fee: 0.331490, builder_fee: 0.231488,
  fee_token: 'USDC', px: 81224, sz: 0.00285, side: 'A', dir: 'Close Long',
  hash: '0xabc123', oid: 422020718303, ts: Date.parse('2026-05-12T10:00:00Z') };
const FUND = { ts: Date.parse('2026-05-12T11:00:00Z'), coin: 'ETH', usdc: -0.00982,
  funding_rate: 0.0000125, szi: 130 };

test('toCsv escapes commas, quotes and newlines', () => {
  const csv = toCsv([{ a: 'x,y', b: 'say "hi"', c: 'line1\nline2', d: 'plain' }], ['a', 'b', 'c', 'd']);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'a,b,c,d');
  assert.equal(lines[1], '"x,y","say ""hi""","line1\nline2",plain');
});

test('toCsv renders null and undefined as empty, not as the strings', () => {
  const csv = toCsv([{ a: null, b: undefined, c: 0 }], ['a', 'b', 'c']);
  assert.equal(csv.split('\r\n')[1], ',,0');
});

test('toCsv with no rows still emits the header', () => {
  const csv = toCsv([], ['a', 'b']);
  assert.equal(csv, 'a,b\r\n');
});

test('toCsv emits a comment preamble above the header when given one', () => {
  const csv = toCsv([{ a: 1 }], ['a'], ['wallet: 0xabc', 'timezone: UTC']);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], '# wallet: 0xabc');
  assert.equal(lines[1], '# timezone: UTC');
  assert.equal(lines[2], 'a', 'header follows the preamble');
  assert.equal(lines[3], '1');
});

test('buildPreamble records wallet, range, timezone and the not-tax-advice note', () => {
  const lines = buildPreamble({
    address: '0xabc', from: Date.parse('2026-01-01T00:00:00Z'),
    to: Date.parse('2027-01-01T00:00:00Z'), tz: 'UTC', generatedAt: Date.parse('2026-08-11T12:00:00Z'),
  });
  const text = lines.join('\n');
  assert.match(text, /wallet: 0xabc/);
  assert.match(text, /timezone:\s+UTC/);
  assert.match(text, /not tax advice/);
  assert.match(text, /2026-01-01/);
});

test('buildPreamble renders unbounded ranges as "all"', () => {
  const text = buildPreamble({ address: '0xabc', from: null, to: null, tz: 'UTC', generatedAt: 0 }).join('\n');
  assert.match(text, /range from: all/);
  assert.match(text, /range to:\s+all/);
});

test('detailed rows merge fills and funding chronologically', () => {
  const rows = buildDetailedRows([FILL], [FUND], 'UTC');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, 'fill');
  assert.equal(rows[1].type, 'funding');
  assert.ok(rows[0].time_utc < rows[1].time_utc);
});

test('detailed fill row carries an explorer link and full precision', () => {
  const [row] = buildDetailedRows([FILL], [], 'UTC');
  assert.equal(row.explorer_url, 'https://app.hyperliquid.xyz/explorer/tx/0xabc123');
  assert.equal(row.order_id, 422020718303);
  assert.equal(row.fee, 0.331490);
  assert.equal(row.builder_fee, 0.231488);
  assert.equal(row.realized_pnl, 12.5);
  assert.equal(row.direction, 'Close Long');
  // notional is derived, not stored
  assert.equal(row.notional, 81224 * 0.00285);
});

test('funding rows have no explorer link', () => {
  const [row] = buildDetailedRows([], [FUND], 'UTC');
  assert.equal(row.type, 'funding');
  assert.equal(row.explorer_url, '');
  assert.equal(row.tx_hash, '');
  assert.equal(row.funding, -0.00982);
  assert.equal(row.realized_pnl, '');
});

test('a zero-filled hash produces no link', () => {
  const zeroHash = { ...FILL, hash: '0x' + '0'.repeat(64) };
  const [row] = buildDetailedRows([zeroHash], [], 'UTC');
  assert.equal(row.explorer_url, '');
});

test('time_local honours the requested timezone', () => {
  const [utc] = buildDetailedRows([FILL], [], 'UTC');
  const [ny] = buildDetailedRows([FILL], [], 'America/New_York');
  assert.notEqual(utc.time_local, ny.time_local);
  assert.ok(utc.time_local.startsWith('2026-05-12 10:00'));
  assert.ok(ny.time_local.startsWith('2026-05-12 06:00'), `got ${ny.time_local}`);
});

test('detailed rows use the declared column set', () => {
  const [row] = buildDetailedRows([FILL], [], 'UTC');
  for (const c of DETAILED_COLUMNS) assert.ok(c in row, `missing column ${c}`);
});

test('koinly rows split gains and losses across sent/received', () => {
  const gain = buildKoinlyRows([FILL], [], 'UTC');
  assert.equal(gain[0]['Received Amount'], 12.5);
  assert.equal(gain[0]['Received Currency'], 'USDC');
  assert.equal(gain[0]['Sent Amount'], '');
  // total fee is exchange fee plus builder fee
  assert.equal(gain[0]['Fee Amount'], 0.331490 + 0.231488);
  assert.equal(gain[0]['TxHash'], '0xabc123');

  const loss = buildKoinlyRows([{ ...FILL, closed_pnl: -4 }], [], 'UTC');
  assert.equal(loss[0]['Sent Amount'], 4);
  assert.equal(loss[0]['Received Amount'], '');
});

test('koinly rows use the declared column set', () => {
  const [row] = buildKoinlyRows([FILL], [], 'UTC');
  for (const c of KOINLY_COLUMNS) assert.ok(c in row, `missing column ${c}`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../export.js'`

- [ ] **Step 3: Write `export.js`**

Create `export.js`:

```js
// CSV generation for tax export. Pure — no DB, no Express, no network.

// Funding entries carry an all-zero hash because they're internal ledger events,
// not on-chain transactions. Linking one would produce a URL that 404s.
const ZERO_HASH = '0x' + '0'.repeat(64);
const EXPLORER = 'https://app.hyperliquid.xyz/explorer/tx/';

export const DETAILED_COLUMNS = [
  'time_utc', 'time_local', 'type', 'coin', 'direction', 'size', 'price', 'notional',
  'fee', 'builder_fee', 'fee_token', 'funding', 'realized_pnl', 'order_id', 'tx_hash', 'explorer_url',
];

export const KOINLY_COLUMNS = [
  'Date', 'Sent Amount', 'Sent Currency', 'Received Amount', 'Received Currency',
  'Fee Amount', 'Fee Currency', 'Net Worth Amount', 'Net Worth Currency',
  'Label', 'Description', 'TxHash',
];

// RFC 4180: quote anything containing a comma, quote or newline; double internal
// quotes. Builder dexes name their own markets, so don't assume coin names stay
// comma-free.
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const isoUtc = (ts) => new Date(ts).toISOString();

// 'sv-SE' yields a sortable "YYYY-MM-DD HH:mm:ss" rather than a locale-specific
// format, which matters for a file someone will sort in a spreadsheet. An invalid
// IANA name throws, so fall back rather than failing the whole export.
function localTime(ts, tz) {
  try {
    return new Date(ts).toLocaleString('sv-SE', { timeZone: tz });
  } catch {
    return new Date(ts).toLocaleString('sv-SE', { timeZone: 'UTC' });
  }
}

// `preamble` is an optional list of comment lines emitted above the header, each
// prefixed with '#' — the widely-recognised CSV comment convention (pandas
// `comment='#'`, R `comment.char='#'`). Used for the detailed export only; a
// vendor import must start at the header row.
export function toCsv(rows, columns, preamble = []) {
  const lines = preamble.map((l) => `# ${l}`);
  lines.push(columns.map(csvCell).join(','));
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

// Makes the file self-describing months later: which wallet, which range, and —
// critically — which timezone the range was computed in.
export function buildPreamble({ address, from, to, tz, generatedAt }) {
  const bound = (v) => (v == null ? 'all' : `${isoUtc(v)} (${localTime(v, tz)} ${tz})`);
  return [
    `Hyperliquid trade export`,
    `wallet: ${address}`,
    `range from: ${bound(from)}`,
    `range to:   ${bound(to)}`,
    `timezone:   ${tz}`,
    `generated:  ${isoUtc(generatedAt)}`,
    `NOTE: transaction data, not tax advice. Coverage begins when this dashboard`,
    `      first observed the wallet. Reconcile against your own records.`,
  ];
}

const explorerUrl = (hash) => (hash && hash !== ZERO_HASH ? EXPLORER + hash : '');

// fills/funding: rows as stored. Returns one row per event, oldest first.
export function buildDetailedRows(fills, funding, tz) {
  const rows = [];

  for (const f of fills) {
    const notional = (f.px != null && f.sz != null) ? f.px * f.sz : '';
    rows.push({
      _ts: f.ts,
      time_utc: isoUtc(f.ts),
      time_local: localTime(f.ts, tz),
      type: 'fill',
      coin: f.coin ?? '',
      direction: f.dir || (f.side === 'B' ? 'Buy' : f.side === 'A' ? 'Sell' : ''),
      size: f.sz ?? '',
      price: f.px ?? '',
      notional,
      fee: f.fee ?? '',
      builder_fee: f.builder_fee ?? '',
      fee_token: f.fee_token ?? '',
      funding: '',
      realized_pnl: f.closed_pnl ?? '',
      order_id: f.oid ?? '',
      tx_hash: f.hash && f.hash !== ZERO_HASH ? f.hash : '',
      explorer_url: explorerUrl(f.hash),
    });
  }

  for (const x of funding) {
    rows.push({
      _ts: x.ts,
      time_utc: isoUtc(x.ts),
      time_local: localTime(x.ts, tz),
      type: 'funding',
      coin: x.coin ?? '',
      direction: '',
      size: '',
      price: '',
      notional: '',
      fee: '',
      builder_fee: '',
      fee_token: '',
      funding: x.usdc ?? '',
      realized_pnl: '',
      order_id: '',
      tx_hash: '',
      explorer_url: '',
    });
  }

  rows.sort((a, b) => a._ts - b._ts);
  for (const r of rows) delete r._ts;
  return rows;
}

const koinlyDate = (ts, tz) => localTime(ts, tz);

// Best-effort mapping onto Koinly's generic CSV. Koinly's model is built around
// acquiring and disposing of a held asset; a perp fill is neither, so a realized
// gain is represented as a bare USDC inflow/outflow with no cost basis. Treat the
// detailed export as the source of truth and verify this before importing.
export function buildKoinlyRows(fills, funding, tz) {
  const rows = [];

  for (const f of fills) {
    const pnl = f.closed_pnl ?? 0;
    const feeTotal = (f.fee ?? 0) + (f.builder_fee ?? 0);
    rows.push({
      _ts: f.ts,
      Date: koinlyDate(f.ts, tz),
      'Sent Amount': pnl < 0 ? Math.abs(pnl) : '',
      'Sent Currency': pnl < 0 ? 'USDC' : '',
      'Received Amount': pnl > 0 ? pnl : '',
      'Received Currency': pnl > 0 ? 'USDC' : '',
      'Fee Amount': feeTotal || '',
      'Fee Currency': feeTotal ? (f.fee_token || 'USDC') : '',
      'Net Worth Amount': '',
      'Net Worth Currency': '',
      Label: 'realized gain',
      Description: `${f.dir || f.side || ''} ${f.coin ?? ''} ${f.sz ?? ''} @ ${f.px ?? ''}`.trim(),
      TxHash: f.hash && f.hash !== ZERO_HASH ? f.hash : '',
    });
  }

  for (const x of funding) {
    const usdc = x.usdc ?? 0;
    rows.push({
      _ts: x.ts,
      Date: koinlyDate(x.ts, tz),
      'Sent Amount': usdc < 0 ? Math.abs(usdc) : '',
      'Sent Currency': usdc < 0 ? 'USDC' : '',
      'Received Amount': usdc > 0 ? usdc : '',
      'Received Currency': usdc > 0 ? 'USDC' : '',
      'Fee Amount': '',
      'Fee Currency': '',
      'Net Worth Amount': '',
      'Net Worth Currency': '',
      Label: usdc < 0 ? 'margin fee' : 'realized gain',
      Description: `Funding ${x.coin ?? ''}`.trim(),
      TxHash: '',
    });
  }

  rows.sort((a, b) => a._ts - b._ts);
  for (const r of rows) delete r._ts;
  return rows;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add export.js test/export.test.js
git commit -m "feat: CSV generation for detailed and Koinly-shaped tax exports"
```

---

### Task 6: Export and range routes

**Goal:** Serve the CSVs as downloads, and tell the client which years the data spans.

**Files:**
- Modify: `db.js` (`listFillsRange`, `getRange`)
- Modify: `server.js` (two routes)
- Test: `test/db.test.js`, `test/server.test.js`

**Acceptance Criteria:**
- [ ] `GET /api/export/:address.csv` returns `text/csv` with a `Content-Disposition` filename
- [ ] `format=detailed` and `format=koinly` produce different headers; anything else is a 400
- [ ] `from`/`to` filter half-open (`ts >= from AND ts < to`); omitting both exports everything
- [ ] Invalid addresses return 400
- [ ] `GET /api/range/:address` returns `{ minTs, maxTs }` spanning fills and funding
- [ ] CSV totals reconcile with direct SQL sums over the same range
- [ ] The detailed CSV carries the `#` preamble; the Koinly CSV starts at its header

**Verify:** `npm test` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

Append to `test/db.test.js`:

```js
test('listFillsRange is half-open and getRange spans fills and funding', () => {
  const db = freshDb();
  db.ingestFills('0xabc', [
    { tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1, side: 'A', ts: 100 },
    { tid: 2, coin: 'BTC', closed_pnl: 3, fee: 0.1, px: 100, sz: 1, side: 'A', ts: 200 },
    { tid: 3, coin: 'BTC', closed_pnl: 1, fee: 0.1, px: 100, sz: 1, side: 'A', ts: 300 },
  ]);
  db.ingestFunding('0xabc', [{ ts: 50, coin: 'BTC', usdc: -1, funding_rate: 0, szi: 1 }]);

  assert.deepEqual(db.listFillsRange('0xabc', 100, 300).map((r) => r.tid), [1, 2], 'to is exclusive');
  assert.equal(db.listFillsRange('0xabc').length, 3, 'no bounds means everything');

  const range = db.getRange('0xabc');
  assert.equal(range.minTs, 50, 'funding can predate the first fill');
  assert.equal(range.maxTs, 300);
  assert.deepEqual(db.getRange('0xnothing'), { minTs: null, maxTs: null });
});
```

Append to `test/server.test.js`:

```js
test('GET /api/export returns a detailed CSV download', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/export/${FILLS_ACC}.csv?format=detailed&tz=UTC`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename=/);
    const body = await res.text();
    const lines = body.split('\r\n');
    assert.ok(lines[0].startsWith('# Hyperliquid trade export'), lines[0]);
    const header = lines.find((l) => !l.startsWith('#'));
    assert.ok(header.startsWith('time_utc,time_local,type,coin'), header);
  }, SEED_FILLS);
});

test('GET /api/export honours format=koinly and emits no preamble', async () => {
  await withServer({}, async (base) => {
    const body = await (await fetch(`${base}/api/export/${FILLS_ACC}.csv?format=koinly&tz=UTC`)).text();
    // A vendor import must start at the header row — no comment lines above it.
    assert.ok(body.startsWith('Date,Sent Amount,Sent Currency'), body.slice(0, 80));
  }, SEED_FILLS);
});

test('GET /api/export rejects an unknown format and a bad address', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/api/export/${FILLS_ACC}.csv?format=turbotax`)).status, 400);
    assert.equal((await fetch(`${base}/api/export/nope.csv?format=detailed`)).status, 400);
  }, SEED_FILLS);
});

test('GET /api/range returns the data span', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/range/${FILLS_ACC}`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.minTs, 10);
    assert.equal(json.maxTs, 30);
  }, SEED_FILLS);
});
```

`fakeDb` needs `listFillsRange` and `getRange`. Replace the placeholder `getRange` added in Task 4 and add the range lister:

```js
    listFillsRange(_address, from = 0, to = Number.MAX_SAFE_INTEGER) {
      return fills.filter((f) => f.ts >= from && f.ts < to).sort((a, b) => a.ts - b.ts);
    },
    getRange() {
      if (!fills.length) return { minTs: null, maxTs: null };
      return { minTs: Math.min(...fills.map((f) => f.ts)), maxTs: Math.max(...fills.map((f) => f.ts)) };
    },
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `db.listFillsRange is not a function`, and the export routes 404.

- [ ] **Step 3: Add the db queries**

In `db.js`, inside `stmts`:

```js
    listFillsRange: db.prepare(`
      SELECT tid, coin, closed_pnl, fee, builder_fee, fee_token, px, sz, side, dir, hash, oid, ts
      FROM fills WHERE address = ? AND ts >= ? AND ts < ? ORDER BY ts ASC, tid ASC
    `),
    rangeFills: db.prepare(`SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM fills WHERE address = ?`),
    rangeFunding: db.prepare(`SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM funding WHERE address = ?`),
```

In the returned object:

```js
    listFillsRange(address, from = 0, to = Number.MAX_SAFE_INTEGER) {
      return stmts.listFillsRange.all(address, from, to);
    },
    // Oldest and newest event across both tables, for building the year picker.
    getRange(address) {
      const f = stmts.rangeFills.get(address);
      const g = stmts.rangeFunding.get(address);
      const lows = [f.lo, g.lo].filter((v) => v != null);
      const highs = [f.hi, g.hi].filter((v) => v != null);
      return { minTs: lows.length ? Math.min(...lows) : null, maxTs: highs.length ? Math.max(...highs) : null };
    },
```

- [ ] **Step 4: Add the routes**

In `server.js`, add the import:

```js
import { toCsv, buildDetailedRows, buildKoinlyRows, DETAILED_COLUMNS, KOINLY_COLUMNS } from './export.js';
```

Add both routes after `/api/fills/:address`:

```js
  app.get('/api/range/:address', (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    res.json({ address, ...db.getRange(address) });
  });

  app.get('/api/export/:address.csv', (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    const format = String(req.query.format || 'detailed');
    if (format !== 'detailed' && format !== 'koinly') {
      return res.status(400).json({ error: `Unknown format "${format}". Expected "detailed" or "koinly".` });
    }
    // Bounds are computed client-side from the browser's timezone and sent as
    // explicit epoch ms, so server and client can't disagree on where a year starts.
    const from = toSafeInt(req.query.from, 0);
    const to = toSafeInt(req.query.to, Number.MAX_SAFE_INTEGER);
    const tz = String(req.query.tz || 'UTC');

    const fills = db.listFillsRange(address, from, to);
    const funding = db.listFunding(address, from, to);

    let csv;
    if (format === 'koinly') {
      // No preamble: a vendor import must start at the header row.
      csv = toCsv(buildKoinlyRows(fills, funding, tz), KOINLY_COLUMNS);
    } else {
      const preamble = buildPreamble({
        address,
        from: req.query.from == null ? null : from,
        to: req.query.to == null ? null : to,
        tz,
        generatedAt: Date.now(),
      });
      csv = toCsv(buildDetailedRows(fills, funding, tz), DETAILED_COLUMNS, preamble);
    }

    const label = req.query.label ? String(req.query.label).replace(/[^\w-]/g, '') : 'all';
    const filename = `hyperliquid-${address.slice(0, 10)}-${label}-${format}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  });
```

- [ ] **Step 5: Add the reconciliation test**

Append to `test/export.test.js` — this is the check that matters most, because it is the one that would catch a silently wrong tax number:

```js
test('detailed CSV totals reconcile with the source rows', async () => {
  const { openDb } = await import('../db.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const db = openDb(path.join(os.tmpdir(), `hl-recon-${Date.now()}-${Math.random().toString(16).slice(2)}.db`));
  const A = '0x' + 'c'.repeat(40);

  db.ingestFills(A, [
    { tid: 1, coin: 'BTC', closed_pnl: 12.5, fee: 0.33149, builder_fee: 0.231488, fee_token: 'USDC',
      px: 81224, sz: 0.00285, side: 'A', dir: 'Close Long', hash: '0xa', oid: 1, ts: 100 },
    { tid: 2, coin: 'ETH', closed_pnl: -4.25, fee: 0.1, builder_fee: 0.05, fee_token: 'USDC',
      px: 3000, sz: 0.1, side: 'B', dir: 'Close Short', hash: '0xb', oid: 2, ts: 200 },
  ]);
  db.ingestFunding(A, [{ ts: 150, coin: 'BTC', usdc: -0.00982, funding_rate: 0.0000125, szi: 130 }]);

  const rows = buildDetailedRows(db.listFillsRange(A), db.listFunding(A), 'UTC');
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);

  assert.equal(rows.length, 3);
  assert.equal(sum('realized_pnl'), 12.5 - 4.25);
  assert.equal(sum('fee'), 0.33149 + 0.1);
  assert.equal(sum('builder_fee'), 0.231488 + 0.05);
  assert.equal(sum('funding'), -0.00982);
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add db.js server.js test/db.test.js test/server.test.js test/export.test.js
git commit -m "feat(api): add CSV export and data-range routes"
```

---

### Task 7: Export panel UI

**Goal:** Give the dashboard a year picker, two download buttons, and a sync button.

**Files:**
- Modify: `public/index.html` (panel after Trade History)
- Modify: `public/app.js` (range fetch, year list, downloads, sync)
- Modify: `public/styles.css`

**Acceptance Criteria:**
- [ ] Year dropdown lists only years present in the data, newest first, plus **All time**
- [ ] Year bounds are computed in the browser's local timezone and sent as epoch ms
- [ ] Both download buttons trigger a file download with a sensible filename
- [ ] Sync button reports inserted and enriched counts, and says so when truncated
- [ ] Controls are disabled when no wallet is selected
- [ ] The Koinly caveat is visible next to its button, not buried

**Verify:** `npm test` still passes; `node --check public/app.js`; manual browser check per Step 5.

**Steps:**

- [ ] **Step 1: Add the markup**

In `public/index.html`, insert between the Trade History panel and the Connected Agent Wallets panel:

```html
    <section class="panel">
      <div class="panel-head">
        <h2>Export</h2>
        <button id="syncBtn" title="Fetch full history from Hyperliquid">↻ Sync full history</button>
      </div>
      <div class="export-row">
        <label for="exportYear">Period</label>
        <select id="exportYear"></select>
        <button id="exportDetailedBtn">Detailed CSV</button>
        <button id="exportKoinlyBtn">Koinly CSV</button>
      </div>
      <div id="syncResult" class="export-note"></div>
      <p class="export-note">
        Detailed CSV is the full record — every fill and funding payment, with a link to
        each trade on the Hyperliquid explorer. The Koinly file is a best-effort mapping:
        perps don't fit Koinly's buy/sell model cleanly, so check it before importing.
        Records begin when this dashboard first observed the wallet — run
        <strong>Sync full history</strong> to pull everything Hyperliquid still serves.
      </p>
    </section>
```

- [ ] **Step 2: Add the styles**

Append to `public/styles.css`:

```css
.export-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:4px}
.export-row label{color:var(--muted);font-size:12px}
.export-note{color:var(--muted);font-size:12px;margin:10px 0 0;line-height:1.6}
.export-note strong{color:var(--text)}
```

- [ ] **Step 3: Add the client logic**

In `public/app.js`, add after `loadFills`:

```js
// Year bounds are computed HERE, in the browser's timezone, and sent as explicit
// epoch ms — so the server never has to guess where the user's year starts.
function yearBounds(year) {
  return { from: new Date(year, 0, 1).getTime(), to: new Date(year + 1, 0, 1).getTime() };
}

async function loadExportYears() {
  const sel = $('exportYear');
  sel.innerHTML = '';
  if (!state.address) { sel.disabled = true; return; }
  sel.disabled = false;
  try {
    const { minTs, maxTs } = await api(`/api/range/${state.address}`);
    const opts = [];
    if (minTs != null && maxTs != null) {
      const first = new Date(minTs).getFullYear();
      const last = new Date(maxTs).getFullYear();
      for (let y = last; y >= first; y--) opts.push({ value: String(y), text: String(y) });
    }
    opts.push({ value: 'all', text: 'All time' });
    for (const o of opts) {
      const el = document.createElement('option');
      el.value = o.value; el.textContent = o.text;
      sel.appendChild(el);
    }
  } catch { /* leave the picker empty; the download buttons will report the error */ }
}

function downloadExport(format) {
  if (!state.address) return;
  const sel = $('exportYear').value;
  const params = new URLSearchParams({ format, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
  if (sel && sel !== 'all') {
    const { from, to } = yearBounds(Number(sel));
    params.set('from', String(from));
    params.set('to', String(to));
    params.set('label', sel);
  }
  // Content-Disposition makes this a download rather than a navigation.
  window.location = `/api/export/${state.address}.csv?${params}`;
}

async function syncHistory() {
  if (!state.address) return;
  const btn = $('syncBtn');
  const out = $('syncResult');
  btn.disabled = true;
  out.textContent = 'Syncing from Hyperliquid…';
  try {
    const r = await api(`/api/backfill/${state.address}`, { method: 'POST' });
    if (r.skipped) {
      out.textContent = 'Nothing synced — this wallet is not on your saved list.';
    } else {
      const bits = [`${r.fills.inserted} new fills`, `${r.fills.enriched} enriched`, `${r.funding.inserted} funding entries`];
      out.textContent = `Synced: ${bits.join(', ')}.` + (r.truncated ? ' Stopped at the page limit — run again to continue.' : '');
    }
    await loadFills();
    await loadExportYears();
  } catch (e) {
    out.textContent = `Sync failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}
```

- [ ] **Step 4: Wire it up**

In `public/app.js`, in `init`, after the fills pager wiring:

```js
  $('exportDetailedBtn').addEventListener('click', () => downloadExport('detailed'));
  $('exportKoinlyBtn').addEventListener('click', () => downloadExport('koinly'));
  $('syncBtn').addEventListener('click', syncHistory);
```

In `selectAddress`, after `await loadAgents(address);`, add:

```js
  await loadExportYears();
```

In `resetDashboard`, add so the panel clears with everything else:

```js
  $('exportYear').innerHTML = ''; $('exportYear').disabled = true;
  $('syncResult').textContent = '';
```

- [ ] **Step 5: Verify**

Run: `npm test` → all tests pass.
Run: `node --check public/app.js` → no output.

Then start the app and check in a browser:

```bash
PORT=3996 DB_PATH=./data/export-smoke.db npm start
```

- Add a wallet, click **Sync full history** → the result line reports counts.
- Trade History now shows `Open Long` / `Close Short` rather than `Buy` / `Sell` for synced rows.
- The year dropdown lists the years present plus All time.
- **Detailed CSV** downloads; open it and confirm the header row, that funding rows have an empty `explorer_url`, and that a fill's `explorer_url` opens the right transaction.
- Delete the wallet → the export controls clear.

Stop the server and remove `data/export-smoke.db*` afterwards.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "feat(ui): add export panel with year picker, CSV downloads and history sync"
```

---

### Task 8: README

**Goal:** Document the export, the funding capture, and what the record does and doesn't cover.

**Files:**
- Modify: `README.md`

**Acceptance Criteria:**
- [ ] Features list covers the export and funding capture
- [ ] The new endpoints are listed alongside the existing ones
- [ ] Limitations state that the export is transaction data, not tax advice
- [ ] Limitations state that coverage depends on what Hyperliquid still serves

**Verify:** `npm test` → all tests pass (docs only, but confirm no regression)

**Steps:**

- [ ] **Step 1: Add the feature bullets**

In `README.md`, after the "Trade history" bullet:

```markdown
- **Funding payments** — captured alongside fills and included in exports. On perps
  these are a real cash flow, often more numerous than the trades themselves.
- **CSV export for tax** — download a full transaction record for a calendar year
  or all time, with each trade linked to its transaction on the Hyperliquid
  explorer. A Koinly-shaped file is also offered.
- **Sync full history** — pulls everything Hyperliquid still serves via
  `userFillsByTime` and `userFunding`, filling in direction, builder fees, and
  transaction hashes on rows recorded before those were captured.
```

- [ ] **Step 2: Document the endpoints**

In the "Hyperliquid endpoints used" REST list:

```markdown
  - `{ "type": "userFillsByTime", "user": "0x…", "startTime": … }` — paginated
    historical fills, used by **Sync full history**.
  - `{ "type": "userFunding", "user": "0x…", "startTime": … }` — funding payment
    ledger.
```

- [ ] **Step 3: Add the limitations**

In the Limitations list:

```markdown
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
  as a bare USDC inflow or outflow with no cost basis. Verify it before importing.
```

- [ ] **Step 4: Verify and commit**

Run: `npm test`
Expected: PASS

```bash
git add README.md
git commit -m "docs: document tax export, funding capture and coverage limits"
```

---

## Deviations from the spec

Three, all deliberate. Recorded so the spec and plan can be reconciled later.

1. **Backfill reports `enriched`, not `updated`.** SQLite's upsert reports a change
   for a no-op `DO UPDATE` exactly as it does for a real one, so an honest
   "updated" count isn't cheaply computable — it would mostly count rows where
   nothing happened. `enriched` counts rows that had a `NULL` `dir` and no longer
   do, which is the number that actually answers "did the sync fix my old rows?".

2. **The preamble is on the detailed CSV only.** The spec asked for a
   self-describing header line without saying where. A comment line above the
   header breaks a vendor import, so Koinly's file starts at its header row and
   the metadata lives on the artifact meant for a human.

3. **`ws-server.js` is not touched.** The spec's file list included it for
   "gate funding ingest on hasWallet", but the WebSocket stream carries no funding
   channel — funding only ever arrives through the backfill, which already gates
   on `db.hasWallet`. There is nothing there to gate.

## Known limitation

Timestamp-cursor pagination cannot page past a cluster of same-timestamp rows
larger than one page. At Hyperliquid's page size against realistic
same-millisecond clustering this cannot occur, and the loop stops early rather
than spinning if it ever did. Keyset pagination on `(ts, tid)` would be immune,
but the endpoint does not offer that cursor.

## Done criteria

- [ ] `npm test` passes
- [ ] **Sync full history** fills in `dir`, `builder_fee`, and `hash` on pre-existing rows
- [ ] Detailed CSV totals reconcile with direct SQL sums over the same range
- [ ] Every fill row carries a working explorer link; funding rows carry none
- [ ] Year boundaries are computed in the browser's timezone and stated in the request
- [ ] README states plainly that this is transaction data, not tax advice
