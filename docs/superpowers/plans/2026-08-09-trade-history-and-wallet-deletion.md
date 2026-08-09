# Trade History & Wallet Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the already-persisted `fills` table as a paginated, filterable Trade History panel with live append, and make wallet deletion purge stored data and stop the upstream subscription.

**Architecture:** The `fills` table is already written on every REST load and every live `userFills` event but has no read path. This plan adds a `dir` column for readable directions, two paginated query methods, one `GET /api/fills/:address` route, and a client panel. Deletion becomes a three-table transaction paired with a new `stream.untrack()` — without the untrack, the live `userFills` subscription re-inserts fills immediately after purge, so the two ship together.

**Tech Stack:** Node 18+ ESM, Express 4, better-sqlite3 (synchronous prepared statements), `ws`, vanilla DOM frontend, `node --test` with `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-09-trade-history-and-wallet-deletion-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `db.js` | SQLite schema, migrations, all prepared statements | `dir` column + migration; `listFills`/`countFills`; `deleteWallet` transaction |
| `hyperliquid.js` | REST client + normalizers | `normalizeFills` carries `dir` |
| `hl-stream.js` | Upstream HL WebSocket | new `untrack(address)` |
| `server.js` | Express routes | `GET /api/fills/:address`; DELETE validation + purge + untrack; accept `stream` in overrides |
| `ws-server.js` | Browser WS hub | include new fill rows in the existing `realized` broadcast |
| `public/index.html` | Markup | Trade History panel; labeled delete control |
| `public/app.js` | Client logic | fills fetch/render/paginate/filter; live append; post-delete reset |
| `public/styles.css` | Dark theme | panel footer, pager, left-aligned direction column |
| `README.md` | Docs | document panel + that deletion purges |
| `test/*.test.js` | Coverage | db, server, hl-stream, hyperliquid |

Task order: backend for fills (1–3) → fills UI (4) → live append (5) → deletion backend (6) → deletion UI + docs (7). Tasks 6–7 are independent of 1–5 and may be done first if preferred.

---

### Task 1: Store fill direction (`dir`)

**Goal:** Persist Hyperliquid's human-readable `dir` on every fill, with an additive migration for existing databases.

**Files:**
- Modify: `db.js` (SCHEMA, migration block, `insertFill`, `ingestTxn`)
- Modify: `hyperliquid.js:80-94` (`normalizeFills`)
- Test: `test/db.test.js`, `test/hyperliquid.test.js`

**Acceptance Criteria:**
- [ ] Fresh databases create `fills` with a `dir TEXT` column
- [ ] Pre-existing databases gain the column without losing rows
- [ ] `normalizeFills` carries `dir` through and yields `null` when absent
- [ ] Callers that omit `dir` (existing tests) still insert successfully

**Verify:** `npm test` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

Append to `test/hyperliquid.test.js`:

```js
test('normalizeFills carries dir and tolerates its absence', () => {
  const { rows } = normalizeFills([
    { tid: 1, coin: 'BTC', closedPnl: '5', fee: '0.1', px: '100', sz: '1', side: 'A', dir: 'Close Long', time: 10 },
    { tid: 2, coin: 'ETH', closedPnl: '0', fee: '0.1', px: '50', sz: '2', side: 'B', time: 20 },
  ]);
  assert.equal(rows[0].dir, 'Close Long');
  assert.equal(rows[1].dir, null);
});
```

Ensure `normalizeFills` is in that file's import list from `../hyperliquid.js`.

Append to `test/db.test.js`:

```js
test('migration adds dir to a pre-existing fills table', async () => {
  const Database = (await import('better-sqlite3')).default;
  const p = path.join(os.tmpdir(), `hl-fills-migrate-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const old = new Database(p);
  old.exec(`CREATE TABLE fills (address TEXT NOT NULL, tid INTEGER NOT NULL, coin TEXT,
    closed_pnl REAL, fee REAL, px REAL, sz REAL, side TEXT, ts INTEGER, PRIMARY KEY (address, tid))`);
  old.prepare(`INSERT INTO fills (address, tid, coin, closed_pnl, fee, px, sz, side, ts)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('0xold', 1, 'BTC', 5, 0.1, 100, 1, 'B', 10);
  old.close();
  const db = openDb(p);
  const rows = db.raw.prepare(`SELECT tid, dir FROM fills WHERE address = ?`).all('0xold');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dir, null);
});

test('ingestFills stores dir and defaults it when the caller omits it', () => {
  const db = freshDb();
  db.ingestFills('0xabc', [
    { tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1, side: 'A', dir: 'Close Long', ts: 10 },
    { tid: 2, coin: 'ETH', closed_pnl: 0, fee: 0.1, px: 50, sz: 2, side: 'B', ts: 20 },
  ]);
  const rows = db.raw.prepare(`SELECT tid, dir FROM fills WHERE address = ? ORDER BY tid`).all('0xabc');
  assert.equal(rows[0].dir, 'Close Long');
  assert.equal(rows[1].dir, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `no such column: dir` from the db tests, and `rows[0].dir` is `undefined` in the hyperliquid test.

- [ ] **Step 3: Add `dir` to the schema**

In `db.js`, in the `SCHEMA` string, change the `fills` table definition to include `dir` after `side`:

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
  ts INTEGER,
  PRIMARY KEY (address, tid)
);
```

- [ ] **Step 4: Add the migration**

In `db.js`, directly after the existing `wallets.via_agent` migration block, add:

```js
  // Migration: add fills.dir to DBs created before trade-history support.
  const fillCols = db.prepare(`PRAGMA table_info(fills)`).all();
  if (!fillCols.some((c) => c.name === 'dir')) {
    db.exec(`ALTER TABLE fills ADD COLUMN dir TEXT`);
  }
```

- [ ] **Step 5: Write `dir` on insert**

In `db.js`, update the `insertFill` prepared statement:

```js
    insertFill: db.prepare(`
      INSERT OR IGNORE INTO fills (address, tid, coin, closed_pnl, fee, px, sz, side, dir, ts)
      VALUES (@address, @tid, @coin, @closed_pnl, @fee, @px, @sz, @side, @dir, @ts)
    `),
```

better-sqlite3 throws on a missing named parameter, so give `dir` a default in the transaction. In `db.js`, update `ingestTxn` — `...f` comes last so a supplied `dir` wins:

```js
  const ingestTxn = db.transaction((address, fills) => {
    for (const f of fills) stmts.insertFill.run({ address, dir: null, ...f });
  });
```

- [ ] **Step 6: Carry `dir` through the normalizer**

In `hyperliquid.js`, in `normalizeFills`, add `dir` to the mapped row after `side`:

```js
    side: f.side ?? null,
    dir: f.dir ?? null,
    ts: parseNum(f.time),
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests, including the pre-existing `fills dedupe and cumulative realized` test whose fixtures omit `dir`.

- [ ] **Step 8: Commit**

```bash
git add db.js hyperliquid.js test/db.test.js test/hyperliquid.test.js
git commit -m "feat(db): store Hyperliquid fill direction with additive migration"
```

---

### Task 2: Paginated fill queries

**Goal:** Add `listFills` and `countFills` to the db handle, with stable ordering and a closes-only filter.

**Files:**
- Modify: `db.js` (prepared statements + returned methods)
- Test: `test/db.test.js`

**Acceptance Criteria:**
- [ ] `listFills` returns newest-first, ordered by `ts DESC, tid DESC` so pagination is stable when timestamps collide
- [ ] `limit`/`offset` page correctly with no duplicated or skipped rows
- [ ] `closesOnly` returns only rows with `closed_pnl != 0`
- [ ] `countFills` agrees with the unpaginated `listFills` length under the same filter

**Verify:** `npm test` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing test**

Append to `test/db.test.js`:

```js
test('listFills paginates newest-first with stable ordering and closesOnly filter', () => {
  const db = freshDb();
  // tids 3 and 4 share a timestamp — ordering must still be total
  db.ingestFills('0xabc', [
    { tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1, side: 'A', dir: 'Close Long', ts: 10 },
    { tid: 2, coin: 'BTC', closed_pnl: 0, fee: 0.1, px: 100, sz: 1, side: 'B', dir: 'Open Long', ts: 20 },
    { tid: 3, coin: 'ETH', closed_pnl: -2, fee: 0.1, px: 50, sz: 2, side: 'A', dir: 'Close Long', ts: 30 },
    { tid: 4, coin: 'ETH', closed_pnl: 0, fee: 0.1, px: 50, sz: 2, side: 'B', dir: 'Open Long', ts: 30 },
  ]);

  const all = db.listFills('0xabc', { limit: 50, offset: 0 });
  assert.deepEqual(all.map((r) => r.tid), [4, 3, 2, 1]);
  assert.equal(db.countFills('0xabc'), 4);

  // pagination covers every row exactly once
  const p1 = db.listFills('0xabc', { limit: 2, offset: 0 });
  const p2 = db.listFills('0xabc', { limit: 2, offset: 2 });
  assert.deepEqual(p1.map((r) => r.tid), [4, 3]);
  assert.deepEqual(p2.map((r) => r.tid), [2, 1]);

  const closes = db.listFills('0xabc', { limit: 50, offset: 0, closesOnly: true });
  assert.deepEqual(closes.map((r) => r.tid), [3, 1]);
  assert.equal(db.countFills('0xabc', { closesOnly: true }), closes.length);

  // rows carry the columns the UI renders
  assert.equal(all[0].coin, 'ETH');
  assert.equal(all[0].dir, 'Open Long');
  assert.equal(all[0].fee, 0.1);
});

test('listFills is scoped to one address', () => {
  const db = freshDb();
  db.ingestFills('0xaaa', [{ tid: 1, coin: 'BTC', closed_pnl: 1, fee: 0, px: 1, sz: 1, side: 'A', dir: 'Close Long', ts: 1 }]);
  db.ingestFills('0xbbb', [{ tid: 2, coin: 'ETH', closed_pnl: 2, fee: 0, px: 1, sz: 1, side: 'A', dir: 'Close Long', ts: 2 }]);
  assert.equal(db.countFills('0xaaa'), 1);
  assert.equal(db.listFills('0xaaa', { limit: 50, offset: 0 })[0].coin, 'BTC');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `db.listFills is not a function`

- [ ] **Step 3: Add the prepared statements**

In `db.js`, inside the `stmts` object, after `cumulativeRealized`, add four statements. `closesOnly` needs a different `WHERE`, and prepared statements are precompiled, so each variant gets its own statement rather than string-building SQL at call time:

```js
    listFillsAll: db.prepare(`
      SELECT tid, coin, closed_pnl, fee, px, sz, side, dir, ts FROM fills
      WHERE address = ? ORDER BY ts DESC, tid DESC LIMIT ? OFFSET ?
    `),
    listFillsCloses: db.prepare(`
      SELECT tid, coin, closed_pnl, fee, px, sz, side, dir, ts FROM fills
      WHERE address = ? AND closed_pnl != 0 ORDER BY ts DESC, tid DESC LIMIT ? OFFSET ?
    `),
    countFillsAll: db.prepare(`SELECT COUNT(*) AS n FROM fills WHERE address = ?`),
    countFillsCloses: db.prepare(`SELECT COUNT(*) AS n FROM fills WHERE address = ? AND closed_pnl != 0`),
```

- [ ] **Step 4: Expose the methods**

In `db.js`, in the returned object, after `cumulativeRealized`, add:

```js
    listFills(address, { limit = 50, offset = 0, closesOnly = false } = {}) {
      return (closesOnly ? stmts.listFillsCloses : stmts.listFillsAll).all(address, limit, offset);
    },
    countFills(address, { closesOnly = false } = {}) {
      return (closesOnly ? stmts.countFillsCloses : stmts.countFillsAll).get(address).n;
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add db.js test/db.test.js
git commit -m "feat(db): add paginated listFills/countFills with closes-only filter"
```

---

### Task 3: `GET /api/fills/:address`

**Goal:** Expose the paginated fills query over HTTP with address validation and server-side clamping.

**Files:**
- Modify: `server.js` (new route after `/api/history/:address`)
- Test: `test/server.test.js` (route tests + `fakeDb` additions)

**Acceptance Criteria:**
- [ ] Invalid addresses return 400, matching every other address-bearing route
- [ ] `limit` defaults to 50 and clamps to 1–200; `offset` defaults to 0 and clamps to `>= 0`
- [ ] `closesOnly` is true only for the exact string `"true"`
- [ ] Response is `{ address, fills, total, limit, offset }`

**Verify:** `npm test` → all tests pass

**Steps:**

- [ ] **Step 1: Extend the test double**

In `test/server.test.js`, `fakeDb` currently returns no fills methods. Change it to accept seed fills and implement the two new methods, so route tests exercise real paging arithmetic:

```js
function fakeDb(fills = []) {
  const wallets = [];
  const match = (f, closesOnly) => !closesOnly || f.closed_pnl !== 0;
  return {
    upsertWallet(address, label = null, viaAgent = null) {
      const existing = wallets.find((w) => w.address === address);
      if (existing) { if (label != null) existing.label = label; if (viaAgent != null) existing.via_agent = viaAgent; }
      else wallets.push({ address, label, via_agent: viaAgent });
    },
    listWallets() { return wallets; },
    removeWallet() {}, ingestFills() {}, cumulativeRealized() { return 0; },
    getHistory() { return []; }, insertSnapshotThrottled() { return false; },
    listFills(address, { limit = 50, offset = 0, closesOnly = false } = {}) {
      return fills.filter((f) => match(f, closesOnly))
        .sort((a, b) => b.ts - a.ts || b.tid - a.tid)
        .slice(offset, offset + limit);
    },
    countFills(_address, { closesOnly = false } = {}) {
      return fills.filter((f) => match(f, closesOnly)).length;
    },
  };
}
```

`withServer` must pass the seed through. Change its signature:

```js
async function withServer(overrides, fn, fills = []) {
  const server = createApp(fakeDb(fills), overrides).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.close(); }
}
```

The `fills` parameter is last with a default, so all existing two-argument `withServer` calls keep working unchanged.

- [ ] **Step 2: Write the failing tests**

Append to `test/server.test.js`:

```js
const FILLS_ACC = '0x' + '6'.repeat(40);
const SEED_FILLS = [
  { tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1, side: 'A', dir: 'Close Long', ts: 10 },
  { tid: 2, coin: 'BTC', closed_pnl: 0, fee: 0.1, px: 100, sz: 1, side: 'B', dir: 'Open Long', ts: 20 },
  { tid: 3, coin: 'ETH', closed_pnl: -2, fee: 0.1, px: 50, sz: 2, side: 'A', dir: 'Close Long', ts: 30 },
];

test('GET /api/fills returns paginated fills with a total', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/fills/${FILLS_ACC}?limit=2&offset=0`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.address, FILLS_ACC);
    assert.deepEqual(json.fills.map((f) => f.tid), [3, 2]);
    assert.equal(json.total, 3);
    assert.equal(json.limit, 2);
    assert.equal(json.offset, 0);
  }, SEED_FILLS);
});

test('GET /api/fills honors closesOnly only for the exact string "true"', async () => {
  await withServer({}, async (base) => {
    const on = await (await fetch(`${base}/api/fills/${FILLS_ACC}?closesOnly=true`)).json();
    assert.deepEqual(on.fills.map((f) => f.tid), [3, 1]);
    assert.equal(on.total, 2);
    const off = await (await fetch(`${base}/api/fills/${FILLS_ACC}?closesOnly=yes`)).json();
    assert.equal(off.total, 3);
  }, SEED_FILLS);
});

test('GET /api/fills clamps limit and offset', async () => {
  await withServer({}, async (base) => {
    const big = await (await fetch(`${base}/api/fills/${FILLS_ACC}?limit=9999`)).json();
    assert.equal(big.limit, 200);
    const zero = await (await fetch(`${base}/api/fills/${FILLS_ACC}?limit=0`)).json();
    assert.equal(zero.limit, 50); // 0 is falsy -> default, then clamped into range
    const neg = await (await fetch(`${base}/api/fills/${FILLS_ACC}?offset=-5`)).json();
    assert.equal(neg.offset, 0);
  }, SEED_FILLS);
});

test('GET /api/fills rejects an invalid address', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/fills/nope`);
    assert.equal(res.status, 400);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — the fills route returns the static-file 404 handler, not JSON, so `res.status` is 404.

- [ ] **Step 4: Add the route**

In `server.js`, immediately after the `/api/history/:address` route, add:

```js
  app.get('/api/fills/:address', (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    // Clamp server-side so a hand-crafted request can't ask for the whole table.
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const closesOnly = req.query.closesOnly === 'true';
    res.json({
      address,
      fills: db.listFills(address, { limit, offset, closesOnly }),
      total: db.countFills(address, { closesOnly }),
      limit,
      offset,
    });
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat(api): add GET /api/fills with validation, paging and closes filter"
```

---

### Task 4: Trade History panel UI

**Goal:** Render stored fills in a paginated, filterable panel below Open Positions.

**Files:**
- Modify: `public/index.html:36` (id on the chart toggle), `public/index.html:56` (new `<section>` after the Open Positions panel)
- Modify: `public/styles.css` (pager, panel footer, direction column alignment)
- Modify: `public/app.js:175-179` (scope the chart toggle selector), plus state, fetch, render, event wiring

**Acceptance Criteria:**
- [ ] The chart series toggle still works and is unaffected by the new filter buttons
- [ ] Panel shows Time, Coin, Direction, Size, Price, Fee, Realized PnL
- [ ] Realized PnL uses the existing pos/neg coloring and shows `—` for fills that closed nothing
- [ ] Direction falls back to Buy/Sell from `side` when `dir` is null (pre-migration rows)
- [ ] "Closes only" toggle filters and resets to offset 0
- [ ] Prev/next paginate; range reads `X–Y of N`; buttons disable at the ends
- [ ] Selecting a different wallet reloads the panel from offset 0

**Verify:** `npm start`, open <http://localhost:3000>, select a wallet with trade history → rows render, toggle filters, pager moves. `npm test` still passes.

**Steps:**

- [ ] **Step 1: Scope the existing chart toggle**

`public/app.js:175` wires the chart series toggle with `document.querySelectorAll('.toggle button')`. The Trade History filter added below reuses the `.toggle` class for styling, so that selector would also match the new buttons and fire the chart handler on them — setting `state.series` to `undefined` and redrawing the chart with zeroed points. Scope it first.

In `public/index.html`, give the chart's toggle an id (line 36):

```html
        <div class="toggle" id="chartToggle">
```

In `public/app.js`, in `init`, narrow both selectors in the chart-toggle wiring block (lines 175-179):

```js
  document.querySelectorAll('#chartToggle button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#chartToggle button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active'); state.series = b.dataset.series; drawChart();
    }));
```

- [ ] **Step 2: Add the markup**

In `public/index.html`, insert this section between the Open Positions panel (closing `</section>` on line 56) and the Connected Agent Wallets panel:

```html
    <section class="panel">
      <div class="panel-head">
        <h2>Trade History</h2>
        <div class="toggle">
          <button id="fillsAllBtn" class="active">All fills</button>
          <button id="fillsClosesBtn">Closes only</button>
        </div>
      </div>
      <div id="fillsWrap">
        <table id="fills">
          <thead><tr>
            <th>Time</th><th>Coin</th><th>Direction</th><th>Size</th>
            <th>Price</th><th>Fee</th><th>Realized PnL</th>
          </tr></thead>
          <tbody></tbody>
        </table>
        <div id="fillsEmpty" class="empty hidden">No trades recorded yet.</div>
      </div>
      <div class="pager">
        <button id="fillsPrev">‹ Newer</button>
        <span id="fillsRange" class="pager-range">—</span>
        <button id="fillsNext">Older ›</button>
      </div>
    </section>
```

- [ ] **Step 3: Add the styles**

Append to `public/styles.css`:

```css
.pager{display:flex;justify-content:center;align-items:center;gap:12px;margin-top:12px}
.pager button{padding:5px 12px;border-radius:8px;font-size:12px}
.pager button:disabled{opacity:.4;cursor:default;border-color:var(--line)}
.pager-range{color:var(--muted);font-size:12px;min-width:120px;text-align:center}
/* Direction reads as a label, not a number — left-align it like Time and Coin. */
#fills th:nth-child(3),#fills td:nth-child(3){text-align:left}
```

- [ ] **Step 4: Add fills state**

In `public/app.js`, extend the `state` object on line 8 with a `fills` sub-object. `tids` is a `Set` used to dedupe live appends in Task 5:

```js
const state = { address: null, ws: null, pollTimer: null, refreshTimer: null, series: 'equity', history: [], wsConnected: false, walletMeta: {},
  fills: { rows: [], total: 0, limit: 50, offset: 0, closesOnly: false, tids: new Set() } };
