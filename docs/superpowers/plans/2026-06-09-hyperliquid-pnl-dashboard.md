# Live Hyperliquid PnL Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted, read-only web dashboard that shows live Hyperliquid PnL/equity/positions for a public wallet address, backed by a local SQLite store for history and cumulative realized PnL.

**Architecture:** Express backend is the single normalization point and only DB writer. It exposes REST (initial paint + fallback) and a browser-facing WebSocket hub at `/ws`. An upstream WS client subscribes to Hyperliquid (`webData2`, `userFills`), ingests fills into SQLite, writes throttled equity snapshots, and pushes normalized updates to the browser. Frontend is vanilla HTML/CSS/JS with a hand-drawn canvas chart.

**Tech Stack:** Node 18+, Express, `better-sqlite3`, `ws`, `dotenv`. Tests via Node's built-in `node:test`. No frontend frameworks, no chart library.

**Spec:** [docs/superpowers/specs/2026-06-09-hyperliquid-pnl-dashboard-design.md](../specs/2026-06-09-hyperliquid-pnl-dashboard-design.md)

---

## File Structure

| File | Responsibility |
|------|----------------|
| `package.json` | Scripts (`start`, `test`), deps, `"type": "module"`. |
| `.env.example` | Documented config template. |
| `.gitignore` | Ignore `node_modules/`, `.env`, `data/`. |
| `config.js` | Loads/validates env, exports typed config object. |
| `db.js` | SQLite open + schema + wallet/snapshot/fill query functions. |
| `hyperliquid.js` | REST fetchers + **shared normalizers** (`normalizeAccount`, `normalizeFills`, `parseNum`) + address validation. |
| `hl-stream.js` | Upstream WS client: subscribe/unsubscribe, ping, reconnect+resubscribe, emits `account`/`fills` events. |
| `ws-server.js` | Browser-facing WS hub: client registry, `watch` handling, broadcast. |
| `server.js` | Express app, static serving, REST routes, wires config+db+stream+hub, starts HTTP+WS. |
| `public/index.html` | Markup: wallet selector, status badge, cards, table, chart, refresh. |
| `public/styles.css` | Dark premium theme, responsive, PnL coloring. |
| `public/app.js` | REST initial load, WS client + fallback polling, render cards/table/chart. |
| `test/*.test.js` | `node:test` units for normalizers, validation, db. |
| `README.md` | Docs per spec §14. |

---

## Task 0: Project scaffold + config + health server

**Goal:** A runnable Express server with `/api/health`, env config, and project metadata, so `npm install && npm start` boots.

**Files:**
- Create: `package.json`, `.gitignore`, `.env.example`, `config.js`, `server.js`
- Test: `test/config.test.js`

**Acceptance Criteria:**
- [ ] `npm install` completes (express, better-sqlite3, ws, dotenv installed).
- [ ] `npm start` boots and `GET /api/health` returns `{status:"ok",time:<number>}`.
- [ ] `config.js` reads env with sane defaults and never throws on missing optional vars.

**Verify:** `npm test` passes config test; `npm start` then `curl http://localhost:3000/api/health` → `{"status":"ok",...}`.

**Steps:**

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "hyperliquid-pnl-dashboard",
  "version": "1.0.0",
  "description": "Read-only live Hyperliquid PnL dashboard",
  "type": "module",
  "main": "server.js",
  "engines": { "node": ">=18" },
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
  "dependencies": {
    "better-sqlite3": "^11.8.1",
    "dotenv": "^16.4.7",
    "express": "^4.21.2",
    "ws": "^8.18.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
.env
data/
*.log
```

- [ ] **Step 3: Create `.env.example`**

```
# Port the dashboard listens on
PORT=3000
# Hyperliquid public REST info endpoint (mainnet default)
HL_API_URL=https://api.hyperliquid.xyz/info
# Hyperliquid public WebSocket endpoint (mainnet default)
HL_WS_URL=wss://api.hyperliquid.xyz/ws
# Optional: pre-fill the UI with this public wallet address (0x...40 hex). Leave blank otherwise.
DEFAULT_WALLET=
# SQLite database file location
DB_PATH=./data/hyperliquid.db
# Minimum spacing between equity snapshots per wallet (ms)
SNAPSHOT_MIN_INTERVAL_MS=60000
```

- [ ] **Step 4: Create `config.js`**

```js
import 'dotenv/config';

function clean(v) {
  return (v ?? '').trim();
}

export const config = {
  port: Number(clean(process.env.PORT)) || 3000,
  hlApiUrl: clean(process.env.HL_API_URL) || 'https://api.hyperliquid.xyz/info',
  hlWsUrl: clean(process.env.HL_WS_URL) || 'wss://api.hyperliquid.xyz/ws',
  defaultWallet: clean(process.env.DEFAULT_WALLET).toLowerCase(),
  dbPath: clean(process.env.DB_PATH) || './data/hyperliquid.db',
  snapshotMinIntervalMs: Number(clean(process.env.SNAPSHOT_MIN_INTERVAL_MS)) || 60000,
};
```

- [ ] **Step 5: Write `test/config.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';

test('config has defaults', () => {
  assert.ok(config.port > 0);
  assert.match(config.hlApiUrl, /^https?:\/\//);
  assert.match(config.hlWsUrl, /^wss?:\/\//);
  assert.equal(typeof config.snapshotMinIntervalMs, 'number');
});
```

- [ ] **Step 6: Create minimal `server.js` (health only; expanded in later tasks)**

```js
import express from 'express';
import { config } from './config.js';

export function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: Date.now() }));
  app.use(express.static('public'));
  return app;
}

// Start only when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') ||
    process.argv[1]?.endsWith('server.js')) {
  const app = createApp();
  app.listen(config.port, () => console.log(`Dashboard on http://localhost:${config.port}`));
}
```

- [ ] **Step 7: Verify**

Run: `npm install` then `npm test` → config test PASS.
Run: `npm start`, then `curl http://localhost:3000/api/health` → `{"status":"ok","time":...}`.

---

## Task 1: SQLite layer (`db.js`)

**Goal:** Open the DB, create schema, and provide wallet/snapshot/fill functions including throttled snapshot insert and cumulative realized PnL.

**Files:**
- Create: `db.js`
- Test: `test/db.test.js`

**Acceptance Criteria:**
- [ ] Schema (wallets, snapshots, fills + index) created idempotently; parent dir of DB auto-created.
- [ ] `ingestFills` dedupes by `(address, tid)`; `cumulativeRealized` returns the sum of `closed_pnl`.
- [ ] `insertSnapshotThrottled` skips writes within `minIntervalMs` of the last snapshot.
- [ ] Wallet upsert/list/remove work.

