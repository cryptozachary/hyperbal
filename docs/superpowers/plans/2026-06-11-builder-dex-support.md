# Builder-Dex (HIP-3) Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggregate Hyperliquid positions/equity across the main perp dex **and** all HIP-3 builder-deployed perp dexs into one unified dashboard view.

**Architecture:** The backend stays the single Hyperliquid caller. `assembleAccount` discovers dexs (`perpDexs`, cached), fetches each dex's `clearinghouseState` in parallel, normalizes each with the existing `normalizeAccount`, and merges (sums equity/PnL, concatenates positions tagged with dex + collateral). REST aggregation is the source of truth; a main-dex `webData2` change becomes a `{type:"refresh"}` nudge that makes the browser re-fetch, and a continuous 30s poll keeps builder dexs fresh (≤30s).

**Tech Stack:** Node 18+, Express, vanilla HTML/CSS/JS, `better-sqlite3`, `ws`, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-11-builder-dex-support-design.md`

---

### Task 1: Multi-dex primitives in `hyperliquid.js`

**Goal:** Add dex discovery (cached), a dex→collateral map (cached), a dex-aware `clearinghouseState`, and a pure `mergeAccounts`, all unit-tested.

**Files:**
- Modify: `hyperliquid.js` (extend `getClearinghouseState` ~line 97; append new functions after `normalizeExtraAgents`)
- Test: `test/hyperliquid.test.js` (append)

**Acceptance Criteria:**
- [ ] `getClearinghouseState(address, opts, dex)` adds `dex` to the body only when provided (back-compatible).
- [ ] `getPerpDexs` returns `[{name:null,fullName:'Main'}, ...builderDexs]` and caches within the TTL.
- [ ] `getDexCollateral` returns a `Map` (null→'USDC', builder dex→symbol via `meta`+`spotMeta`); degrades to `null` label on failure.
- [ ] `mergeAccounts` sums equity/margin/uPnL null-safely, concatenates positions tagged `{dex, collateral}`, counts only real positions.

**Verify:** `npm test` → all pass.

**Steps:**

- [ ] **Step 1: Write failing tests** — append to `test/hyperliquid.test.js`, and extend the import on line 3.

Change the import to add the new names:
```js
import { isValidAddress, normalizeAccount, normalizeFills, parseNum, fetchInfo,
  getUserRole, getExtraAgents, resolveAccountAddress, normalizeExtraAgents,
  getPerpDexs, getDexCollateral, mergeAccounts, _resetDexCaches } from '../hyperliquid.js';
```

Append:
```js
test('getPerpDexs normalizes (main first) and caches within TTL', async () => {
  _resetDexCaches();
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ([null, { name: 'xyz', fullName: 'XYZ' }, { name: 'flx', fullName: 'Felix' }]) }; };
  const a = await getPerpDexs({ fetchImpl, apiUrl: 'http://x' });
  assert.deepEqual(a, [{ name: null, fullName: 'Main' }, { name: 'xyz', fullName: 'XYZ' }, { name: 'flx', fullName: 'Felix' }]);
  await getPerpDexs({ fetchImpl, apiUrl: 'http://x' });
  assert.equal(calls, 1); // second call served from cache
});

test('getPerpDexs degrades to main-only when perpDexs fails', async () => {
  _resetDexCaches();
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const a = await getPerpDexs({ fetchImpl, apiUrl: 'http://x' });
  assert.deepEqual(a, [{ name: null, fullName: 'Main' }]);
});

test('getDexCollateral maps collateral tokens; main = USDC', async () => {
  _resetDexCaches();
  const fetchImpl = async (_u, init) => {
    const b = JSON.parse(init.body);
    if (b.type === 'perpDexs') return { ok: true, json: async () => ([null, { name: 'xyz', fullName: 'XYZ' }, { name: 'cash', fullName: 'dreamcash' }]) };
    if (b.type === 'spotMeta') return { ok: true, json: async () => ({ tokens: [{ index: 0, name: 'USDC' }, { index: 268, name: 'USDT0' }] }) };
    if (b.type === 'meta') return { ok: true, json: async () => ({ collateralToken: b.dex === 'cash' ? 268 : 0 }) };
    return { ok: true, json: async () => ({}) };
  };
  const map = await getDexCollateral({ fetchImpl, apiUrl: 'http://x' });
  assert.equal(map.get(null), 'USDC');
  assert.equal(map.get('xyz'), 'USDC');
  assert.equal(map.get('cash'), 'USDT0');
});