```

- [ ] **Step 5: Add render + load functions**

In `public/app.js`, add after `renderAccount` (which ends on line 49):

```js
// Pre-migration rows have no dir; fall back to the raw HL side (B = bid/buy, A = ask/sell).
const dirText = (f) => f.dir || (f.side === 'B' ? 'Buy' : f.side === 'A' ? 'Sell' : '—');
const fmtTime = (ts) => ts == null ? '—' : new Date(ts).toLocaleString();

function fillRowHtml(f) {
  return `
    <td>${fmtTime(f.ts)}</td>
    <td>${esc(f.coin ?? '—')}</td>
    <td>${esc(dirText(f))}</td>
    <td>${fmtNum(f.sz)}</td>
    <td>${fmtNum(f.px, 2)}</td>
    <td>${fmtUsd(f.fee)}</td>
    <td class="${cls(f.closed_pnl)}">${f.closed_pnl ? fmtUsd(f.closed_pnl) : '—'}</td>`;
}

function renderFills() {
  const f = state.fills;
  const tbody = $('fills').querySelector('tbody');
  tbody.innerHTML = '';
  $('fillsEmpty').classList.toggle('hidden', f.rows.length > 0);
  for (const row of f.rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = fillRowHtml(row);
    tbody.appendChild(tr);
  }
  const first = f.total === 0 ? 0 : f.offset + 1;
  const last = Math.min(f.offset + f.rows.length, f.total);
  $('fillsRange').textContent = f.total === 0 ? '—' : `${first}–${last} of ${f.total}`;
  $('fillsPrev').disabled = f.offset === 0;
  $('fillsNext').disabled = f.offset + f.limit >= f.total;
}