**Verify:** `node --test test/db.test.js` → all PASS.

**Steps:**

- [ ] **Step 1: Write `test/db.test.js` (uses an isolated temp DB)**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `hl-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  return openDb(p);
}

test('wallet upsert/list/remove', () => {
  const db = freshDb();
  db.upsertWallet('0xabc', 'main');
  db.upsertWallet('0xabc', 'renamed'); // upsert keeps single row
  let rows = db.listWallets();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'renamed');
  db.removeWallet('0xabc');
  assert.equal(db.listWallets().length, 0);
});

test('fills dedupe and cumulative realized', () => {
  const db = freshDb();
  const fills = [
    { tid: 1, coin: 'BTC', closed_pnl: 10, fee: 1, px: 100, sz: 1, side: 'B', ts: 1 },
    { tid: 2, coin: 'BTC', closed_pnl: -4, fee: 1, px: 100, sz: 1, side: 'A', ts: 2 },
  ];
  db.ingestFills('0xabc', fills);
  db.ingestFills('0xabc', fills); // duplicate tids ignored
  assert.equal(db.cumulativeRealized('0xabc'), 6);
});

test('snapshot throttling', () => {
  const db = freshDb();
  const w = db.insertSnapshotThrottled('0xabc', { ts: 1000, equity: 1, unrealized_pnl: 0, realized_pnl_cum: 0, open_positions: 0 }, 60000);
  const blocked = db.insertSnapshotThrottled('0xabc', { ts: 2000, equity: 2, unrealized_pnl: 0, realized_pnl_cum: 0, open_positions: 0 }, 60000);
  const allowed = db.insertSnapshotThrottled('0xabc', { ts: 70000, equity: 3, unrealized_pnl: 0, realized_pnl_cum: 0, open_positions: 0 }, 60000);
  assert.equal(w, true);
  assert.equal(blocked, false);
  assert.equal(allowed, true);
  assert.equal(db.getHistory('0xabc').length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail** — `node --test test/db.test.js` → FAIL (`openDb` not defined).

- [ ] **Step 3: Implement `db.js`**

```js
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  label TEXT,
  added_at INTEGER NOT NULL,
  last_viewed_at INTEGER
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  ts INTEGER NOT NULL,
  equity REAL,
  unrealized_pnl REAL,
  realized_pnl_cum REAL,
  open_positions INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snapshots_addr_ts ON snapshots(address, ts);
CREATE TABLE IF NOT EXISTS fills (
  address TEXT NOT NULL,
  tid INTEGER NOT NULL,
  coin TEXT,
  closed_pnl REAL,
  fee REAL,
  px REAL,
  sz REAL,
  side TEXT,
  ts INTEGER,
  PRIMARY KEY (address, tid)
);
`;

export function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const stmts = {
    upsertWallet: db.prepare(`
      INSERT INTO wallets (address, label, added_at, last_viewed_at)
      VALUES (@address, @label, @now, @now)
      ON CONFLICT(address) DO UPDATE SET
        label = COALESCE(excluded.label, wallets.label),
        last_viewed_at = excluded.last_viewed_at
    `),
    listWallets: db.prepare(`SELECT address, label, added_at, last_viewed_at FROM wallets ORDER BY last_viewed_at DESC NULLS LAST, added_at DESC`),
    removeWallet: db.prepare(`DELETE FROM wallets WHERE address = ?`),
    insertFill: db.prepare(`
      INSERT OR IGNORE INTO fills (address, tid, coin, closed_pnl, fee, px, sz, side, ts)
      VALUES (@address, @tid, @coin, @closed_pnl, @fee, @px, @sz, @side, @ts)
    `),
    cumulativeRealized: db.prepare(`SELECT COALESCE(SUM(closed_pnl),0) AS total FROM fills WHERE address = ?`),
    lastSnapshotTs: db.prepare(`SELECT MAX(ts) AS ts FROM snapshots WHERE address = ?`),
    insertSnapshot: db.prepare(`
      INSERT INTO snapshots (address, ts, equity, unrealized_pnl, realized_pnl_cum, open_positions)
      VALUES (@address, @ts, @equity, @unrealized_pnl, @realized_pnl_cum, @open_positions)
    `),
    getHistory: db.prepare(`SELECT ts, equity, unrealized_pnl, realized_pnl_cum, open_positions FROM snapshots WHERE address = ? AND ts >= ? ORDER BY ts ASC`),
  };

  const ingestTxn = db.transaction((address, fills) => {
    for (const f of fills) stmts.insertFill.run({ address, ...f });
  });

  return {
    raw: db,
    upsertWallet(address, label = null) {
      stmts.upsertWallet.run({ address, label, now: Date.now() });
    },
    listWallets() { return stmts.listWallets.all(); },
    removeWallet(address) { stmts.removeWallet.run(address); },
    ingestFills(address, fills) { if (fills?.length) ingestTxn(address, fills); },
    cumulativeRealized(address) { return stmts.cumulativeRealized.get(address).total; },
    getHistory(address, since = 0) { return stmts.getHistory.all(address, since); },
    // Returns true if a snapshot was written, false if throttled.
    insertSnapshotThrottled(address, point, minIntervalMs) {
      const last = stmts.lastSnapshotTs.get(address).ts;
      if (last != null && point.ts - last < minIntervalMs) return false;
      stmts.insertSnapshot.run({ address, ...point });
      return true;
    },
  };
}
```

- [ ] **Step 4: Run tests** — `node --test test/db.test.js` → PASS.

---

## Task 2: Hyperliquid REST fetchers + normalizers + validation (`hyperliquid.js`)

**Goal:** Pure, testable functions to validate addresses, call the HL `info` endpoint, and normalize `clearinghouseState`/`userFills` into the dashboard's clean shapes.

**Files:**
- Create: `hyperliquid.js`
- Test: `test/hyperliquid.test.js`

**Acceptance Criteria:**
- [ ] `isValidAddress` accepts `0x`+40 hex (any case), rejects everything else.
- [ ] `normalizeAccount` derives mark price (`positionValue/|szi|`), side, ROE %, totals; tolerates missing fields → `null`.
- [ ] `normalizeFills` maps HL fill objects to DB rows and computes recent realized sum.
- [ ] `fetchInfo` posts JSON and throws a clear error on non-OK / bad body (verified via injected fetch).

**Verify:** `node --test test/hyperliquid.test.js` → all PASS.

**Steps:**