test('mergeAccounts sums and tags positions across dexs', () => {
  const main = { equity: 500, marginUsed: 10, totalUnrealizedPnl: 10, openPositionsCount: 1, positions: [{ coin: 'BTC', size: 1 }] };
  const xyz = { equity: 583, marginUsed: 583, totalUnrealizedPnl: -625, openPositionsCount: 1, positions: [{ coin: 'xyz:SP500', size: -0.753 }] };
  const out = mergeAccounts([
    { dex: null, collateral: 'USDC', account: main },
    { dex: 'xyz', collateral: 'USDC', account: xyz },
  ]);
  assert.equal(out.equity, 1083);
  assert.equal(out.marginUsed, 593);
  assert.equal(out.totalUnrealizedPnl, -615);
  assert.equal(out.openPositionsCount, 2);
  assert.equal(out.positions[1].coin, 'xyz:SP500');
  assert.equal(out.positions[1].dex, 'xyz');
  assert.equal(out.positions[1].collateral, 'USDC');
});

test('mergeAccounts is null-safe and counts only real positions', () => {
  const idle = { equity: 100, marginUsed: null, totalUnrealizedPnl: null, openPositionsCount: 0, positions: [] };
  const empty = { equity: null, marginUsed: null, totalUnrealizedPnl: null, openPositionsCount: 0, positions: [] };
  const out = mergeAccounts([{ dex: null, collateral: 'USDC', account: idle }, { dex: 'flx', collateral: 'USDH', account: empty }]);
  assert.equal(out.equity, 100);          // idle collateral still counts toward equity
  assert.equal(out.totalUnrealizedPnl, null);
  assert.equal(out.openPositionsCount, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `getPerpDexs`/`getDexCollateral`/`mergeAccounts`/`_resetDexCaches` not exported.

- [ ] **Step 3: Implement** — edit `hyperliquid.js`

Make `getClearinghouseState` dex-aware (replace lines 97-99):
```js
export function getClearinghouseState(address, opts, dex) {
  const body = { type: 'clearinghouseState', user: address };
  if (dex) body.dex = dex;
  return fetchInfo(body, opts);
}
```

Append after `normalizeExtraAgents` (end of file):
```js
// --- HIP-3 builder-dex support ---

const DEX_TTL_MS = 600000; // metadata changes rarely; cache for 10 min
let _dexCache = null;   // { ts, dexs }
let _collCache = null;  // { ts, map }

// Test hook: clear the in-process metadata caches.
export function _resetDexCaches() { _dexCache = null; _collCache = null; }

// perpDexs -> [{ name, fullName }]; the main dex is { name: null, fullName: 'Main' }.
export async function getPerpDexs(opts) {
  if (_dexCache && Date.now() - _dexCache.ts < DEX_TTL_MS) return _dexCache.dexs;
  let raw;
  try {
    raw = await fetchInfo({ type: 'perpDexs' }, opts);
  } catch {
    return [{ name: null, fullName: 'Main' }]; // degrade to main-only; don't cache the failure
  }
  const arr = Array.isArray(raw) ? raw : [];
  const dexs = [{ name: null, fullName: 'Main' }];
  for (const d of arr) if (d && d.name) dexs.push({ name: d.name, fullName: d.fullName ?? d.name });
  _dexCache = { ts: Date.now(), dexs };
  return dexs;
}

// Map<dexName|null, collateralSymbol>. Main dex is USDC. Cached; degrades to null on failure.
export async function getDexCollateral(opts) {
  if (_collCache && Date.now() - _collCache.ts < DEX_TTL_MS) return _collCache.map;
  const map = new Map([[null, 'USDC']]);
  try {
    const [spot, dexs] = await Promise.all([fetchInfo({ type: 'spotMeta' }, opts), getPerpDexs(opts)]);
    const byIndex = new Map((spot?.tokens || []).map((t) => [t.index, t.name]));
    await Promise.all(dexs.filter((d) => d.name).map(async (d) => {
      try {
        const m = await fetchInfo({ type: 'meta', dex: d.name }, opts);
        map.set(d.name, byIndex.get(m?.collateralToken) ?? null);
      } catch { map.set(d.name, null); }
    }));
  } catch { /* degrade: only the main dex collateral is known */ }
  _collCache = { ts: Date.now(), map };
  return map;
}

// Merge per-dex normalized accounts into one. perDex: [{ dex, collateral, account }].
export function mergeAccounts(perDex) {
  const add = (acc, v) => (v == null ? acc : (acc ?? 0) + v);
  let equity = null, marginUsed = null, totalUnrealizedPnl = null;
  const positions = [];
  for (const { dex, collateral, account } of perDex) {
    if (!account) continue;
    equity = add(equity, account.equity);
    marginUsed = add(marginUsed, account.marginUsed);
    totalUnrealizedPnl = add(totalUnrealizedPnl, account.totalUnrealizedPnl);
    for (const p of account.positions) positions.push({ ...p, dex, collateral });
  }
  return { equity, marginUsed, totalUnrealizedPnl, openPositionsCount: positions.length, positions };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add hyperliquid.js test/hyperliquid.test.js
git commit -m "feat: add HL multi-dex primitives (perpDexs, dex collateral map, mergeAccounts)"
```

---

### Task 2: Aggregate across dexs in `assembleAccount`

**Goal:** `assembleAccount` fetches every dex's state in parallel and returns one merged, persisted payload (positions tagged with dex/collateral; main-dex failure still errors, builder-dex failures are skipped).

**Files:**
- Modify: `account.js` (imports line 1; rewrite `assembleAccount` lines 5-34)
- Test: `test/account.test.js` (replace)

**Acceptance Criteria:**
- [ ] Positions from main + builder dexs are merged; equity/uPnL are summed; positions carry `dex` + `collateral`.
- [ ] A failing builder dex is skipped; a failing main dex throws.
- [ ] Snapshot stores aggregated equity; fills/realized unchanged (userFills already cross-dex).

**Verify:** `npm test` → all pass.

**Steps:**

- [ ] **Step 1: Write failing tests** — replace the contents of `test/account.test.js` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { assembleAccount } from '../account.js';
import { _resetDexCaches } from '../hyperliquid.js';

const ADDR = '0x' + 'a'.repeat(40);
const ok = (payload) => ({ ok: true, json: async () => payload });
const fail = () => ({ ok: false, status: 500, text: async () => 'boom' });
const freshDb = () => openDb(path.join(os.tmpdir(), `hl-acc-${Date.now()}-${Math.random().toString(16).slice(2)}.db`));
const POS = (coin, szi, uPnl) => ({ position: { coin, szi, entryPx: '90', positionValue: '100', unrealizedPnl: uPnl, returnOnEquity: '0.1', liquidationPx: '50', leverage: { type: 'cross', value: 5 }, marginUsed: '10' } });

// dexs: builder dexs [{name,fullName}]; cs: map of dexKey('main'|name)->clearinghouseState; failDex: dexKey to fail
function makeOpts({ dexs = [], cs = {}, failDex = null } = {}) {
  const fetchImpl = async (_url, init) => {
    const b = JSON.parse(init.body);
    if (b.type === 'perpDexs') return ok([null, ...dexs]);
    if (b.type === 'spotMeta') return ok({ tokens: [{ index: 0, name: 'USDC' }] });
    if (b.type === 'meta') return ok({ collateralToken: 0 });
    if (b.type === 'clearinghouseState') {
      const key = b.dex || 'main';
      if (failDex === key) return fail();
      return ok(cs[key] || { marginSummary: {}, assetPositions: [] });
    }
    if (b.type === 'userFills') return ok([{ tid: 1, coin: 'BTC', closedPnl: '5', fee: '0.1', px: '90', sz: '1', side: 'B', time: 1 }]);
    return ok({});
  };
  return { fetchImpl, apiUrl: 'http://x', snapshotMinIntervalMs: 60000 };
}

test('assembleAccount (main dex only) returns normalized payload and persists', async () => {
  _resetDexCaches();
  const db = freshDb();
  const opts = makeOpts({ cs: { main: { marginSummary: { accountValue: '500', totalMarginUsed: '10' }, assetPositions: [POS('BTC', '1', '10')] } } });
  const out = await assembleAccount(ADDR, db, opts);
  assert.equal(out.equity, 500);
  assert.equal(out.openPositionsCount, 1);
  assert.equal(out.realizedPnlCumulative, 5);
  assert.equal(db.getHistory(ADDR).length, 1);
  assert.equal(db.listWallets().length, 1);
});

test('assembleAccount aggregates across main + builder dex', async () => {
  _resetDexCaches();
  const db = freshDb();
  const opts = makeOpts({
    dexs: [{ name: 'xyz', fullName: 'XYZ' }],
    cs: {
      main: { marginSummary: { accountValue: '500', totalMarginUsed: '10' }, assetPositions: [POS('BTC', '1', '10')] },
      xyz: { marginSummary: { accountValue: '583', totalMarginUsed: '583' }, assetPositions: [POS('xyz:SP500', '-0.753', '-625')] },
    },
  });
  const out = await assembleAccount(ADDR, db, opts);
  assert.equal(out.equity, 1083);
  assert.equal(out.openPositionsCount, 2);
  const sp = out.positions.find((p) => p.coin === 'xyz:SP500');
  assert.equal(sp.dex, 'xyz');
  assert.equal(sp.collateral, 'USDC');
  assert.equal(sp.side, 'SHORT');
});

test('assembleAccount skips a failing builder dex but keeps main', async () => {
  _resetDexCaches();
  const db = freshDb();
  const opts = makeOpts({
    dexs: [{ name: 'xyz', fullName: 'XYZ' }],
    cs: { main: { marginSummary: { accountValue: '500' }, assetPositions: [POS('BTC', '1', '10')] } },
    failDex: 'xyz',
  });
  const out = await assembleAccount(ADDR, db, opts);
  assert.equal(out.equity, 500);
  assert.equal(out.openPositionsCount, 1);
});

test('assembleAccount throws if the main dex fails', async () => {
  _resetDexCaches();
  const db = freshDb();
  await assert.rejects(() => assembleAccount(ADDR, db, makeOpts({ failDex: 'main' })));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `assembleAccount` does not yet aggregate (e.g. equity 1083 / dex tagging assertions fail; `_resetDexCaches` import resolves only after Task 1).

- [ ] **Step 3: Implement** — edit `account.js`

Replace the import (line 1):
```js
import { getClearinghouseState, getUserFills, getPerpDexs, getDexCollateral, normalizeAccount, normalizeFills, mergeAccounts } from './hyperliquid.js';
```

Replace `assembleAccount` (lines 5-34) with:
```js
// Fetch live HL data across all perp dexs, persist fills + snapshot, return the
// normalized dashboard payload. `opts`: { fetchImpl?, apiUrl, snapshotMinIntervalMs }
export async function assembleAccount(address, db, opts) {
  const [dexs, collateral] = await Promise.all([getPerpDexs(opts), getDexCollateral(opts)]);
  const fillsPromise = getUserFills(address, opts);

  // One clearinghouseState per dex, in parallel; builder-dex failures are skipped.
  const settled = await Promise.allSettled(dexs.map((d) => getClearinghouseState(address, opts, d.name)));
  const perDex = [];
  for (let i = 0; i < dexs.length; i++) {
    const d = dexs[i];
    const r = settled[i];
    if (r.status === 'fulfilled') {
      perDex.push({ dex: d.name, collateral: collateral.get(d.name) ?? null, account: normalizeAccount(r.value) });
    } else if (d.name == null) {
      throw new Error(`Hyperliquid main dex error: ${r.reason?.message || r.reason}`);
    } else {
      console.warn(`Skipping dex ${d.name}: ${r.reason?.message || r.reason}`);
    }
  }

  const account = mergeAccounts(perDex);
  const { rows, recentRealized } = normalizeFills(await fillsPromise);

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
    notes: 'Totals span all Hyperliquid perp dexs; realized PnL is cumulative since this dashboard began observing fills.',
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add account.js test/account.test.js
git commit -m "feat: aggregate account across all Hyperliquid perp dexs"
```

---

### Task 3: WS hub — `refresh` nudge instead of main-dex paint

**Goal:** Stop broadcasting a main-dex-only `account`/`snapshot` (which would clobber the aggregated view) and instead nudge clients to re-fetch; move snapshot writing fully to the REST path.

**Files:**
- Modify: `ws-server.js` (the `stream.on('account', …)` handler, lines 16-34)

**Acceptance Criteria:**
- [ ] On a main-dex `webData2` update, the hub broadcasts `{type:"refresh"}` to clients watching that address.
- [ ] The hub no longer writes snapshots or broadcasts `account`/`snapshot` from the `webData2` handler.
- [ ] The fills→`realized` path is unchanged.

**Verify:** `npm test` → all pass (no regressions; `ws-server.js` has no unit tests by project convention). Behavior confirmed in the final manual smoke (run by the coordinator before finishing the branch).

**Steps:**

- [ ] **Step 1: Implement** — in `ws-server.js`, replace the entire `stream.on('account', …)` handler (lines 16-34) with:

```js
  // A main-dex webData2 change can't carry builder-dex state, so nudge clients to
  // re-fetch the aggregated account over REST (the single source of truth).
  stream.on('account', ({ address }) => {
    if (!address) return;
    broadcast(address, { type: 'refresh' });
  });
```

Leave the `stream.on('fills', …)` handler and everything else unchanged.

- [ ] **Step 2: Run the suite to confirm no regressions**

Run: `npm test`
Expected: PASS (unchanged count from Task 2).

- [ ] **Step 3: Commit**

```bash
git add ws-server.js
git commit -m "feat: WS hub sends refresh nudge instead of main-dex-only account"
```

---

### Task 4: Frontend — refetch-on-refresh, continuous poll, collateral label

**Goal:** Drive the unified view from REST (refetch on `refresh` nudge + always-on 30s poll + manual), and label each position with its collateral.

**Files:**
- Modify: `public/app.js` (state line 6; ws `onmessage` lines 85-91; polling lines 96-101; `connectWs` open/close lines 84/92; `init` poll start; `renderAccount` coin cell line 35)
- Modify: `public/index.html` (add a one-line note near the cards, ~line 23)

**Acceptance Criteria:**
- [ ] A `{type:"refresh"}` message triggers a debounced re-fetch of `/api/account` + history.
- [ ] A 30s poll runs continuously (not only when the WS is down), so builder-dex changes appear within ≤30s.
- [ ] Each position shows its collateral (e.g. `xyz:SP500 · USDC`); positions without `collateral` render the coin alone.

**Verify:** `node --check public/app.js` → no errors. Manual smoke run by the coordinator before finishing the branch.

**Steps:**

- [ ] **Step 1: Add a refresh debounce to `state`** — `public/app.js`, replace the `state` line (line 6):

```js
const state = { address: null, ws: null, pollTimer: null, refreshTimer: null, series: 'equity', history: [], wsConnected: false, walletMeta: {} };
```

- [ ] **Step 2: Add the debounced refresh + handle the `refresh` message** — replace the `ws.onmessage` handler (lines 85-91) with:

```js
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'refresh') scheduleRefresh();
    else if (msg.type === 'realized') { $('rPnl').textContent = fmtUsd(msg.realizedPnlCumulative); $('rPnl').className = 'card-value ' + cls(msg.realizedPnlCumulative); }
    else if (msg.type === 'error') showError(msg.message);
  };
```

Add this helper just above `connectWs` (before line 80):
```js
function scheduleRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(() => { state.refreshTimer = null; refresh(false); }, 1500);
}
```

- [ ] **Step 3: Make the poll continuous and decouple it from WS state** — replace `connectWs`'s `onopen`/`onclose` (lines 84 and 92) and the polling helpers (lines 96-101) so the poll is always on:

Replace the `onopen` line (line 84):
```js
  ws.onopen = () => { state.wsConnected = true; setStatus('Live', 'live'); if (state.address) ws.send(JSON.stringify({ type: 'watch', address: state.address })); };
```

Replace the `onclose` line (line 92):
```js
  ws.onclose = () => { state.wsConnected = false; setStatus('Reconnecting…', 'down'); setTimeout(connectWs, 3000); };
```

Replace the polling helpers (lines 96-101) with a single always-on starter:
```js
function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => refresh(false), 30000);
}
```

- [ ] **Step 4: Start the poll in `init`** — in `init`, immediately after `connectWs();` (line 161), add:
```js
  startPolling();
```

- [ ] **Step 5: Show collateral in the positions table** — replace the coin cell in `renderAccount` (line 35):
```js
      <td>${esc(p.coin ?? '—')}${p.collateral ? ` · ${esc(p.collateral)}` : ''}</td>
```
(`esc` already exists in `app.js`.)

- [ ] **Step 6: Add the aggregation note** — `public/index.html`, immediately after the opening `<section class="cards" id="cards">` is closed (after line 28, before the chart `<section>`), add:
```html
    <p class="dex-note">Totals are aggregated across all Hyperliquid perp dexs.</p>
```
And append to `public/styles.css`:
```css
.dex-note{color:var(--muted);font-size:12px;margin:0 0 14px}
```

- [ ] **Step 7: Verify syntax**

Run: `node --check public/app.js`
Expected: no output (syntax OK).

- [ ] **Step 8: Commit**

```bash
git add public/app.js public/index.html public/styles.css
git commit -m "feat: unified multi-dex view via refresh nudge, continuous poll, collateral labels"
```

---

### Task 5: README documentation

**Goal:** Document multi-dex aggregation and the new endpoints.

**Files:**
- Modify: `README.md` (Features list; "Hyperliquid endpoints used"; Limitations)

**Acceptance Criteria:**
- [ ] README explains positions are aggregated across the main + builder dexs.
- [ ] `perpDexs`, dex-scoped `clearinghouseState`, and `meta`/`spotMeta` (collateral) are listed.
- [ ] A limitation notes builder-dex freshness (≤30s) and that non-Hyperliquid perps (e.g. Bitget's USDT perps) are not shown.

**Verify:** `git diff README.md` shows the additions; prose reads cleanly.

**Steps:**

- [ ] **Step 1: Add a Features bullet** — after the "Agent wallet recognition" bullet:
```markdown
- **All perp dexs in one view** — positions and equity are aggregated across
  Hyperliquid's main perp dex **and** HIP-3 builder-deployed dexs (e.g. an
  `xyz:SP500` short on the "XYZ" dex), each labeled with its collateral
  (USDC / USDT0 / USDH / USDE).
```

- [ ] **Step 2: Extend "Hyperliquid endpoints used"** — add under the REST list:
```markdown
  - `{ "type": "perpDexs" }` — the list of perp dexs (main + builder-deployed).
  - `{ "type": "clearinghouseState", "user": "0x…", "dex": "<name>" }` — per-dex
    account state (the main dex omits `dex`).
  - `{ "type": "meta", "dex": "<name>" }` + `{ "type": "spotMeta" }` — resolve each
    dex's collateral token to a symbol.
```

- [ ] **Step 3: Add Limitations bullets** — after the agent-wallet limitation bullet:
```markdown
- **Builder-dex positions refresh within ~30s** (REST poll), while main-dex
  changes update near-instantly. All dex equities are summed as ≈USD (each
  collateral is a dollar-pegged stablecoin).
- **Only Hyperliquid is shown.** Perps that aren't on Hyperliquid — e.g. the
  USDT-margined pairs in some wallets' "Perps" tabs (Bitget's own engine) — are a
  different venue and cannot appear here.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document multi-dex aggregation and endpoints"
```

---

## Notes

- **`normalizeAccount` is reused unchanged per dex** — the per-position shape is identical across dexs, so there is no parallel normalizer.
- **`userFills` is already cross-dex** (verified against the live API), so realized-PnL ingestion needs no change.
- **Test caches:** `getPerpDexs`/`getDexCollateral` use a module-level TTL cache; every test that exercises aggregation calls `_resetDexCaches()` first (Node's test runner isolates files in separate processes, so cross-file leakage isn't a concern, but within-file ordering is).
- **`ws-server.js` and the frontend have no unit tests by project convention** — Tasks 3-4 are verified by the suite staying green plus the coordinator's manual smoke before finishing the branch.