async function loadFills() {
  if (!state.address) { state.fills.rows = []; state.fills.total = 0; renderFills(); return; }
  const f = state.fills;
  try {
    const q = `limit=${f.limit}&offset=${f.offset}&closesOnly=${f.closesOnly}`;
    const data = await api(`/api/fills/${state.address}?${q}`);
    f.rows = data.fills;
    f.total = data.total;
    f.tids = new Set(data.fills.map((r) => r.tid));
    renderFills();
  } catch (err) { showError(err.message); }
}
```

- [ ] **Step 6: Load fills on refresh and on wallet change**

In `public/app.js`, in `refresh`, add the fills load after `loadHistory` (currently line 145):

```js
    const data = await api(`/api/account/${state.address}`);
    renderAccount(data);
    await loadHistory();
    await loadFills();
```

In `selectAddress`, reset paging and filter state before refreshing so a new wallet starts at page 1 (currently line 165):

```js
async function selectAddress(address) {
  state.address = address; state.history = [];
  state.fills.offset = 0; state.fills.tids = new Set();
  renderWalletBadge(address);
  await refresh(true);
  await loadAgents(address);
  if (state.wsConnected) state.ws.send(JSON.stringify({ type: 'watch', address }));
}
```

- [ ] **Step 7: Wire the controls**

In `public/app.js`, inside `init`, after the chart-toggle wiring block (which ends on line 179), add:

```js
  // fills filter toggle
  const setFillsFilter = (closesOnly, activeBtn) => {
    document.querySelectorAll('#fillsAllBtn, #fillsClosesBtn').forEach((b) => b.classList.remove('active'));
    activeBtn.classList.add('active');
    state.fills.closesOnly = closesOnly;
    state.fills.offset = 0;
    loadFills();
  };
  $('fillsAllBtn').addEventListener('click', (e) => setFillsFilter(false, e.currentTarget));
  $('fillsClosesBtn').addEventListener('click', (e) => setFillsFilter(true, e.currentTarget));
  $('fillsPrev').addEventListener('click', () => {
    state.fills.offset = Math.max(0, state.fills.offset - state.fills.limit);
    loadFills();
  });
  $('fillsNext').addEventListener('click', () => {
    if (state.fills.offset + state.fills.limit < state.fills.total) {
      state.fills.offset += state.fills.limit;
      loadFills();
    }
  });