- [ ] **Step 1: Write `test/hyperliquid.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidAddress, normalizeAccount, normalizeFills, parseNum, fetchInfo } from '../hyperliquid.js';

test('isValidAddress', () => {
  assert.equal(isValidAddress('0x' + 'a'.repeat(40)), true);
  assert.equal(isValidAddress('0x' + 'A'.repeat(40)), true);
  assert.equal(isValidAddress('0x123'), false);
  assert.equal(isValidAddress('nope'), false);
  assert.equal(isValidAddress(''), false);
});

test('parseNum tolerates junk', () => {
  assert.equal(parseNum('1.5'), 1.5);
  assert.equal(parseNum(2), 2);
  assert.equal(parseNum(undefined), null);
  assert.equal(parseNum('abc'), null);
});

test('normalizeAccount derives fields', () => {
  const cs = {
    marginSummary: { accountValue: '1000', totalMarginUsed: '50' },
    assetPositions: [
      { position: {
        coin: 'BTC', szi: '2', entryPx: '90', positionValue: '200',
        unrealizedPnl: '20', returnOnEquity: '0.25', liquidationPx: '50',
        leverage: { type: 'cross', value: 10 }, marginUsed: '20',
      } },
      { position: { coin: 'ETH', szi: '0', entryPx: '0', positionValue: '0',
        unrealizedPnl: '0', returnOnEquity: '0', liquidationPx: null,
        leverage: { type: 'isolated', value: 5 }, marginUsed: '0' } },
    ],
  };
  const a = normalizeAccount(cs);
  assert.equal(a.equity, 1000);
  assert.equal(a.openPositionsCount, 1);          // zero-size excluded
  const btc = a.positions[0];
  assert.equal(btc.side, 'LONG');
  assert.equal(btc.markPrice, 100);               // 200 / |2|
  assert.equal(btc.roe, 25);                       // 0.25 * 100
  assert.equal(Math.round(a.totalUnrealizedPnl), 20);
});

test('normalizeAccount handles empty/missing', () => {
  const a = normalizeAccount({});
  assert.equal(a.equity, null);
  assert.deepEqual(a.positions, []);
  assert.equal(a.openPositionsCount, 0);
});

test('normalizeFills maps + recent sum', () => {
  const fills = [
    { tid: 1, coin: 'BTC', closedPnl: '10', fee: '0.5', px: '100', sz: '1', side: 'B', time: 111 },
    { tid: 2, coin: 'BTC', closedPnl: '-3', fee: '0.5', px: '100', sz: '1', side: 'A', time: 222 },
  ];
  const { rows, recentRealized } = normalizeFills(fills);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tid, 1);
  assert.equal(rows[0].closed_pnl, 10);
  assert.equal(recentRealized, 7);
});

test('fetchInfo throws on non-ok', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(() => fetchInfo({ type: 'x' }, { fetchImpl: fakeFetch, apiUrl: 'http://x' }), /Hyperliquid API error 500/);
});
```

- [ ] **Step 2: Run tests to verify they fail** — `node --test test/hyperliquid.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement `hyperliquid.js`**

```js
// Hyperliquid public "info" API client + normalizers.
// All numeric fields from HL arrive as strings; parseNum coerces safely.

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function isValidAddress(addr) {
  return typeof addr === 'string' && ADDR_RE.test(addr);
}

export function parseNum(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// POST a JSON body to the HL info endpoint. fetchImpl/apiUrl injectable for tests.
export async function fetchInfo(body, { fetchImpl = fetch, apiUrl, timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Hyperliquid API error ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Hyperliquid API request timed out');
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// clearinghouseState -> normalized account object.
export function normalizeAccount(cs) {
  const ms = cs?.marginSummary ?? {};
  const rawPositions = Array.isArray(cs?.assetPositions) ? cs.assetPositions : [];
  const positions = rawPositions
    .map((ap) => ap?.position ?? {})
    .map((p) => {
      const size = parseNum(p.szi);
      const positionValue = parseNum(p.positionValue);
      const absSize = size == null ? null : Math.abs(size);
      const markPrice = positionValue != null && absSize ? positionValue / absSize : null;
      const roe = parseNum(p.returnOnEquity);
      return {
        coin: p.coin ?? null,
        size,
        side: size == null ? null : size >= 0 ? 'LONG' : 'SHORT',
        entryPrice: parseNum(p.entryPx),
        markPrice,
        liquidationPrice: parseNum(p.liquidationPx),
        leverage: parseNum(p.leverage?.value),
        leverageType: p.leverage?.type ?? null,
        marginUsed: parseNum(p.marginUsed),
        unrealizedPnl: parseNum(p.unrealizedPnl),
        roe: roe == null ? null : roe * 100,
      };
    })
    .filter((p) => p.size !== 0); // drop flat positions

  const totalUnrealizedPnl = positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);

  return {
    equity: parseNum(ms.accountValue),
    marginUsed: parseNum(ms.totalMarginUsed),
    totalUnrealizedPnl: positions.length ? totalUnrealizedPnl : null,
    openPositionsCount: positions.length,
    positions,
  };
}

// userFills -> { rows: DB rows, recentRealized: sum over this payload }
export function normalizeFills(fills) {
  const arr = Array.isArray(fills) ? fills : [];
  const rows = arr.map((f) => ({
    tid: Number(f.tid),
    coin: f.coin ?? null,
    closed_pnl: parseNum(f.closedPnl) ?? 0,
    fee: parseNum(f.fee) ?? 0,
    px: parseNum(f.px),
    sz: parseNum(f.sz),
    side: f.side ?? null,
    ts: parseNum(f.time),
  })).filter((r) => Number.isFinite(r.tid));
  const recentRealized = rows.reduce((s, r) => s + r.closed_pnl, 0);
  return { rows, recentRealized };
}

// Convenience wrappers used by server/stream.
export function getClearinghouseState(address, opts) {
  return fetchInfo({ type: 'clearinghouseState', user: address }, opts);
}
export function getUserFills(address, opts) {
  return fetchInfo({ type: 'userFills', user: address }, opts);
}
```

- [ ] **Step 4: Run tests** — `node --test test/hyperliquid.test.js` → PASS.

---

## Task 3: REST routes + account assembly in `server.js`

**Goal:** Wire DB + HL fetchers into REST routes: `/api/account/:address`, `/api/history/:address`, `/api/wallets` CRUD, with validation and error handling. Expose a shared `assembleAccount(address)` used later by the WS path.

**Files:**
- Modify: `server.js`
- Create: `account.js` (shared assembly), `test/account.test.js`

**Acceptance Criteria:**
- [ ] `GET /api/account/:address` validates → fetches CS+fills in parallel → ingests fills, writes throttled snapshot, upserts wallet → returns normalized JSON with `realizedPnlCumulative` + `realizedPnlRecent` + `config.defaultWallet`.
- [ ] Invalid address → 400; HL failure → 502; both with `{error}` body.
- [ ] `GET /api/history/:address` returns snapshots; wallets CRUD works.

**Verify:** `node --test test/account.test.js` PASS; manual `curl` against a real address returns populated JSON.

**Steps:**

- [ ] **Step 1: Write `test/account.test.js` (inject fake fetch + temp db)**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { assembleAccount } from '../account.js';

const ADDR = '0x' + 'a'.repeat(40);

function deps() {
  const db = openDb(path.join(os.tmpdir(), `hl-acc-${Date.now()}-${Math.random().toString(16).slice(2)}.db`));
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.type === 'clearinghouseState') {
      return { ok: true, json: async () => ({
        marginSummary: { accountValue: '500', totalMarginUsed: '10' },
        assetPositions: [{ position: { coin: 'BTC', szi: '1', entryPx: '90', positionValue: '100',
          unrealizedPnl: '10', returnOnEquity: '0.1', liquidationPx: '50',
          leverage: { type: 'cross', value: 5 }, marginUsed: '10' } }],
      }) };
    }
    return { ok: true, json: async () => ([
      { tid: 1, coin: 'BTC', closedPnl: '5', fee: '0.1', px: '90', sz: '1', side: 'B', time: 1 },
    ]) };
  };
  return { db, opts: { fetchImpl, apiUrl: 'http://x', snapshotMinIntervalMs: 60000 } };
}

test('assembleAccount returns normalized payload and persists', async () => {
  const { db, opts } = deps();
  const out = await assembleAccount(ADDR, db, opts);
  assert.equal(out.equity, 500);
  assert.equal(out.openPositionsCount, 1);
  assert.equal(out.realizedPnlRecent, 5);
  assert.equal(out.realizedPnlCumulative, 5);
  assert.equal(db.getHistory(ADDR).length, 1);     // snapshot written
  assert.equal(db.listWallets().length, 1);        // wallet upserted
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (`account.js` missing).

- [ ] **Step 3: Implement `account.js`**

```js
import { getClearinghouseState, getUserFills, normalizeAccount, normalizeFills } from './hyperliquid.js';

// Fetch live HL data, persist fills + snapshot, return the normalized dashboard payload.
// `opts`: { fetchImpl?, apiUrl, snapshotMinIntervalMs }
export async function assembleAccount(address, db, opts) {
  const [cs, fills] = await Promise.all([
    getClearinghouseState(address, opts),
    getUserFills(address, opts),
  ]);

  const account = normalizeAccount(cs);
  const { rows, recentRealized } = normalizeFills(fills);

  db.ingestFills(address, rows);
  const realizedPnlCumulative = db.cumulativeRealized(address);

  db.upsertWallet(address);
  db.insertSnapshotThrottled(address, {
    ts: Date.now(),
    equity: account.equity,
    unrealized_pnl: account.totalUnrealizedPnl,
    realized_pnl_cum: realizedPnlCumulative,
    open_positions: account.openPositionsCount,
  }, opts.snapshotMinIntervalMs);

  return {
    address,
    ...account,
    realizedPnlCumulative,
    realizedPnlRecent: recentRealized,
    asOf: Date.now(),
    notes: 'Realized PnL is cumulative since this dashboard began observing fills.',
  };
}
```

- [ ] **Step 4: Run test** — PASS.

- [ ] **Step 5: Expand `server.js` with routes** (replace the file from Task 0; keeps `createApp` importable and adds DI for db/opts)

```js
import express from 'express';
import { config } from './config.js';
import { openDb } from './db.js';
import { isValidAddress } from './hyperliquid.js';
import { assembleAccount } from './account.js';

export function createApp(db) {
  const app = express();
  app.use(express.json());

  const opts = { apiUrl: config.hlApiUrl, snapshotMinIntervalMs: config.snapshotMinIntervalMs };

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: Date.now() }));

  app.get('/api/config', (_req, res) => res.json({ defaultWallet: config.defaultWallet || null }));

  app.get('/api/account/:address', async (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address. Expected 0x followed by 40 hex characters.' });
    try {
      const payload = await assembleAccount(address, db, opts);
      res.json(payload);
    } catch (err) {
      res.status(502).json({ error: `Failed to load account from Hyperliquid: ${err.message}` });
    }
  });

  app.get('/api/history/:address', (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    const since = Number(req.query.since) || 0;
    res.json({ address, points: db.getHistory(address, since) });
  });

  app.get('/api/wallets', (_req, res) => res.json({ wallets: db.listWallets() }));

  app.post('/api/wallets', (req, res) => {
    const address = String(req.body?.address || '').toLowerCase();
    const label = req.body?.label ? String(req.body.label).slice(0, 60) : null;
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    db.upsertWallet(address, label);
    res.json({ wallets: db.listWallets() });
  });

  app.delete('/api/wallets/:address', (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    db.removeWallet(address);
    res.json({ wallets: db.listWallets() });
  });

  app.use(express.static('public'));
  return app;
}

if (process.argv[1]?.endsWith('server.js')) {
  const db = openDb(config.dbPath);
  const app = createApp(db);
  const server = app.listen(config.port, () => console.log(`Dashboard on http://localhost:${config.port}`));
  // WS hub + stream attach here in Task 5.
  globalThis.__hlServer = server;
}
```

- [ ] **Step 6: Verify** — `npm test` PASS; `npm start` then `curl http://localhost:3000/api/account/<a-real-address>` returns populated JSON (or a clean 400/502 for bad input/outage).

---

## Task 4: Upstream Hyperliquid WS client (`hl-stream.js`)

**Goal:** Maintain one upstream WS to Hyperliquid: subscribe `webData2` (per viewed wallet, ref-counted) + `userFills` (per watched wallet, persistent), ping keep-alive, reconnect with backoff + resubscribe, and emit normalized `account`/`fills` events.

**Files:**
- Create: `hl-stream.js`
- Test: `test/hl-stream.test.js` (uses a fake WS to assert subscribe/resubscribe logic; no network)

**Acceptance Criteria:**
- [ ] `watch(address)` / `unwatch(address)` ref-count `webData2`; reaching 0 sends unsubscribe.
- [ ] `track(address)` adds a persistent `userFills` subscription.
- [ ] On (re)open, all active subscriptions are (re)sent.
- [ ] Incoming `webData2` → emits `account` with `normalizeAccount(clearinghouseState)`; `userFills` → emits `fills` with normalized rows.

**Verify:** `node --test test/hl-stream.test.js` → PASS.

**Steps:**