```

- [ ] **Step 8: Verify in the browser**

Run: `npm start`, open <http://localhost:3000>, select a wallet that has traded.
Expected: Trade History rows render newest-first; "Closes only" hides opening fills and the range label updates; prev is disabled on page 1; next advances and disables on the last page.

Run: `npm test`
Expected: PASS (no server-side change in this task, but confirm nothing regressed).

- [ ] **Step 9: Commit**

```bash
git add public/index.html public/styles.css public/app.js
git commit -m "feat(ui): add paginated, filterable Trade History panel"
```

---

### Task 5: Live-append new fills

**Goal:** Push newly observed fills into the panel over the existing WebSocket without a refetch.

**Files:**
- Modify: `ws-server.js:24-29` (include rows in the existing broadcast)
- Modify: `public/app.js` (handle rows in the `realized` message)

**Acceptance Criteria:**
- [ ] One upstream fills event produces one downstream message (no second broadcast)
- [ ] Rows already rendered are not duplicated (dedupe by `tid`)
- [ ] Rows append only at offset 0 and only when they match the active filter
- [ ] `total` increments so the pager stays accurate
- [ ] Appending respects `limit` — the page does not grow unbounded

**Verify:** `npm test` → all tests pass. Manually: with the dashboard open on a wallet that is actively trading, a new fill appears at the top of Trade History without a page refresh.

**Steps:**

- [ ] **Step 1: Write the test for the broadcast contract**

The rows the hub broadcasts are exactly what `normalizeFills` emits, so pin that contract in `test/hl-stream.test.js`. Append:

```js
test('normalized fill rows carry the fields the hub broadcasts', async () => {
  const { stream, getWs } = makeStream();
  stream.start();
  await new Promise((r) => setTimeout(r, 5));
  stream.track(ADDR);
  const got = new Promise((resolve) => stream.on('fills', resolve));
  getWs().emit('message', JSON.stringify({
    channel: 'userFills',
    data: { user: ADDR, fills: [
      { tid: 9, coin: 'BTC', closedPnl: '3', fee: '0.1', px: '100', sz: '1', side: 'A', dir: 'Close Long', time: 5 },
    ] },
  }));
  const evt = await got;
  assert.equal(evt.rows[0].dir, 'Close Long');
  assert.equal(evt.rows[0].coin, 'BTC');
  assert.equal(evt.rows[0].ts, 5);
});
```

- [ ] **Step 2: Run the test**

Run: `npm test`
Expected: PASS — this pins the contract Task 1 established rather than driving new code. If it fails with `evt.rows[0].dir` being `undefined`, Task 1's `normalizeFills` change is missing; fix that before continuing.

- [ ] **Step 3: Include rows in the broadcast**

In `ws-server.js`, update the `fills` handler. The rows ride along on the existing message rather than triggering a second broadcast:

```js
  // Persist + relay live fills. Rows ride along on this message so one upstream
  // event produces exactly one downstream message.
  stream.on('fills', ({ address, rows, recentRealized }) => {
    if (!address) return;
    db.ingestFills(address, rows);
    broadcast(address, { type: 'realized',
      realizedPnlCumulative: db.cumulativeRealized(address), realizedPnlRecent: recentRealized, fills: rows });
  });