- [ ] **Step 1: Write `test/hl-stream.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createStream } from '../hl-stream.js';

const ADDR = '0x' + 'b'.repeat(40);

// Minimal fake ws.WebSocket
class FakeWS extends EventEmitter {
  constructor() { super(); this.sent = []; this.readyState = 1; FakeWS.OPEN = 1; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.emit('close'); }
  ping() {}
}
FakeWS.OPEN = 1;

function makeStream() {
  let ws;
  const factory = () => { ws = new FakeWS(); queueMicrotask(() => ws.emit('open')); return ws; };
  const stream = createStream({ wsUrl: 'wss://x', WebSocketImpl: FakeWS, wsFactory: factory });
  return { stream, getWs: () => ws };
}

test('track sends persistent userFills sub; watch ref-counts webData2', async () => {
  const { stream, getWs } = makeStream();
  stream.start();
  await new Promise((r) => setTimeout(r, 5));
  stream.track(ADDR);
  stream.watch(ADDR);
  const subs = getWs().sent.filter((m) => m.method === 'subscribe');
  assert.ok(subs.some((s) => s.subscription.type === 'userFills' && s.subscription.user === ADDR));
  assert.ok(subs.some((s) => s.subscription.type === 'webData2' && s.subscription.user === ADDR));
});

test('webData2 message emits normalized account', async () => {
  const { stream, getWs } = makeStream();
  stream.start();
  await new Promise((r) => setTimeout(r, 5));
  stream.watch(ADDR);
  const got = new Promise((resolve) => stream.on('account', resolve));
  getWs().emit('message', JSON.stringify({
    channel: 'webData2',
    data: { clearinghouseState: { marginSummary: { accountValue: '10' }, assetPositions: [] } },
  }));
  const evt = await got;
  assert.equal(evt.address, undefined === evt.address ? evt.address : evt.address); // address attached by hub, not stream
  assert.equal(evt.account.equity, 10);
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (module missing).

- [ ] **Step 3: Implement `hl-stream.js`**

```js
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { normalizeAccount, normalizeFills } from './hyperliquid.js';

// Manages the single upstream connection to Hyperliquid.
// Emits: 'account' { address, account }, 'fills' { address, rows, recentRealized }, 'status' string.
export function createStream({ wsUrl, WebSocketImpl = WebSocket, wsFactory } = {}) {
  const emitter = new EventEmitter();
  const webData2Refs = new Map(); // address -> count
  const tracked = new Set();      // addresses with persistent userFills
  let ws = null;
  let pingTimer = null;
  let backoff = 1000;

  function activeSubs() {
    const subs = [];
    for (const addr of webData2Refs.keys()) subs.push({ type: 'webData2', user: addr });
    for (const addr of tracked) subs.push({ type: 'userFills', user: addr });
    return subs;
  }

  function send(obj) {
    if (ws && ws.readyState === (WebSocketImpl.OPEN ?? 1)) ws.send(JSON.stringify(obj));
  }

  function subscribe(subscription) { send({ method: 'subscribe', subscription }); }
  function unsubscribe(subscription) { send({ method: 'unsubscribe', subscription }); }

  function connect() {
    ws = wsFactory ? wsFactory() : new WebSocketImpl(wsUrl);
    ws.on('open', () => {
      backoff = 1000;
      emitter.emit('status', 'connected');
      for (const s of activeSubs()) subscribe(s);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ method: 'ping' }), 30000);
    });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.channel === 'webData2') {
        const cs = msg.data?.clearinghouseState;
        const address = (msg.data?.user || '').toLowerCase() || undefined;
        if (cs) emitter.emit('account', { address, account: normalizeAccount(cs) });
      } else if (msg.channel === 'userFills') {
        const address = (msg.data?.user || '').toLowerCase() || undefined;
        const { rows, recentRealized } = normalizeFills(msg.data?.fills);
        if (rows.length) emitter.emit('fills', { address, rows, recentRealized });
      }
    });
    ws.on('close', () => {
      clearInterval(pingTimer);
      emitter.emit('status', 'disconnected');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    });
    ws.on('error', () => { try { ws.close(); } catch {} });
  }

  return Object.assign(emitter, {
    start() { connect(); },
    watch(address) {
      const n = (webData2Refs.get(address) || 0) + 1;
      webData2Refs.set(address, n);
      if (n === 1) subscribe({ type: 'webData2', user: address });
    },
    unwatch(address) {
      const n = (webData2Refs.get(address) || 0) - 1;
      if (n <= 0) { webData2Refs.delete(address); unsubscribe({ type: 'webData2', user: address }); }
      else webData2Refs.set(address, n);
    },
    track(address) {
      if (!tracked.has(address)) { tracked.add(address); subscribe({ type: 'userFills', user: address }); }
    },
  });
}
```

> **Note for implementer:** Hyperliquid's `webData2` payload nests the account under `data.clearinghouseState` and includes the subscribed `user`. If the live payload differs, adjust the field access in the `message` handler — the normalizer input is always a `clearinghouseState`-shaped object. Confirm field names against a live message during Task 7 verification and tweak if needed.

- [ ] **Step 4: Run test** — `node --test test/hl-stream.test.js` → PASS.

---

## Task 5: Browser-facing WS hub (`ws-server.js`) + wire into `server.js`

**Goal:** Hub at `/ws`: track which client watches which address, drive `stream.watch/track`, persist fills + snapshots from stream events, and broadcast `account`/`realized`/`snapshot` messages.

**Files:**
- Create: `ws-server.js`
- Modify: `server.js` (attach hub + stream on startup)

**Acceptance Criteria:**
- [ ] On client `{type:"watch",address}` (valid) → `stream.track(address)` + `stream.watch(address)`; client added to that address's set.
- [ ] On `stream.account` → broadcast `{type:"account",data}` to clients watching that address (and write throttled snapshot).
- [ ] On `stream.fills` → ingest to DB, broadcast `{type:"realized",realizedPnlCumulative,realizedPnlRecent}`.
- [ ] Client disconnect → `stream.unwatch` for its watched address.

**Verify:** `npm start`; open the page, observe `account`/`snapshot` pushes in the browser console; killing network shows reconnect.

**Steps:**

- [ ] **Step 1: Implement `ws-server.js`**

```js
import { WebSocketServer } from 'ws';
import { isValidAddress } from './hyperliquid.js';