```

- [ ] **Step 4: Append on the client**

In `public/app.js`, add this function after `loadFills`.

Two subtleties it handles: `total` is incremented by the count of fills matching the *active filter*, not by every fresh fill — otherwise a non-closing fill would inflate the total while "closes only" is on and the pager would offer an empty page. And the spliced page is re-sliced to `limit` so it cannot grow unbounded over a long session.

```js
// Append live fills to the visible page. Only splices rows in at offset 0 — on any
// other page they're already committed to the DB and appear on navigation.
function appendLiveFills(rows) {
  const f = state.fills;
  if (!Array.isArray(rows) || !rows.length) return;
  const fresh = rows.filter((r) => r && Number.isFinite(r.tid) && !f.tids.has(r.tid));
  if (!fresh.length) return;
  for (const r of fresh) f.tids.add(r.tid);
  const matching = fresh.filter((r) => !f.closesOnly || r.closed_pnl !== 0);
  f.total += matching.length;
  if (f.offset !== 0) { renderFills(); return; }
  if (matching.length) {
    matching.sort((a, b) => b.ts - a.ts || b.tid - a.tid);
    f.rows = [...matching, ...f.rows].slice(0, f.limit);
  }
  renderFills();
}
```

- [ ] **Step 5: Hook it to the WS message**

In `public/app.js`, in `connectWs`'s `onmessage`, extend the `realized` branch:

```js
    else if (msg.type === 'realized') {
      $('rPnl').textContent = fmtUsd(msg.realizedPnlCumulative);
      $('rPnl').className = 'card-value ' + cls(msg.realizedPnlCumulative);
      appendLiveFills(msg.fills);
    }