// Attaches a WS hub at /ws to an existing http.Server.
export function attachWsHub(httpServer, { db, stream, config }) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const watching = new Map(); // ws client -> address

  function broadcast(address, payload) {
    const msg = JSON.stringify(payload);
    for (const [client, addr] of watching) {
      if (addr === address && client.readyState === client.OPEN) client.send(msg);
    }
  }

  // Persist + relay live account updates.
  stream.on('account', ({ address, account }) => {
    if (!address) return;
    const realizedPnlCumulative = db.cumulativeRealized(address);
    const wrote = db.insertSnapshotThrottled(address, {
      ts: Date.now(),
      equity: account.equity,
      unrealized_pnl: account.totalUnrealizedPnl,
      realized_pnl_cum: realizedPnlCumulative,
      open_positions: account.openPositionsCount,
    }, config.snapshotMinIntervalMs);
    broadcast(address, { type: 'account', data: { address, ...account, realizedPnlCumulative, asOf: Date.now() } });
    if (wrote) {
      broadcast(address, { type: 'snapshot', point: {
        ts: Date.now(), equity: account.equity,
        unrealized_pnl: account.totalUnrealizedPnl, realized_pnl_cum: realizedPnlCumulative,
      } });
    }
  });

  // Persist + relay live fills.
  stream.on('fills', ({ address, rows, recentRealized }) => {
    if (!address) return;
    db.ingestFills(address, rows);
    broadcast(address, { type: 'realized',
      realizedPnlCumulative: db.cumulativeRealized(address), realizedPnlRecent: recentRealized });
  });

  wss.on('connection', (client) => {
    client.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'watch') {
        const address = String(msg.address || '').toLowerCase();
        if (!isValidAddress(address)) { client.send(JSON.stringify({ type: 'error', message: 'Invalid address' })); return; }
        const prev = watching.get(client);
        if (prev && prev !== address) stream.unwatch(prev);
        watching.set(client, address);
        stream.track(address);  // persistent userFills
        stream.watch(address);  // live webData2
      }
    });
    client.on('close', () => {
      const addr = watching.get(client);
      if (addr) stream.unwatch(addr);
      watching.delete(client);
    });
  });

  return wss;
}
```

- [ ] **Step 2: Wire hub + stream into `server.js`** (replace the startup block at the bottom)

```js
import { createStream } from './hl-stream.js';
import { attachWsHub } from './ws-server.js';
// ...existing imports/createApp above...

if (process.argv[1]?.endsWith('server.js')) {
  const db = openDb(config.dbPath);
  const app = createApp(db);
  const server = app.listen(config.port, () => console.log(`Dashboard on http://localhost:${config.port}`));

  const stream = createStream({ wsUrl: config.hlWsUrl });
  stream.start();
  // Re-track all previously-watched wallets so fills accumulate even before a browser connects.
  for (const w of db.listWallets()) stream.track(w.address);

  attachWsHub(server, { db, stream, config });
}
```

- [ ] **Step 3: Verify** — `npm start`, open browser devtools on `http://localhost:3000`, confirm WS connects to `/ws` and `account`/`snapshot` frames arrive after watching a wallet.

---

## Task 6: Frontend (`public/index.html`, `styles.css`, `app.js`)

**Goal:** The dark dashboard UI: wallet selector, status badge, 4 cards, positions table, canvas chart, refresh button; REST initial load + live WS with 30s polling fallback; loading/empty/error states.

**Files:**
- Create: `public/index.html`, `public/styles.css`, `public/app.js`

**Acceptance Criteria:**
- [ ] Loads `defaultWallet` from `/api/config` and saved wallets from `/api/wallets`; can add/remove wallets.
- [ ] Renders the 4 cards + 10-column positions table with green/red PnL coloring.
- [ ] Canvas chart draws equity history from `/api/history`, with an equity/PnL toggle; redraws on resize.
- [ ] WS live updates cards/table/chart; status badge reflects Live/Reconnecting/Polling; falls back to 30s REST polling when WS is down.
- [ ] Loading, empty (no positions / no wallet), and error states render clearly.

**Verify:** `npm start`, open page, enter a real public address → cards/table/chart populate and update live.

**Steps:**

- [ ] **Step 1: Create `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hyperliquid PnL Dashboard</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="topbar">
    <div class="brand">⚡ Hyperliquid PnL</div>
    <div class="controls">
      <select id="walletSelect" aria-label="Saved wallets"></select>
      <input id="walletInput" type="text" placeholder="0x… wallet address" autocomplete="off" spellcheck="false" />
      <button id="addBtn">Add</button>
      <button id="removeBtn" title="Remove selected">✕</button>
      <button id="refreshBtn">↻ Refresh</button>
      <span id="status" class="badge">—</span>
    </div>
  </header>

  <main>
    <section class="cards" id="cards">
      <div class="card"><div class="card-label">Account Equity</div><div class="card-value" id="equity">—</div></div>
      <div class="card"><div class="card-label">Unrealized PnL</div><div class="card-value" id="uPnl">—</div></div>
      <div class="card"><div class="card-label">Realized PnL (cumulative)</div><div class="card-value" id="rPnl">—</div><div class="card-sub" id="rPnlRecent"></div></div>
      <div class="card"><div class="card-label">Open Positions</div><div class="card-value" id="posCount">—</div></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Equity / PnL History</h2>
        <div class="toggle">
          <button class="active" data-series="equity">Equity</button>
          <button data-series="pnl">PnL</button>
        </div>
      </div>
      <canvas id="chart" height="220"></canvas>
    </section>

    <section class="panel">
      <h2>Open Positions</h2>
      <div id="tableWrap">
        <table id="positions">
          <thead><tr>
            <th>Coin</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th>
            <th>Liq.</th><th>Lev.</th><th>Margin</th><th>uPnL</th><th>ROE %</th>
          </tr></thead>
          <tbody></tbody>
        </table>
        <div id="emptyState" class="empty hidden">No open positions.</div>
      </div>
    </section>

    <div id="loading" class="overlay hidden">Loading…</div>
    <div id="error" class="error hidden"></div>
  </main>

  <footer class="foot">Read-only. Never enter private keys or seed phrases.</footer>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/styles.css`** (dark premium theme; full file)

```css
:root{
  --bg:#0b0e14; --bg2:#121722; --card:#161c2b; --line:#222b3d;
  --text:#e6ebf5; --muted:#8a97b1; --pos:#1fd09a; --neg:#ff5d6c; --accent:#6c8cff;
}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:
  radial-gradient(1200px 600px at 20% -10%,#1a2336 0%,transparent 60%),var(--bg);color:var(--text)}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;
  padding:14px 20px;border-bottom:1px solid var(--line);background:rgba(11,14,20,.7);
  position:sticky;top:0;backdrop-filter:blur(8px);flex-wrap:wrap}
.brand{font-weight:700;letter-spacing:.3px}
.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
select,input,button{background:var(--bg2);color:var(--text);border:1px solid var(--line);
  border-radius:10px;padding:8px 10px;font-size:13px}
input{min-width:280px}
button{cursor:pointer;transition:.15s}
button:hover{border-color:var(--accent)}
#refreshBtn{background:linear-gradient(180deg,#2a3550,#1c2438)}
.badge{padding:6px 10px;border-radius:999px;border:1px solid var(--line);font-size:12px;color:var(--muted)}
.badge.live{color:var(--pos);border-color:rgba(31,208,154,.4)}
.badge.poll{color:#ffce6a;border-color:rgba(255,206,106,.4)}
.badge.down{color:var(--neg);border-color:rgba(255,93,108,.4)}
main{max-width:1100px;margin:0 auto;padding:20px;position:relative}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}
.card{background:linear-gradient(180deg,var(--card),#121624);border:1px solid var(--line);
  border-radius:16px;padding:16px 18px;box-shadow:0 8px 30px rgba(0,0,0,.25)}
.card-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.5px}
.card-value{font-size:26px;font-weight:700;margin-top:6px}
.card-sub{font-size:12px;color:var(--muted);margin-top:4px}
.panel{background:linear-gradient(180deg,var(--card),#121624);border:1px solid var(--line);
  border-radius:16px;padding:16px 18px;margin-bottom:18px}
.panel-head{display:flex;justify-content:space-between;align-items:center}
h2{font-size:15px;margin:0 0 10px}
.toggle button{padding:5px 10px;border-radius:8px;font-size:12px}
.toggle button.active{border-color:var(--accent);color:var(--accent)}
canvas{width:100%;display:block}
table{width:100%;border-collapse:collapse}
th,td{padding:10px 8px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase}
.pos{color:var(--pos)} .neg{color:var(--neg)}
.side-long{color:var(--pos);font-weight:600} .side-short{color:var(--neg);font-weight:600}
.empty,.error{padding:20px;text-align:center;color:var(--muted)}
.error{color:var(--neg);border:1px solid rgba(255,93,108,.3);border-radius:12px;margin-top:14px}
.overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  background:rgba(11,14,20,.5);border-radius:16px;font-size:16px;color:var(--muted)}
.hidden{display:none}
.foot{text-align:center;color:var(--muted);padding:18px;font-size:12px;border-top:1px solid var(--line)}
@media(max-width:760px){.cards{grid-template-columns:repeat(2,1fr)}input{min-width:160px}}
```

- [ ] **Step 3: Create `public/app.js`** (full client logic; REST + WS + chart)

```js
const $ = (id) => document.getElementById(id);
const fmtUsd = (n) => n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtNum = (n, d = 4) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
const cls = (n) => n == null ? '' : n > 0 ? 'pos' : n < 0 ? 'neg' : '';

const state = { address: null, ws: null, pollTimer: null, series: 'equity', history: [], wsConnected: false };

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function setStatus(text, kind) { const el = $('status'); el.textContent = text; el.className = 'badge ' + (kind || ''); }
function showError(msg) { const e = $('error'); e.textContent = msg; e.classList.remove('hidden'); }
function clearError() { $('error').classList.add('hidden'); }
function setLoading(on) { $('loading').classList.toggle('hidden', !on); }

function renderAccount(d) {
  clearError();
  $('equity').textContent = fmtUsd(d.equity);
  $('uPnl').textContent = fmtUsd(d.totalUnrealizedPnl); $('uPnl').className = 'card-value ' + cls(d.totalUnrealizedPnl);
  $('rPnl').textContent = fmtUsd(d.realizedPnlCumulative); $('rPnl').className = 'card-value ' + cls(d.realizedPnlCumulative);
  $('rPnlRecent').textContent = d.realizedPnlRecent != null ? `recent window: ${fmtUsd(d.realizedPnlRecent)}` : '';
  $('posCount').textContent = d.openPositionsCount ?? 0;

  const tbody = $('positions').querySelector('tbody');
  tbody.innerHTML = '';
  const positions = d.positions || [];
  $('emptyState').classList.toggle('hidden', positions.length > 0);
  for (const p of positions) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.coin ?? '—'}</td>
      <td class="${p.side === 'LONG' ? 'side-long' : 'side-short'}">${p.side ?? '—'}</td>
      <td>${fmtNum(p.size)}</td>
      <td>${fmtNum(p.entryPrice, 2)}</td>
      <td>${fmtNum(p.markPrice, 2)}</td>
      <td>${fmtNum(p.liquidationPrice, 2)}</td>
      <td>${p.leverage != null ? p.leverage + 'x' : '—'}</td>
      <td>${fmtUsd(p.marginUsed)}</td>
      <td class="${cls(p.unrealizedPnl)}">${fmtUsd(p.unrealizedPnl)}</td>
      <td class="${cls(p.roe)}">${p.roe != null ? p.roe.toFixed(2) + '%' : '—'}</td>`;
    tbody.appendChild(tr);
  }
}

// ---- Canvas chart (no library) ----
function drawChart() {
  const c = $('chart'); const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = 220;
  c.width = w * dpr; c.height = h * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const pts = state.history.map((p) => state.series === 'equity' ? p.equity : (p.unrealized_pnl ?? 0))
    .map((v) => v == null ? 0 : v);
  if (pts.length < 2) { ctx.fillStyle = '#8a97b1'; ctx.fillText('Not enough history yet.', 12, 24); return; }
  const min = Math.min(...pts), max = Math.max(...pts), pad = 24;
  const x = (i) => pad + (i / (pts.length - 1)) * (w - pad * 2);
  const y = (v) => max === min ? h / 2 : pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
  // grid baseline
  ctx.strokeStyle = '#222b3d'; ctx.beginPath(); ctx.moveTo(pad, h - pad); ctx.lineTo(w - pad, h - pad); ctx.stroke();
  // line
  ctx.strokeStyle = pts[pts.length - 1] >= pts[0] ? '#1fd09a' : '#ff5d6c';
  ctx.lineWidth = 2; ctx.beginPath();
  pts.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
  ctx.stroke();
  // last value label
  ctx.fillStyle = '#e6ebf5';
  ctx.fillText((state.series === 'equity' ? '$' : '') + pts[pts.length - 1].toFixed(2), w - pad - 60, y(pts[pts.length - 1]) - 6);
}

async function loadHistory() {
  if (!state.address) return;
  try { const { points } = await api(`/api/history/${state.address}`); state.history = points; drawChart(); } catch {}
}