```

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add ws-server.js public/app.js test/hl-stream.test.js
git commit -m "feat: live-append new fills to Trade History over the existing socket"
```

---

### Task 6: Purge on delete + `stream.untrack`

**Goal:** Make wallet deletion remove the wallet's snapshots and fills, stop its upstream subscription, and validate its address.

**Files:**
- Modify: `db.js` (`deleteWallet` transaction, replacing `removeWallet`)
- Modify: `hl-stream.js:73-75` (new `untrack`)
- Modify: `server.js` (destructure `stream` from overrides; DELETE route; wire stream at startup)
- Test: `test/db.test.js`, `test/hl-stream.test.js`, `test/server.test.js`

**Acceptance Criteria:**
- [ ] `deleteWallet` removes rows from `wallets`, `snapshots`, and `fills` in one transaction
- [ ] Other wallets' data is untouched
- [ ] `untrack` sends `unsubscribe` and drops the address from the reconnect resubscribe set
- [ ] DELETE rejects invalid addresses with 400
- [ ] DELETE calls `untrack` when a stream is supplied, and no-ops safely when it is not

**Verify:** `npm test` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing db test**

In `test/db.test.js`, update the existing `wallet upsert/list/remove` test to the new method name:

```js
test('wallet upsert/list/remove', () => {
  const db = freshDb();
  db.upsertWallet('0xabc', 'main');
  db.upsertWallet('0xabc', 'renamed'); // upsert keeps single row
  let rows = db.listWallets();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'renamed');
  db.deleteWallet('0xabc');
  assert.equal(db.listWallets().length, 0);
});
```

Then append:

```js
test('deleteWallet purges snapshots and fills for that address only', () => {
  const db = freshDb();
  for (const addr of ['0xaaa', '0xbbb']) {
    db.upsertWallet(addr, 'w');
    db.ingestFills(addr, [{ tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1, side: 'A', dir: 'Close Long', ts: 10 }]);
    db.insertSnapshotThrottled(addr, { ts: 1000, equity: 1, unrealized_pnl: 0, realized_pnl_cum: 0, open_positions: 0 }, 0);
  }
  db.deleteWallet('0xaaa');

  assert.equal(db.listWallets().length, 1);
  assert.equal(db.listWallets()[0].address, '0xbbb');
  assert.equal(db.countFills('0xaaa'), 0);
  assert.equal(db.cumulativeRealized('0xaaa'), 0);
  assert.equal(db.getHistory('0xaaa').length, 0);
  // the surviving wallet is untouched
  assert.equal(db.countFills('0xbbb'), 1);
  assert.equal(db.getHistory('0xbbb').length, 1);
});
```

- [ ] **Step 2: Write the failing stream test**

Append to `test/hl-stream.test.js`:

```js
test('untrack unsubscribes userFills and drops it from the reconnect set', async () => {
  const { stream, getWs } = makeStream();
  stream.start();
  await new Promise((r) => setTimeout(r, 5));
  stream.track(ADDR);
  stream.untrack(ADDR);
  const unsubs = getWs().sent.filter((m) => m.method === 'unsubscribe' && m.subscription.type === 'userFills');
  assert.equal(unsubs.length, 1);
  assert.equal(unsubs[0].subscription.user, ADDR);

  // untracking twice must not send a second unsubscribe
  stream.untrack(ADDR);
  assert.equal(getWs().sent.filter((m) => m.method === 'unsubscribe' && m.subscription.type === 'userFills').length, 1);

  // on reconnect the address must not be resubscribed
  const before = getWs();
  before.emit('close');
  await new Promise((r) => setTimeout(r, 1100));
  const resubs = getWs().sent.filter((m) => m.method === 'subscribe' && m.subscription.type === 'userFills');
  assert.equal(resubs.length, 0);
});
```

- [ ] **Step 3: Write the failing server tests**

Append to `test/server.test.js`:

```js
test('DELETE /api/wallets rejects an invalid address', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/wallets/nope`, { method: 'DELETE' });
    assert.equal(res.status, 400);
  });
});