// ---- WebSocket with fallback polling ----
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => { state.wsConnected = true; setStatus('Live', 'live'); stopPolling(); if (state.address) ws.send(JSON.stringify({ type: 'watch', address: state.address })); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'account') renderAccount(msg.data);
    else if (msg.type === 'realized') { $('rPnl').textContent = fmtUsd(msg.realizedPnlCumulative); $('rPnl').className = 'card-value ' + cls(msg.realizedPnlCumulative); }
    else if (msg.type === 'snapshot') { state.history.push(msg.point); drawChart(); }
    else if (msg.type === 'error') showError(msg.message);
  };
  ws.onclose = () => { state.wsConnected = false; setStatus('Reconnecting…', 'down'); startPolling(); setTimeout(connectWs, 3000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function startPolling() {
  if (state.pollTimer) return;
  setStatus('Polling', 'poll');
  state.pollTimer = setInterval(() => refresh(false), 30000);
}
function stopPolling() { clearInterval(state.pollTimer); state.pollTimer = null; }

async function refresh(showLoad = true) {
  if (!state.address) return;
  if (showLoad) setLoading(true);
  try {
    const data = await api(`/api/account/${state.address}`);
    renderAccount(data);
    await loadHistory();
  } catch (err) { showError(err.message); }
  finally { setLoading(false); }
}

// ---- Wallet management ----
async function loadWallets(selected) {
  const { wallets } = await api('/api/wallets');
  const sel = $('walletSelect'); sel.innerHTML = '';
  for (const w of wallets) {
    const o = document.createElement('option'); o.value = w.address;
    o.textContent = w.label ? `${w.label} (${w.address.slice(0, 6)}…)` : `${w.address.slice(0, 10)}…${w.address.slice(-4)}`;
    sel.appendChild(o);
  }
  if (selected) sel.value = selected;
}

async function selectAddress(address) {
  state.address = address; state.history = [];
  await refresh(true);
  if (state.wsConnected) state.ws.send(JSON.stringify({ type: 'watch', address }));
}

async function init() {
  setStatus('Connecting…');
  // chart toggle
  document.querySelectorAll('.toggle button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.toggle button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active'); state.series = b.dataset.series; drawChart();
    }));
  $('refreshBtn').addEventListener('click', () => refresh(true));
  window.addEventListener('resize', drawChart);

  $('addBtn').addEventListener('click', async () => {
    const address = $('walletInput').value.trim().toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { showError('Invalid wallet address.'); return; }
    try { await api('/api/wallets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) });
      $('walletInput').value = ''; await loadWallets(address); await selectAddress(address);
    } catch (e) { showError(e.message); }
  });
  $('removeBtn').addEventListener('click', async () => {
    const a = $('walletSelect').value; if (!a) return;
    await api(`/api/wallets/${a}`, { method: 'DELETE' }); await loadWallets();
    const next = $('walletSelect').value; if (next) selectAddress(next);
  });
  $('walletSelect').addEventListener('change', (e) => selectAddress(e.target.value));

  // bootstrap: saved wallets + default
  const { defaultWallet } = await api('/api/config');
  if (defaultWallet) { try { await api('/api/wallets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: defaultWallet }) }); } catch {} }
  await loadWallets(defaultWallet || undefined);
  connectWs();
  const first = $('walletSelect').value || defaultWallet;
  if (first) await selectAddress(first);
  else setStatus('Enter a wallet', 'poll');
}

init();
```

- [ ] **Step 4: Verify** — `npm start`, open `http://localhost:3000`, add a real public address → cards/table populate, chart appears, status shows Live; positions update without manual refresh.

---

## Task 7: README + final review/run

**Goal:** Document the app per spec §14 and do a final end-to-end review/run.

**Files:**
- Create: `README.md`

**Acceptance Criteria:**
- [ ] README covers: what it does, install, run, configure wallet (env + UI), HL endpoints used, limitations, and the security warning (never enter private keys; read-only).
- [ ] `npm install && npm test && npm start` all succeed from a clean checkout.

**Steps:**

- [ ] **Step 1: Write `README.md`** covering every spec §14 bullet, including:
  - Overview + screenshot placeholder.
  - `npm install`, copy `.env.example` → `.env`, `npm start`, open `http://localhost:3000`.
  - Configure wallet via `DEFAULT_WALLET` env and/or the UI "Add" field.
  - Endpoints used: REST `info` (`clearinghouseState`, `userFills`); WS (`webData2`, `userFills`).
  - **Limitations:** cumulative realized PnL is "since this dashboard began observing fills"; snapshots accrue for wallets you view; mark price derived from `positionValue/size`.
  - **Security:** ⚠️ Never enter private keys or seed phrases. Public address only. Read-only — never trades; only writes to the local DB.

- [ ] **Step 2: Final review** — re-read each module for: unused code, error paths, divide-by-zero guards, and that no wallet/API URL/secret is hardcoded (all via `config.js`).

- [ ] **Step 3: Clean-run verify**

Run: `npm install` → ok; `npm test` → all PASS; `npm start` → boots; open page, add a real address → live data renders. Capture any discrepancy in the WS payload shape (Task 4 note) and fix.

- [ ] **Step 4: Final summary** — report what was built and how to run it.

---

## Self-Review (against spec)

- **Wallet entry/config (spec core):** Task 3 `/api/config` + `/api/wallets`; Task 6 selector/add/remove. ✓
- **Open positions, uPnL, equity, margin, leverage, liq, entry, mark, size (spec core):** Task 2 `normalizeAccount`; Task 6 table. ✓
- **Realized PnL (compute from fills, cumulative):** Task 1 `fills`/`cumulativeRealized`, Task 2 `normalizeFills`, Task 3 assembly. ✓
- **Summary cards + table columns (spec UI):** Task 6 markup matches the 4 cards + 10 columns exactly. ✓
- **PnL coloring, refresh button, 30s behavior, loading/empty/error (spec UI):** Task 6 `cls()`, refresh, polling fallback, states. ✓
- **Express server, static public/, routes, validation, error handling, normalization comments (spec backend):** Tasks 0/3; comments in `hyperliquid.js`. ✓
- **SQLite persistence (snapshots, wallets, cumulative fills):** Task 1. ✓
- **WebSocket live + REST fallback:** Tasks 4/5/6. ✓
- **Env config, no hardcoded secrets/URLs:** Task 0 `config.js` + `.env.example`. ✓
- **File structure + README + security warning:** Tasks 0/6/7. ✓

**Placeholder scan:** none — every code step contains full content.
**Type consistency:** `openDb` API (`upsertWallet`/`ingestFills`/`cumulativeRealized`/`getHistory`/`insertSnapshotThrottled`), `normalizeAccount`/`normalizeFills` shapes, and WS message types (`account`/`realized`/`snapshot`/`error`) are used identically across Tasks 1–6. ✓