test('DELETE /api/wallets purges and untracks the address', async () => {
  const untracked = [];
  const stream = { untrack: (a) => untracked.push(a) };
  await withServer({ stream }, async (base) => {
    const res = await fetch(`${base}/api/wallets/${MASTER}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(untracked, [MASTER]);
  });
});

test('DELETE /api/wallets works without a stream', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/wallets/${MASTER}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });
});
```

`fakeDb` needs the renamed method. In `test/server.test.js`, change `removeWallet() {},` to `deleteWallet() {},` in the `fakeDb` return object.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `db.deleteWallet is not a function`, `stream.untrack is not a function`, and DELETE returning 200 for `nope`.

- [ ] **Step 5: Implement the purge**

In `db.js`, add two prepared statements next to `removeWallet` and rename it:

```js
    removeWallet: db.prepare(`DELETE FROM wallets WHERE address = ?`),
    removeSnapshots: db.prepare(`DELETE FROM snapshots WHERE address = ?`),
    removeFills: db.prepare(`DELETE FROM fills WHERE address = ?`),
```

Add the transaction next to `ingestTxn`:

```js
  // One transaction so a mid-delete failure can't leave a wallet whose row is
  // gone but whose fills and snapshots remain.
  const deleteWalletTxn = db.transaction((address) => {
    stmts.removeWallet.run(address);
    stmts.removeSnapshots.run(address);
    stmts.removeFills.run(address);
  });
```

In the returned object, replace the `removeWallet` method with:

```js
    deleteWallet(address) { deleteWalletTxn(address); },
```

- [ ] **Step 6: Implement `untrack`**

In `hl-stream.js`, add after `track`:

```js
    // Independent of the ref-counted watch/unwatch pair — `tracked` is a plain set.
    untrack(address) {
      if (tracked.delete(address)) unsubscribe({ type: 'userFills', user: address });
    },
```

- [ ] **Step 7: Wire the route**

In `server.js`, pull `stream` out of the overrides so it does not leak into `opts` (which is passed to the Hyperliquid fetch helpers). Replace lines 9-13:

```js
export function createApp(db, overrides = {}) {
  const app = express();
  app.use(express.json());

  const { stream = null, ...rest } = overrides;
  const opts = { apiUrl: config.hlApiUrl, snapshotMinIntervalMs: config.snapshotMinIntervalMs, ...rest };
```

Replace the DELETE route:

```js
  app.delete('/api/wallets/:address', (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    db.deleteWallet(address);
    // Without this the live userFills subscription re-inserts the fills we just purged.
    stream?.untrack(address);
    res.json({ wallets: db.listWallets() });
  });
```

- [ ] **Step 8: Give the running server its stream**

In `server.js`, the startup block creates the app before the stream. Reorder so the app receives it — replace the block at the bottom of the file:

```js
if (process.argv[1]?.endsWith('server.js')) {
  const db = openDb(config.dbPath);
  const stream = createStream({ wsUrl: config.hlWsUrl });
  const app = createApp(db, { stream });
  const server = app.listen(config.port, () => console.log(`Dashboard on http://localhost:${config.port}`));

  stream.start();
  // Re-track all previously-watched wallets so fills accumulate even before a browser connects.
  for (const w of db.listWallets()) stream.track(w.address);

  attachWsHub(server, { db, stream });
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add db.js hl-stream.js server.js test/db.test.js test/hl-stream.test.js test/server.test.js
git commit -m "feat: purge wallet data on delete and untrack its upstream subscription"
```

---

### Task 7: Delete UI + docs

**Goal:** Make deletion discoverable and confirmed, and reset the dashboard when the last wallet is removed.

**Files:**
- Modify: `public/index.html:16` (labeled delete control)
- Modify: `public/app.js:194-198` (confirm + post-delete reset)
- Modify: `README.md`

**Acceptance Criteria:**
- [ ] The delete control has visible text, not a tooltip-only glyph
- [ ] A confirmation names the wallet and states its history will be erased
- [ ] Cancelling the confirmation deletes nothing
- [ ] After deleting the last wallet, cards, positions, chart, agents, badge, and Trade History all reset and status reads "Enter a wallet"
- [ ] Deleting a non-selected wallet leaves the current view intact
- [ ] README documents the panel and that deletion purges data

**Verify:** `npm start`, add two wallets, delete one → view intact; delete the last → dashboard clears. `npm test` still passes.

**Steps:**

- [ ] **Step 1: Label the control**

In `public/index.html`, replace line 16:

```html
      <button id="removeBtn" title="Delete the selected wallet and its stored history">✕ Delete</button>
```

- [ ] **Step 2: Add a reset helper**

In `public/app.js`, add after `renderWalletBadge` (which ends on line 60):

```js
// Clear every panel back to its empty state — used when the last wallet is deleted.
function resetDashboard() {
  state.address = null;
  state.history = [];
  state.fills = { rows: [], total: 0, limit: 50, offset: 0, closesOnly: false, tids: new Set() };
  for (const id of ['equity', 'uPnl', 'rPnl']) { $(id).textContent = '—'; $(id).className = 'card-value'; }
  $('rPnlRecent').textContent = '';
  $('posCount').textContent = '—';
  $('positions').querySelector('tbody').innerHTML = '';
  $('emptyState').classList.remove('hidden');
  $('agentsPanel').innerHTML = '';
  $('walletBadge').classList.add('hidden');
  renderFills();
  drawChart();
  clearError();
  setStatus('Enter a wallet', 'poll');
}
```

- [ ] **Step 3: Confirm and reset on delete**

In `public/app.js`, replace the `removeBtn` handler:

```js
  $('removeBtn').addEventListener('click', async () => {
    const a = $('walletSelect').value; if (!a) return;
    const meta = state.walletMeta[a];
    const name = meta?.label ? `${meta.label} (${short(a)})` : short(a);
    // Purging is irreversible: realized PnL is cumulative since first observed and
    // Hyperliquid only re-serves a limited recent window.
    if (!confirm(`Delete ${name}?\n\nThis also erases its stored trade history and equity snapshots. This cannot be undone.`)) return;
    try {
      await api(`/api/wallets/${a}`, { method: 'DELETE' });
      await loadWallets();
      const next = $('walletSelect').value;
      if (next) await selectAddress(next);
      else resetDashboard();
    } catch (e) { showError(e.message); }
  });
```

- [ ] **Step 4: Verify in the browser**

Run: `npm start`, open <http://localhost:3000>.
Expected:
- Add two wallets. Delete the non-selected one → the viewed wallet's data stays on screen.
- Delete with Cancel → nothing changes.
- Delete the last wallet → all cards read `—`, positions and Trade History are empty, chart is blank, status reads "Enter a wallet".

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Update the README**

In `README.md`, add to the Features list after the "Cumulative realized PnL" bullet:

```markdown
- **Trade history** — a paginated table of every fill this dashboard has observed
  (time, coin, direction, size, price, fee, realized PnL), with a **closes only**
  filter. New fills append live.
```

In the "Hyperliquid endpoints used" REST list, no change is needed — `userFills` is already documented.

Add to the Limitations list:

```markdown
- **Deleting a wallet erases its stored data.** Removing a wallet purges its
  observed fills and equity snapshots along with the wallet entry. Because
  realized PnL is cumulative since first observation and Hyperliquid only serves
  a limited recent-fills window, this history cannot be rebuilt by re-adding the
  wallet. Note that a wallet set via `DEFAULT_WALLET` is re-added (empty) on the
  next page load — clear the env var to stop that.
```

In the Project structure block, no path changes are needed.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js README.md
git commit -m "feat(ui): confirm wallet deletion, reset dashboard when last wallet removed"
```

---

## Done criteria

- [ ] `npm test` passes
- [ ] `npm start` serves a dashboard where Trade History paginates, filters, and live-appends
- [ ] Deleting a wallet purges its data, stops its subscription, and clears the view when it was the last one
- [ ] README documents both the panel and the destructive nature of deletion
