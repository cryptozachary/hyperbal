# UI Polish Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine the visual execution of the existing Hyperliquid dashboard — interactive canvas chart, tabular-numeral tables, summary-card sparklines, a wallet switcher popover, and real loading/error states — with no new dependencies.

**Architecture:** `public/app.js` (440 lines, everything) splits into focused ES modules under `public/js/`, loaded natively via `<script type="module">` with no bundler. Tasks 1–3 perform the split with **zero behavior change**, so the app keeps working throughout; tasks 4–13 then land one visible improvement each, in a file that is about one thing. The server, `db.js`, and `export.js` are not touched.

**Tech Stack:** Vanilla ES modules, hand-rolled `<canvas>`, CSS custom properties, `node:test`. Node 18+. No new runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-14-ui-polish-pass-design.md`](../specs/2026-08-14-ui-polish-pass-design.md)

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `public/js/format.js` | Pure formatters. No DOM. | Create (T1) |
| `test/format.test.js` | Formatter unit tests | Create (T1) |
| `public/js/api.js` | `fetch` wrapper + one function per route; only file holding route strings | Create (T2) |
| `public/js/chart.js` | Canvas rendering, crosshair, sparklines; re-exports chart-math | Create (T2), rewritten (T7–T9) |
| `public/js/app.js` | `state`, WebSocket, polling, wiring, bootstrap | Create (T2) |
| `public/js/account.js` | Summary cards + positions table | Create (T3), enhanced (T10, T11) |
| `public/js/fills.js` | Trade history table, filter, pager | Create (T3), enhanced (T11) |
| `public/js/exports.js` | Period picker, sync button, downloads | Create (T3), enhanced (T5) |
| `public/js/wallets.js` | Wallet list; becomes switcher popover | Create (T3), rewritten (T12) |
| `public/js/feedback.js` | Toasts, skeletons, confirm dialog, status badge | Create (T5) |
| `public/js/chart-math.js` | Pure geometry: ticks, scales, nearest-point, segments | Create (T6) |
| `test/chart-math.test.js` | Geometry unit tests | Create (T6) |
| `public/styles.css` | Tokens + all styling | Modify (T4, T5, T7, T10, T11, T12) |
| `public/index.html` | Markup | Modify (T2, T5, T9, T11, T12) |
| `public/app.js` | — | **Delete (T2)** |
| `README.md` | Features + project structure | Modify (T13) |

**Why the split is staged first:** tasks 4–13 add ~320 lines. Landing them in the current single file would produce a ~760-line `app.js`. Doing the mechanical split first means every later task edits a file with one job.

---

### Task 1: Extract `format.js` with tests

**Goal:** Move the six formatters out of `app.js` into a pure, node-testable module, adding the three the later tasks need.

**Files:**
- Create: `public/js/format.js`
- Create: `test/format.test.js`
- Modify: `public/app.js:1-6` (delete the helpers, import them instead), `public/app.js:58` (`fmtTime`)
- Modify: `public/index.html:115` (`<script>` → `<script type="module">`)

**Acceptance Criteria:**
- [ ] `format.js` imports cleanly in Node with no DOM globals referenced
- [ ] `fmtCompact` renders `$49k`, `$1.2M`, `$0`, and negatives correctly
- [ ] `fmtAxisTime` picks time-of-day under 36h and dates above it
- [ ] The dashboard renders identically to before in the browser
- [ ] `npm test` passes

**Verify:** `npm test` → all tests pass, including the new `test/format.test.js`

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `test/format.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtUsd, fmtNum, fmtPct, fmtCompact, fmtAxisTime, cls, short, esc } from '../public/js/format.js';

test('fmtUsd handles sign, nulls and rounding', () => {
  assert.equal(fmtUsd(null), '—');
  assert.equal(fmtUsd(0), '$0');
  assert.equal(fmtUsd(1234.567), '$1,234.57');
  assert.equal(fmtUsd(-612.44), '-$612.44');
});

test('fmtNum respects precision and nulls', () => {
  assert.equal(fmtNum(null), '—');
  assert.equal(fmtNum(0.425), '0.425');
  assert.equal(fmtNum(96412.004, 2), '96,412');
});

test('fmtPct always carries a sign', () => {
  assert.equal(fmtPct(null), '—');
  assert.equal(fmtPct(12.444), '+12.44%');
  assert.equal(fmtPct(-3.6), '-3.60%');
  assert.equal(fmtPct(0), '+0.00%');
});

test('fmtCompact abbreviates for axis labels', () => {
  assert.equal(fmtCompact(0), '$0');
  assert.equal(fmtCompact(612.44), '$612');
  assert.equal(fmtCompact(5.5), '$5.50');
  assert.equal(fmtCompact(49000), '$49k');
  assert.equal(fmtCompact(1500), '$1.5k');
  assert.equal(fmtCompact(1234567), '$1.2M');
  assert.equal(fmtCompact(-49000), '-$49k');
  assert.equal(fmtCompact(null), '—');
});

// Locale-independent: assert the shape of the branch, not the exact string.
test('fmtAxisTime switches format with span', () => {
  const ts = Date.UTC(2026, 7, 6, 14, 20);
  assert.match(fmtAxisTime(ts, 24 * 3600e3), /\d[:.]\d/);          // time of day
  assert.doesNotMatch(fmtAxisTime(ts, 30 * 86400e3), /\d[:.]\d\d/); // date only
  assert.match(fmtAxisTime(ts, 800 * 86400e3), /2026/);             // month + year
});

test('cls classifies sign', () => {
  assert.equal(cls(null), '');
  assert.equal(cls(0), '');
  assert.equal(cls(1), 'pos');
  assert.equal(cls(-1), 'neg');
});

test('short and esc', () => {
  assert.equal(short('0x8f2a1111222233334444555566667777888841c7'), '0x8f2a…41c7');
  assert.equal(short(null), '');
  assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/format.test.js`
Expected: FAIL — `Cannot find module .../public/js/format.js`

- [ ] **Step 3: Create `public/js/format.js`**

```js
// Pure formatters. No DOM access anywhere in this file — node:test imports it directly.

export const fmtUsd = (n) =>
  n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

export const fmtNum = (n, d = 4) =>
  n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });

export const fmtPct = (n, d = 2) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`);

export const fmtTime = (ts) => (ts == null ? '—' : new Date(ts).toLocaleString());

// Axis labels need to fit in ~40px, so full currency formatting won't do.
const trimUnit = (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v))).replace(/\.0$/, '');

export const fmtCompact = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a === 0) return '$0';
  if (a >= 1e9) return `${sign}$${trimUnit(a / 1e9)}B`;
  if (a >= 1e6) return `${sign}$${trimUnit(a / 1e6)}M`;
  if (a >= 1e3) return `${sign}$${trimUnit(a / 1e3)}k`;
  return `${sign}$${a < 10 ? a.toFixed(2) : String(Math.round(a))}`;
};

// The x axis means something different at 24h than at two years, so the label follows the span.
export const fmtAxisTime = (ts, spanMs) => {
  const d = new Date(ts);
  if (spanMs <= 36 * 3600e3) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (spanMs <= 400 * 86400e3) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
};

export const cls = (n) => (n == null ? '' : n > 0 ? 'pos' : n < 0 ? 'neg' : '');

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/format.test.js`
Expected: PASS — 7 tests, 0 failures

- [ ] **Step 5: Wire it into the existing app**

In `public/app.js`, delete lines 1–6 and line 58 (`fmtTime`), and put this at the top of the file:

```js
import { fmtUsd, fmtNum, fmtTime, cls, short, esc } from './js/format.js';

const $ = (id) => document.getElementById(id);
```

In `public/index.html`, change line 115 from `<script src="app.js"></script>` to:

```html
<script type="module" src="app.js"></script>
```

- [ ] **Step 6: Verify in the browser**

Run: `npm start`, open <http://localhost:3000>
Expected: dashboard loads and renders exactly as before; browser console shows no module errors.

- [ ] **Step 7: Commit**

```bash
git add public/js/format.js test/format.test.js public/app.js public/index.html
git commit -m "refactor(ui): extract pure formatters into js/format.js with tests"
```

---

### Task 2: Move `app.js` to `public/js/` and extract `api.js` + `chart.js`

**Goal:** Establish the module directory and pull out the two lowest-coupling concerns, with no behavior change.

**Files:**
- Create: `public/js/api.js`, `public/js/chart.js`, `public/js/app.js`
- Delete: `public/app.js`
- Modify: `public/index.html:115`

**Acceptance Criteria:**
- [ ] `public/app.js` no longer exists; `public/js/app.js` is the entry point
- [ ] Every route string in the app lives in `api.js` and nowhere else
- [ ] Chart drawing code is out of `app.js`
- [ ] Dashboard behavior is byte-for-byte identical to before
- [ ] `npm test` passes

**Verify:** `npm test` → passes; `npm start` → dashboard loads, chart draws, wallet switching works

**Steps:**

- [ ] **Step 1: Create `public/js/api.js`**

```js
// The only file that knows route strings. Everything else asks by name.

async function request(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const getConfig = () => request('/api/config');
export const getAccount = (address) => request(`/api/account/${address}`);
export const getHistory = (address, since = 0) => request(`/api/history/${address}?since=${since}`);
export const getRange = (address) => request(`/api/range/${address}`);
export const getAgents = (address) => request(`/api/agents/${address}`);
export const getWallets = () => request('/api/wallets');
export const addWallet = (address) => request('/api/wallets', json({ address }));
export const deleteWallet = (address) => request(`/api/wallets/${address}`, { method: 'DELETE' });

export const getFills = (address, { limit, offset, closesOnly }) =>
  request(`/api/fills/${address}?limit=${limit}&offset=${offset}&closesOnly=${closesOnly}`);

export const backfill = (address, resume) => {
  const q = resume ? `?fillsFrom=${resume.fills}&fundingFrom=${resume.funding}` : '';
  return request(`/api/backfill/${address}${q}`, { method: 'POST' });
};

// Content-Disposition on the server makes this a download rather than a navigation.
export const exportUrl = (address, params) => `/api/export/${address}.csv?${params}`;
```

- [ ] **Step 2: Create `public/js/chart.js` with the current drawing code**

Move `drawChart` from `public/app.js:257-280` verbatim, wrapped in the interface the later tasks build on. The body is unchanged in this task — only its shape changes.

```js
// Hand-rolled canvas chart. No library, per the project's stated constraint.

export function createChart(canvas) {
  let points = [];
  let opts = { series: 'equity' };

  function draw() {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = 220;
    canvas.width = w * dpr; canvas.height = h * dpr; ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const pts = points
      .map((p) => (opts.series === 'equity' ? p.equity : (p.unrealized_pnl ?? 0)))
      .map((v) => (v == null ? 0 : v));
    if (pts.length < 2) {
      ctx.fillStyle = '#8a97b1';
      ctx.fillText('Not enough history yet.', 12, 24);
      return;
    }
    const min = Math.min(...pts), max = Math.max(...pts), pad = 24;
    const x = (i) => pad + (i / (pts.length - 1)) * (w - pad * 2);
    const y = (v) => (max === min ? h / 2 : pad + (1 - (v - min) / (max - min)) * (h - pad * 2));
    ctx.strokeStyle = '#222b3d';
    ctx.beginPath(); ctx.moveTo(pad, h - pad); ctx.lineTo(w - pad, h - pad); ctx.stroke();
    ctx.strokeStyle = pts[pts.length - 1] >= pts[0] ? '#1fd09a' : '#ff5d6c';
    ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.stroke();
    ctx.fillStyle = '#e6ebf5';
    ctx.fillText(
      (opts.series === 'equity' ? '$' : '') + pts[pts.length - 1].toFixed(2),
      w - pad - 60,
      y(pts[pts.length - 1]) - 6,
    );
  }

  const onResize = () => draw();
  window.addEventListener('resize', onResize);

  return {
    render(nextPoints, nextOpts = {}) {
      points = nextPoints || [];
      opts = { ...opts, ...nextOpts };
      draw();
    },
    destroy() { window.removeEventListener('resize', onResize); },
  };
}
```

- [ ] **Step 3: Move `app.js` and rewire it**

```bash
git mv public/app.js public/js/app.js
```

In `public/js/app.js`:
- Change the format import path to `./format.js`.
- Add `import * as api from './api.js';` and `import { createChart } from './chart.js';`
- Delete `drawChart` (old lines 257–280) and the `window.addEventListener('resize', drawChart)` line inside `init` (old line 392) — `createChart` owns both now.
- Add a module-level `let chart = null;` and in `init`, before the bootstrap block: `chart = createChart($('chart'));`
- Replace every `drawChart()` call with `chart.render(state.history, { series: state.series })`.
- Replace the local `api(path, opts)` helper (old lines 15–20) and its call sites with the named `api.*` functions. The mapping is one-to-one:

| Old call | New call |
|---|---|
| `api('/api/config')` | `api.getConfig()` |
| `api(\`/api/account/${state.address}\`)` | `api.getAccount(state.address)` |
| `api(\`/api/history/${state.address}\`)` | `api.getHistory(state.address)` |
| `api(\`/api/range/${state.address}\`)` | `api.getRange(state.address)` |
| `api(\`/api/agents/${address}\`)` | `api.getAgents(address)` |
| `api('/api/wallets')` | `api.getWallets()` |
| `api('/api/wallets', {method:'POST',…})` | `api.addWallet(address)` |
| `api(\`/api/wallets/${a}\`, {method:'DELETE'})` | `api.deleteWallet(a)` |
| `api(\`/api/fills/${state.address}?${q}\`)` | `api.getFills(state.address, f)` |
| `api(\`/api/backfill/${state.address}${q}\`, …)` | `api.backfill(state.address, resume)` |
| `window.location = \`/api/export/…\`` | `window.location = api.exportUrl(state.address, params)` |

- [ ] **Step 4: Update the entry point**

In `public/index.html`, line 115:

```html
<script type="module" src="js/app.js"></script>
```

- [ ] **Step 5: Verify no behavior changed**

Run: `npm start`, open <http://localhost:3000>
Expected, all still working: wallet dropdown switches wallets; chart draws and redraws on window resize; Equity/PnL toggle works; Trade History pages and filters; Sync full history reports counts; both CSV buttons download; deleting a wallet prompts and purges.

Run: `npm test`
Expected: PASS — no test touches these files, so the suite is unchanged.

- [ ] **Step 6: Commit**

```bash
git add -A public test
git commit -m "refactor(ui): move client to public/js/, extract api.js and chart.js"
```

---

### Task 3: Extract the panel modules

**Goal:** Split the remaining panels out of `app.js` so each later task edits a single-purpose file. Still no behavior change.

**Files:**
- Create: `public/js/account.js`, `public/js/fills.js`, `public/js/exports.js`, `public/js/wallets.js`
- Modify: `public/js/app.js`

**Acceptance Criteria:**
- [ ] `public/js/app.js` is under 180 lines and contains only state, socket, polling, and wiring
- [ ] No panel module reads the shared `state` object; each receives data as arguments
- [ ] `app.js` never calls `document.getElementById` for an element owned by a panel
- [ ] Behavior identical to Task 2
- [ ] `npm test` passes

**Verify:** `npm start` → full manual pass of the checklist in Task 2 Step 5

**Steps:**

- [ ] **Step 1: Create `public/js/account.js`**

Move `renderAccount` (old `app.js:27-54`) and the card-clearing half of `resetDashboard` (old lines 218–222).

```js
import { fmtUsd, fmtNum, cls, esc } from './format.js';

const $ = (id) => document.getElementById(id);

export function render(d) {
  $('equity').textContent = fmtUsd(d.equity);
  $('uPnl').textContent = fmtUsd(d.totalUnrealizedPnl);
  $('uPnl').className = 'card-value ' + cls(d.totalUnrealizedPnl);
  $('rPnl').textContent = fmtUsd(d.realizedPnlCumulative);
  $('rPnl').className = 'card-value ' + cls(d.realizedPnlCumulative);
  $('rPnlRecent').textContent =
    d.realizedPnlRecent != null ? `recent window: ${fmtUsd(d.realizedPnlRecent)}` : '';
  $('posCount').textContent = d.openPositionsCount ?? 0;

  const tbody = $('positions').querySelector('tbody');
  tbody.innerHTML = '';
  const positions = d.positions || [];
  $('emptyState').classList.toggle('hidden', positions.length > 0);
  for (const p of positions) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(p.coin ?? '—')}${p.collateral ? ` · ${esc(p.collateral)}` : ''}</td>
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

// Live realized PnL arrives over the socket without a full account payload.
export function setRealized(value) {
  $('rPnl').textContent = fmtUsd(value);
  $('rPnl').className = 'card-value ' + cls(value);
}

export function reset() {
  for (const id of ['equity', 'uPnl', 'rPnl']) {
    $(id).textContent = '—';
    $(id).className = 'card-value';
  }
  $('rPnlRecent').textContent = '';
  $('posCount').textContent = '—';
  $('positions').querySelector('tbody').innerHTML = '';
  $('emptyState').classList.remove('hidden');
}
```

- [ ] **Step 2: Create `public/js/fills.js`**

Move `dirText`, `fillRowHtml`, `renderFills`, `loadFills`, `scheduleFillsReload`, and the filter/pager wiring (old `app.js:56-105`, `192-199`, `366-385`). **The three explanatory comments move verbatim** — the page clamp and the reload-don't-splice rationale are the reasons this code is correct.

```js
import { fmtUsd, fmtNum, fmtTime, cls, esc } from './format.js';
import * as api from './api.js';

const $ = (id) => document.getElementById(id);

const view = { rows: [], total: 0, limit: 50, offset: 0, closesOnly: false };
let address = null;
let reloadTimer = null;
let onError = () => {};

// Pre-migration rows have no dir; fall back to the raw HL side (B = bid/buy, A = ask/sell).
const dirText = (f) => f.dir || (f.side === 'B' ? 'Buy' : f.side === 'A' ? 'Sell' : '—');

function rowHtml(f) {
  return `
    <td>${fmtTime(f.ts)}</td>
    <td>${esc(f.coin ?? '—')}</td>
    <td>${esc(dirText(f))}</td>
    <td>${fmtNum(f.sz)}</td>
    <td>${fmtNum(f.px, 2)}</td>
    <td>${fmtUsd(f.fee)}</td>
    <td class="${cls(f.closed_pnl)}">${f.closed_pnl ? fmtUsd(f.closed_pnl) : '—'}</td>`;
}

function paint() {
  const tbody = $('fills').querySelector('tbody');
  tbody.innerHTML = '';
  $('fillsEmpty').classList.toggle('hidden', view.rows.length > 0);
  for (const row of view.rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = rowHtml(row);
    tbody.appendChild(tr);
  }
  const first = view.total === 0 ? 0 : view.offset + 1;
  const last = Math.min(view.offset + view.rows.length, view.total);
  $('fillsRange').textContent = view.total === 0 ? '—' : `${first}–${last} of ${view.total}`;
  $('fillsPrev').disabled = view.offset === 0;
  $('fillsNext').disabled = view.offset + view.limit >= view.total;
}

export async function load(retried = false) {
  if (!address) { view.rows = []; view.total = 0; paint(); return; }
  try {
    const data = await api.getFills(address, view);
    // The page can fall off the end of the data (a purge elsewhere, another tab,
    // a server restart). Clamp back to the last real page instead of rendering an
    // empty table under a "401–300 of 300" range.
    if (!retried && !data.fills.length && data.total > 0 && view.offset > 0) {
      view.offset = Math.max(0, (Math.ceil(data.total / view.limit) - 1) * view.limit);
      return load(true);
    }
    view.rows = data.fills;
    view.total = data.total;
    paint();
  } catch (err) { onError(err.message); }
}

// New fills arrived. Re-read page 1 from the server rather than splicing them in:
// the upstream userFills sub replays a snapshot on every reconnect, so a client-side
// running total drifts and a blind prepend can push the genuinely-newest rows off
// the page. The DB is the only thing that knows the real count and order.
export function scheduleReload() {
  if (reloadTimer || view.offset !== 0) return;
  reloadTimer = setTimeout(() => { reloadTimer = null; load(); }, 300);
}

export function setAddress(next) {
  address = next;
  view.offset = 0;
}

export function reset() {
  address = null;
  Object.assign(view, { rows: [], total: 0, limit: 50, offset: 0, closesOnly: false });
  clearTimeout(reloadTimer); reloadTimer = null;
  // Keep the filter buttons in sync with the closesOnly reset above.
  $('fillsClosesBtn').classList.remove('active');
  $('fillsAllBtn').classList.add('active');
  paint();
}

export function mount(handlers) {
  onError = handlers.onError;
  const setFilter = (closesOnly, activeBtn) => {
    document.querySelectorAll('#fillsAllBtn, #fillsClosesBtn').forEach((b) => b.classList.remove('active'));
    activeBtn.classList.add('active');
    view.closesOnly = closesOnly;
    view.offset = 0;
    load();
  };
  $('fillsAllBtn').addEventListener('click', (e) => setFilter(false, e.currentTarget));
  $('fillsClosesBtn').addEventListener('click', (e) => setFilter(true, e.currentTarget));
  $('fillsPrev').addEventListener('click', () => {
    view.offset = Math.max(0, view.offset - view.limit);
    load();
  });
  $('fillsNext').addEventListener('click', () => {
    if (view.offset + view.limit < view.total) { view.offset += view.limit; load(); }
  });
}
```

- [ ] **Step 3: Create `public/js/exports.js`**

Move `yearBounds`, `setExportEnabled`, `loadExportYears`, `downloadExport`, `syncHistory` (old `app.js:107-190`), keeping the timezone and resume-cursor comments verbatim.

```js
import * as api from './api.js';

const $ = (id) => document.getElementById(id);

let address = null;
let onSynced = () => {};
const syncResume = {}; // address -> { fills, funding } cursors from a truncated sync

// Year bounds are computed HERE, in the browser's timezone, and sent as explicit
// epoch ms — so the server never has to guess where the user's year starts.
function yearBounds(year) {
  return { from: new Date(year, 0, 1).getTime(), to: new Date(year + 1, 0, 1).getTime() };
}

function setEnabled(on) {
  for (const id of ['exportYear', 'exportDetailedBtn', 'exportKoinlyBtn', 'syncBtn']) $(id).disabled = !on;
}

export async function setAddress(next) {
  address = next;
  const sel = $('exportYear');
  sel.innerHTML = '';
  if (!address) { setEnabled(false); return; }
  setEnabled(true);
  try {
    const { minTs, maxTs } = await api.getRange(address);
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

function download(format) {
  if (!address) return;
  const sel = $('exportYear').value;
  const params = new URLSearchParams({
    format,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  });
  if (sel && sel !== 'all') {
    const { from, to } = yearBounds(Number(sel));
    params.set('from', String(from));
    params.set('to', String(to));
    params.set('label', sel);
  }
  window.location = api.exportUrl(address, params);
}

async function sync() {
  if (!address) return;
  const out = $('syncResult');
  $('syncBtn').disabled = true;
  out.textContent = 'Syncing from Hyperliquid…';
  try {
    // Resume where a previous truncated run stopped. Without carrying these the
    // next run would restart at 0, re-scan what it already has, and stop in the
    // same place — so "run again to continue" would be a lie.
    const r = await api.backfill(address, syncResume[address]);
    if (r.skipped) {
      out.textContent = 'Nothing synced — this wallet is not on your saved list.';
      delete syncResume[address];
    } else {
      // `enriched` counts pre-existing fills that gained a missing field.
      const bits = [
        `${r.fills.inserted} new fills`,
        `${r.fills.enriched} existing fills completed`,
        `${r.funding.inserted} funding entries`,
      ];
      if (r.truncated) syncResume[address] = { fills: r.fills.nextFrom, funding: r.funding.nextFrom };
      else delete syncResume[address];
      out.textContent = `Synced: ${bits.join(', ')}.` +
        (r.truncated ? ' Stopped at the page limit — click again to continue from here.' : '');
    }
    await onSynced();
    await setAddress(address);
  } catch (e) {
    out.textContent = `Sync failed: ${e.message}`;
  } finally {
    $('syncBtn').disabled = false;
  }
}

export function reset() {
  address = null;
  $('exportYear').innerHTML = '';
  $('syncResult').textContent = '';
  setEnabled(false);
}

export function mount(handlers) {
  onSynced = handlers.onSynced;
  $('exportDetailedBtn').addEventListener('click', () => download('detailed'));
  $('exportKoinlyBtn').addEventListener('click', () => download('koinly'));
  $('syncBtn').addEventListener('click', sync);
}
```

- [ ] **Step 4: Create `public/js/wallets.js`**

Move `loadWallets`, `renderWalletBadge`, `loadAgents`, and the Add/Delete handlers (old `app.js:201-210`, `237-255`, `334-346`, `394-420`). Behavior unchanged in this task — the dropdown stays; Task 12 replaces it.

```js
import * as api from './api.js';
import { short, esc } from './format.js';

const $ = (id) => document.getElementById(id);

let meta = {};
let handlers = { onSelect: () => {}, onEmpty: () => {}, onError: () => {} };

export const metaFor = (address) => meta[address];

export async function load(selected) {
  const { wallets } = await api.getWallets();
  meta = {};
  const sel = $('walletSelect');
  sel.innerHTML = '';
  for (const w of wallets) {
    meta[w.address] = { label: w.label, viaAgent: w.via_agent };
    const o = document.createElement('option');
    o.value = w.address;
    o.textContent = w.label
      ? `${w.label} (${w.address.slice(0, 6)}…)`
      : `${w.address.slice(0, 10)}…${w.address.slice(-4)}`;
    sel.appendChild(o);
  }
  if (selected) sel.value = selected;
  return wallets;
}

export const selectedValue = () => $('walletSelect').value;

export function renderBadge(address) {
  const m = meta[address];
  const el = $('walletBadge');
  if (m && m.viaAgent) {
    el.innerHTML = `Agent wallet <code>${short(m.viaAgent)}</code> → showing master <code>${short(address)}</code>`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

export async function renderAgents(address) {
  const panel = $('agentsPanel');
  panel.innerHTML = '';
  try {
    const { agents } = await api.getAgents(address);
    if (!agents.length) {
      panel.innerHTML = '<div class="agents-empty">No agent wallets connected.</div>';
      return;
    }
    for (const a of agents) {
      const row = document.createElement('div');
      row.className = 'agent-row' + (a.expired ? ' expired' : '');
      const validTxt = a.validUntil != null ? new Date(a.validUntil).toLocaleDateString() : '—';
      const expiredTxt = a.expired ? ' <span class="agent-badge-expired">expired</span>' : '';
      row.innerHTML = `<span class="agent-name">${esc(a.name || 'Agent')}</span>
        <span class="agent-meta">${short(a.address)} · valid until ${validTxt}${expiredTxt}</span>`;
      panel.appendChild(row);
    }
  } catch {
    panel.innerHTML = '<div class="agents-empty">Couldn\'t load connected agents.</div>';
  }
}

export function reset() {
  $('agentsPanel').innerHTML = '';
  $('walletBadge').classList.add('hidden');
}

export function mount(h) {
  handlers = h;
  $('addBtn').addEventListener('click', async () => {
    const address = $('walletInput').value.trim().toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { handlers.onError('Invalid wallet address.'); return; }
    try {
      const { resolved } = await api.addWallet(address);
      $('walletInput').value = '';
      const canonical = resolved?.address || address;
      await load(canonical);
      await handlers.onSelect(canonical);
    } catch (e) { handlers.onError(e.message); }
  });
  $('removeBtn').addEventListener('click', async () => {
    const a = selectedValue();
    if (!a) return;
    const m = meta[a];
    const name = m?.label ? `${m.label} (${short(a)})` : short(a);
    // Purging is irreversible: realized PnL is cumulative since first observed and
    // Hyperliquid only re-serves a limited recent window.
    if (!confirm(`Delete ${name}?\n\nThis also erases its stored trade history and equity snapshots. This cannot be undone.`)) return;
    try {
      await api.deleteWallet(a);
      await load();
      const next = selectedValue();
      if (next) await handlers.onSelect(next);
      else handlers.onEmpty();
    } catch (e) { handlers.onError(e.message); }
  });
  $('walletSelect').addEventListener('change', (e) => handlers.onSelect(e.target.value));
}
```

- [ ] **Step 5: Rewrite `public/js/app.js` as the orchestrator**

```js
import * as api from './api.js';
import * as account from './account.js';
import * as fills from './fills.js';
import * as exportsPanel from './exports.js';
import * as wallets from './wallets.js';
import { createChart } from './chart.js';

const $ = (id) => document.getElementById(id);

const state = {
  address: null, ws: null, pollTimer: null, refreshTimer: null,
  series: 'equity', history: [], wsConnected: false,
};

let chart = null;

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'badge ' + (kind || '');
}
function showError(msg) { const e = $('error'); e.textContent = msg; e.classList.remove('hidden'); }
function clearError() { $('error').classList.add('hidden'); }
function setLoading(on) { $('loading').classList.toggle('hidden', !on); }

async function loadHistory() {
  if (!state.address) return;
  try {
    const { points } = await api.getHistory(state.address);
    state.history = points;
    chart.render(state.history, { series: state.series });
  } catch {}
}

async function refresh(showLoad = true) {
  if (!state.address) return;
  if (showLoad) setLoading(true);
  try {
    const data = await api.getAccount(state.address);
    clearError();
    account.render(data);
    await loadHistory();
    await fills.load();
  } catch (err) { showError(err.message); }
  finally { setLoading(false); }
}

function scheduleRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(() => { state.refreshTimer = null; refresh(false); }, 1500);
}

// Clear every panel back to its empty state — used when the last wallet is deleted.
function resetDashboard() {
  state.address = null;
  state.history = [];
  account.reset();
  fills.reset();
  exportsPanel.reset();
  wallets.reset();
  chart.render([], { series: state.series });
  clearError();
  setStatus('Enter a wallet', 'poll');
}

async function selectAddress(address) {
  state.address = address;
  state.history = [];
  fills.setAddress(address);
  wallets.renderBadge(address);
  await refresh(true);
  await wallets.renderAgents(address);
  await exportsPanel.setAddress(address);
  if (state.wsConnected) state.ws.send(JSON.stringify({ type: 'watch', address }));
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    state.wsConnected = true;
    setStatus('Live', 'live');
    if (state.address) ws.send(JSON.stringify({ type: 'watch', address: state.address }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    // The hub keeps routing the previously-watched address until our `watch` for the
    // new one lands, so a broadcast can outrun a wallet switch. Ignore anything not
    // for the wallet on screen — and anything at all once it's been deleted.
    if (msg.address && msg.address !== state.address) return;
    if (msg.type === 'refresh') scheduleRefresh();
    else if (msg.type === 'realized') {
      if (!state.address) return; // wallet was just deleted; ignore in-flight fills for it
      account.setRealized(msg.realizedPnlCumulative);
      fills.scheduleReload();
    } else if (msg.type === 'error') showError(msg.message);
  };
  // WS down, but the always-on 30s poll keeps data fresh — show "Polling" (not an
  // alarming "down" state) while we reconnect in the background.
  ws.onclose = () => { state.wsConnected = false; setStatus('Polling', 'poll'); setTimeout(connectWs, 3000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => refresh(false), 30000);
}

async function init() {
  setStatus('Connecting…');
  chart = createChart($('chart'));

  document.querySelectorAll('#chartToggle button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#chartToggle button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.series = b.dataset.series;
      chart.render(state.history, { series: state.series });
    }));

  fills.mount({ onError: showError });
  exportsPanel.mount({ onSynced: () => fills.load() });
  wallets.mount({ onSelect: selectAddress, onEmpty: resetDashboard, onError: showError });
  $('refreshBtn').addEventListener('click', () => refresh(true));

  // bootstrap: saved wallets + default (resolve in case DEFAULT_WALLET is an agent address)
  const { defaultWallet } = await api.getConfig();
  let preferred = defaultWallet || undefined;
  if (defaultWallet) {
    try {
      const { resolved } = await api.addWallet(defaultWallet);
      preferred = resolved?.address || defaultWallet;
    } catch {}
  }
  await wallets.load(preferred);
  connectWs();
  startPolling();
  const first = wallets.selectedValue() || preferred;
  if (first) await selectAddress(first);
  else setStatus('Enter a wallet', 'poll');
}

init();
```

- [ ] **Step 6: Verify**

Run: `npm start`, then walk the Task 2 Step 5 checklist again in full.
Expected: identical behavior. Confirm `public/js/app.js` is under 180 lines: `wc -l public/js/app.js`

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -A public
git commit -m "refactor(ui): extract account, fills, exports and wallets panels"
```

---

### Task 4: Design tokens and numeric typography

**Goal:** Replace scattered magic values with a token layer and put tabular numerals on every number — the single change that most reduces the "unfinished" feel.

**Files:**
- Modify: `public/styles.css` (token block at top; replace literals throughout)

**Acceptance Criteria:**
- [ ] No raw hex color appears below the `:root` block in `styles.css`
- [ ] Padding values come from `--sp-*`; radii from `--r-*`
- [ ] Every numeric table cell and card value uses `font-variant-numeric: tabular-nums`
- [ ] A `@media (prefers-reduced-motion: reduce)` block disables transitions
- [ ] Layout is visually unchanged apart from spacing regularity and digit alignment

**Verify:** `npm start` → digits no longer shift width as live values update; `grep -n '#[0-9a-fA-F]\{6\}' public/styles.css` → matches only inside the `:root` block

**Steps:**

- [ ] **Step 1: Replace the `:root` block with the token layer**

```css
:root{
  /* surfaces */
  --bg:#0b0e14; --bg2:#121722;
  --surface-1:#161c2b; --surface-2:#1a2131; --surface-3:#10151f;
  --card-grad-end:#121624;
  --line:#222b3d; --line-soft:#1a2130;

  /* text */
  --text:#e6ebf5; --muted:#8a97b1;

  /* semantics */
  --pos:#1fd09a; --neg:#ff5d6c; --accent:#6c8cff; --warn:#ffce6a;
  --pos-a12:rgba(31,208,154,.12); --neg-a12:rgba(255,93,108,.12);
  --pos-a40:rgba(31,208,154,.4); --neg-a40:rgba(255,93,108,.4);
  --accent-a08:rgba(108,140,255,.08); --accent-a40:rgba(108,140,255,.4);
  --warn-a40:rgba(255,206,106,.4);

  /* space */
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:24px; --sp-6:32px;

  /* radius */
  --r-sm:8px; --r-md:10px; --r-lg:14px; --r-pill:999px;

  /* type */
  --fs-xs:10px; --fs-sm:12px; --fs-base:13px; --fs-lg:15px; --fs-xl:21px; --fs-2xl:26px;

  /* elevation + motion */
  --shadow-card:0 8px 30px rgba(0,0,0,.25);
  --shadow-pop:0 16px 40px rgba(0,0,0,.5);
  --dur-fast:120ms; --dur:180ms; --ease:cubic-bezier(.2,.6,.2,1);
}

/* Digits must not change width as live values tick, or the whole table jitters. */
.num,.card-value,td,th{font-variant-numeric:tabular-nums}

@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{
    animation-duration:.001ms !important; animation-iteration-count:1 !important;
    transition-duration:.001ms !important;
  }
}
```

- [ ] **Step 2: Substitute tokens through the rest of the file**

Work top to bottom in `public/styles.css` replacing literals. The complete mapping:

| Literal | Token |
|---|---|
| `#121624` (card/panel gradient end) | `var(--card-grad-end)` |
| `#8a97b1` | `var(--muted)` |
| `rgba(31,208,154,.4)` | `var(--pos-a40)` |
| `rgba(255,93,108,.4)` | `var(--neg-a40)` |
| `rgba(255,206,106,.4)` | `var(--warn-a40)` |
| `#ffce6a` | `var(--warn)` |
| `rgba(108,140,255,.4)` | `var(--accent-a40)` |
| `rgba(108,140,255,.08)` | `var(--accent-a08)` |
| `rgba(255,93,108,.3)` | `var(--neg-a40)` |
| `border-radius:16px` | `border-radius:var(--r-lg)` |
| `border-radius:12px`, `10px` | `var(--r-md)` |
| `border-radius:8px` | `var(--r-sm)` |
| `border-radius:999px` | `var(--r-pill)` |
| `padding:16px 18px` | `padding:var(--sp-4)` |
| `padding:14px 20px` | `padding:var(--sp-3) var(--sp-5)` |
| `padding:8px 10px`, `8px 12px` | `padding:var(--sp-2) var(--sp-3)` |
| `padding:6px 10px`, `5px 10px`, `5px 12px` | `padding:var(--sp-1) var(--sp-3)` |
| `padding:10px 8px` (cells) | `padding:var(--sp-3) var(--sp-2)` |
| `padding:20px` (empty/error) | `padding:var(--sp-5)` |
| `padding:18px` (foot) | `padding:var(--sp-4)` |
| `gap:14px`, `12px` | `gap:var(--sp-3)` |
| `gap:8px`, `6px` | `gap:var(--sp-2)` |
| `font-size:12px` | `var(--fs-sm)` |
| `font-size:13px` | `var(--fs-base)` |
| `font-size:15px` | `var(--fs-lg)` |
| `font-size:26px` | `var(--fs-2xl)` |
| `box-shadow:0 8px 30px rgba(0,0,0,.25)` | `var(--shadow-card)` |
| `transition:.15s` | `transition:border-color var(--dur-fast) var(--ease)` |

Set `.card-value` to `font-size:var(--fs-xl)` (21px, down from 26px) and add `letter-spacing:-.3px` — the smaller, tighter value is what makes the sparkline and delta added in Task 10 fit without the card growing.

Set `.card-label` and `th` to `font-size:var(--fs-xs)` with `letter-spacing:.6px`.

- [ ] **Step 3: Verify**

Run: `npm start`, open <http://localhost:3000>
Expected: layout matches the previous build; card values are slightly smaller and tighter; watching a live position update, the uPnL and Mark columns no longer shift horizontally.

Run: `grep -n '#[0-9a-fA-F]\{6\}' public/styles.css`
Expected: matches only on lines inside the `:root` block.

- [ ] **Step 4: Commit**

```bash
git add public/styles.css
git commit -m "style(ui): add design tokens and tabular numerals"
```

---

### Task 5: Feedback module — toasts, skeletons, confirm dialog, status pulse

**Goal:** Replace the "Loading…" overlay, the sticky error box for non-blocking failures, and `window.confirm()` with real states.

**Files:**
- Create: `public/js/feedback.js`
- Modify: `public/index.html` (remove `#loading`, add `#toasts` and `#modalRoot`), `public/styles.css`, `public/js/app.js`, `public/js/wallets.js`, `public/js/exports.js`, `public/js/fills.js`

**Acceptance Criteria:**
- [ ] The dimmed "Loading…" overlay is gone; shimmer placeholders appear in cards, chart, and table during load
- [ ] Wallet add/remove and completed syncs produce a toast that auto-dismisses in 5s
- [ ] A **truncated** sync keeps its persistent inline line in the Export panel
- [ ] Deleting a wallet opens a focus-trapped dialog; Escape cancels; the warning copy is unchanged
- [ ] Status badge shows a pulse dot when Live, static under `prefers-reduced-motion`
- [ ] A failure that leaves the page empty still uses the inline `#error` region

**Verify:** `npm start` → switch wallets and observe shimmer; add a wallet → toast; click ✕ → dialog, press Escape → nothing deleted

**Steps:**

- [ ] **Step 1: Create `public/js/feedback.js`**

```js
// Toasts, skeletons, the confirm dialog, and the status badge.
//
// Error policy: a failure that leaves the dashboard unusable gets the persistent
// inline #error region; a failure that does not gets a toast. A toast that fades
// is the wrong medium when the page behind it is blank.

const $ = (id) => document.getElementById(id);

export function toast(message, kind = 'info') {
  const host = $('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  const remove = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 200); };
  el.addEventListener('click', remove);
  host.appendChild(el);
  setTimeout(remove, 5000);
}

export function setStatus(text, kind) {
  const el = $('status');
  el.className = 'badge ' + (kind || '');
  el.innerHTML = `<span class="status-dot"></span>${text}`;
}

export function setLoading(on) {
  document.body.classList.toggle('is-loading', on);
}

// Placeholder rows so a loading table has the shape of a full one.
export function skeletonRows(tbody, cols, n = 6) {
  tbody.innerHTML = '';
  for (let r = 0; r < n; r++) {
    const tr = document.createElement('tr');
    tr.className = 'skeleton-row';
    tr.innerHTML = Array.from({ length: cols }, () => '<td><span class="shimmer"></span></td>').join('');
    tbody.appendChild(tr);
  }
}

export function confirmDialog({ title, body, confirmLabel = 'Delete' }) {
  return new Promise((resolve) => {
    const root = $('modalRoot');
    const previouslyFocused = document.activeElement;
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
          <h3 id="modalTitle">${title}</h3>
          <p class="modal-body">${body}</p>
          <div class="modal-actions">
            <button class="btn" data-act="cancel">Cancel</button>
            <button class="btn btn-danger" data-act="confirm">${confirmLabel}</button>
          </div>
        </div>
      </div>`;
    root.classList.remove('hidden');

    const focusables = root.querySelectorAll('button');
    const first = focusables[0], last = focusables[focusables.length - 1];
    last.focus();

    const close = (result) => {
      document.removeEventListener('keydown', onKey);
      root.classList.add('hidden');
      root.innerHTML = '';
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
      if (e.key !== 'Tab') return;
      // Trap focus inside the dialog.
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    root.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
    root.querySelector('[data-act="confirm"]').addEventListener('click', () => close(true));
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) close(false);
    });
  });
}
```

- [ ] **Step 2: Update the markup**

In `public/index.html`, delete line 110 (`<div id="loading" …>`) and add before `</main>`:

```html
    <div id="error" class="error hidden"></div>
    <div id="toasts" class="toasts" aria-live="polite"></div>
    <div id="modalRoot" class="hidden"></div>
```

(The existing `#error` div at line 111 moves into this block; do not duplicate it.)

- [ ] **Step 3: Add the styles**

Append to `public/styles.css`:

```css
/* ---- toasts ---- */
.toasts{position:fixed;right:var(--sp-4);bottom:var(--sp-4);display:flex;flex-direction:column;
  gap:var(--sp-2);z-index:60;max-width:min(360px,calc(100vw - var(--sp-6)))}
.toast{background:var(--surface-2);border:1px solid var(--line);border-left-width:3px;
  border-radius:var(--r-md);padding:var(--sp-3);font-size:var(--fs-sm);color:var(--text);
  box-shadow:var(--shadow-pop);cursor:pointer;animation:toast-in var(--dur) var(--ease)}
.toast-success{border-left-color:var(--pos)}
.toast-error{border-left-color:var(--neg)}
.toast-info{border-left-color:var(--accent)}
.toast.leaving{opacity:0;transition:opacity var(--dur) var(--ease)}
@keyframes toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

/* ---- skeletons ---- */
.shimmer{display:block;height:12px;border-radius:var(--r-sm);
  background:linear-gradient(90deg,var(--surface-2) 25%,var(--line) 37%,var(--surface-2) 63%);
  background-size:400% 100%;animation:shimmer 1.4s linear infinite}
@keyframes shimmer{from{background-position:100% 0}to{background-position:0 0}}
.is-loading .card-value,.is-loading .card-sub{color:transparent;position:relative}
.is-loading .card-value::after{content:"";position:absolute;inset:2px 30% 2px 0;border-radius:var(--r-sm);
  background:var(--surface-2);animation:shimmer 1.4s linear infinite;
  background-image:linear-gradient(90deg,var(--surface-2) 25%,var(--line) 37%,var(--surface-2) 63%);
  background-size:400% 100%}
.is-loading canvas{opacity:.35}

/* ---- modal ---- */
.modal-backdrop{position:fixed;inset:0;background:rgba(4,6,10,.62);backdrop-filter:blur(3px);
  display:flex;align-items:center;justify-content:center;z-index:70;padding:var(--sp-4)}
.modal{background:var(--surface-1);border:1px solid var(--line);border-radius:var(--r-lg);
  padding:var(--sp-5);max-width:440px;box-shadow:var(--shadow-pop)}
.modal h3{margin:0 0 var(--sp-2);font-size:var(--fs-lg)}
.modal-body{margin:0 0 var(--sp-4);color:var(--muted);font-size:var(--fs-base);line-height:1.6}
.modal-actions{display:flex;justify-content:flex-end;gap:var(--sp-2)}
.btn{background:var(--bg2);color:var(--text);border:1px solid var(--line);
  border-radius:var(--r-md);padding:var(--sp-2) var(--sp-3);font-size:var(--fs-sm);cursor:pointer}
.btn-danger{color:var(--neg);border-color:var(--neg-a40)}
.btn-danger:hover{background:var(--neg-a12)}

/* ---- status dot ---- */
.status-dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block;
  margin-right:var(--sp-1)}
.badge.live .status-dot{animation:pulse 2s var(--ease) infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 var(--pos-a40)}50%{box-shadow:0 0 0 4px transparent}}

:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
```

- [ ] **Step 4: Route the call sites through it**

In `public/js/app.js`: delete the local `setStatus` and `setLoading`, add `import { setStatus, setLoading, toast } from './feedback.js';`. `refresh()` keeps using `setLoading`, which now toggles the shimmer class rather than the removed overlay.

In `public/js/fills.js`: import `skeletonRows` and call `skeletonRows($('fills').querySelector('tbody'), 7)` at the top of `load()` when `view.rows.length === 0`.

In `public/js/wallets.js`: replace the `confirm(...)` call with the dialog, keeping the copy identical:

```js
import { confirmDialog, toast } from './feedback.js';
// …
const ok = await confirmDialog({
  title: `Delete ${name}?`,
  // Purging is irreversible: realized PnL is cumulative since first observed and
  // Hyperliquid only re-serves a limited recent window.
  body: 'This also erases its stored trade history and equity snapshots. This cannot be undone.',
});
if (!ok) return;
try {
  await api.deleteWallet(a);
  toast(`Deleted ${name}`, 'success');
  // …unchanged
```

Also add `toast('Wallet added', 'success')` after a successful `addWallet`.

In `public/js/exports.js`: apply the split policy — a completed sync becomes a toast and clears the inline line; a truncated one keeps it.

```js
if (r.truncated) {
  syncResume[address] = { fills: r.fills.nextFrom, funding: r.funding.nextFrom };
  // Actionable and only explained here — this must not fade like a toast.
  out.textContent = `Synced: ${bits.join(', ')}. Stopped at the page limit — click again to continue from here.`;
} else {
  delete syncResume[address];
  out.textContent = '';
  toast(`Synced: ${bits.join(', ')}.`, 'success');
}
```

and replace `out.textContent = 'Sync failed: …'` with `toast('Sync failed: ' + e.message, 'error')`.

- [ ] **Step 5: Verify**

Run: `npm start`
Expected:
- Switching wallets shows shimmer in the cards and table, no dimmed overlay.
- Adding a wallet shows a toast bottom-right that fades after 5s; clicking it dismisses immediately.
- Clicking ✕ Delete opens the dialog; Tab cycles between Cancel and Delete only; Escape closes with nothing deleted; Delete removes the wallet and toasts.
- Enable "Reduce motion" in OS settings and reload: no shimmer animation, no pulse.

Run: `npm test` → PASS

- [ ] **Step 6: Commit**

```bash
git add -A public
git commit -m "feat(ui): toasts, skeletons, focus-trapped confirm dialog, status pulse"
```

---

### Task 6: `chart-math.js` with tests

**Goal:** Build and prove the pure geometry the chart needs, before any canvas code depends on it.

**Files:**
- Create: `public/js/chart-math.js`, `test/chart-math.test.js`

**Acceptance Criteria:**
- [ ] `niceTicks` produces 3–6 ticks on 1/2/5 boundaries for ordinary, zero-spanning, sub-unit, and flat ranges
- [ ] `computeScales` centers a flat series instead of dividing by zero
- [ ] `nearestIndex` is correct on empty, single-point, exact-match, and out-of-range input
- [ ] `segments` splits on nulls so the chart can draw gaps
- [ ] The module references no DOM global

**Verify:** `node --test test/chart-math.test.js` → PASS

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `test/chart-math.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { niceStep, niceTicks, computeScales, nearestIndex, segments, rangeChange }
  from '../public/js/chart-math.js';

test('niceStep snaps to 1/2/5 x 10^n', () => {
  assert.equal(niceStep(0.7), 1);
  assert.equal(niceStep(1.3), 2);
  assert.equal(niceStep(3), 5);
  assert.equal(niceStep(7), 10);
  assert.equal(niceStep(230), 500);
  assert.equal(niceStep(0.03), 0.05);
});

test('niceTicks covers ordinary ranges with round values', () => {
  const t = niceTicks(43120, 48950);
  assert.ok(t.length >= 3 && t.length <= 6, `got ${t.length} ticks`);
  assert.ok(t[0] >= 43120 && t[t.length - 1] <= 48950);
  for (const v of t) assert.equal(v % 1000, 0);
});

test('niceTicks handles a range spanning zero', () => {
  const t = niceTicks(-620, 380);
  assert.ok(t.includes(0), `expected a zero tick in ${t}`);
});

test('niceTicks handles a flat series without dividing by zero', () => {
  const t = niceTicks(500, 500);
  assert.ok(t.length > 0);
  assert.ok(t.every(Number.isFinite));
});

test('niceTicks handles sub-unit ranges', () => {
  const t = niceTicks(0.012, 0.048);
  assert.ok(t.length >= 2);
  assert.ok(t.every(Number.isFinite));
});

const BOX = { width: 600, height: 200, padLeft: 52, padRight: 12, padTop: 20, padBottom: 28 };

test('computeScales maps values into the plot box', () => {
  const s = computeScales([100, 200], BOX);
  assert.ok(s.y(s.max) >= BOX.padTop - 0.001);
  assert.ok(s.y(s.min) <= BOX.height - BOX.padBottom + 0.001);
  assert.equal(s.x(0, 2), BOX.padLeft);
  assert.equal(s.x(1, 2), BOX.width - BOX.padRight);
});

test('computeScales centers a flat series', () => {
  const s = computeScales([500, 500, 500], BOX);
  const mid = (BOX.padTop + (BOX.height - BOX.padBottom)) / 2;
  assert.ok(Math.abs(s.y(500) - mid) < 0.001);
});

test('computeScales survives an all-null series', () => {
  const s = computeScales([null, null], BOX);
  assert.ok(Number.isFinite(s.y(0)));
});

const PTS = [{ ts: 10 }, { ts: 20 }, { ts: 30 }, { ts: 100 }];

test('nearestIndex finds the closest point', () => {
  assert.equal(nearestIndex([], 5), -1);
  assert.equal(nearestIndex([{ ts: 7 }], 999), 0);
  assert.equal(nearestIndex(PTS, 20), 1);   // exact
  assert.equal(nearestIndex(PTS, 0), 0);    // before start
  assert.equal(nearestIndex(PTS, 500), 3);  // past end
  assert.equal(nearestIndex(PTS, 22), 1);   // closer to 20
  assert.equal(nearestIndex(PTS, 28), 2);   // closer to 30
  assert.equal(nearestIndex(PTS, 65), 2);   // tie-ish, lower wins
});

test('segments splits on nulls and keeps original indices', () => {
  const s = segments([1, 2, null, 4, 5]);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0].map((p) => p.i), [0, 1]);
  assert.deepEqual(s[1].map((p) => p.i), [3, 4]);
});

test('rangeChange needs two finite points', () => {
  assert.equal(rangeChange([5]), null);
  assert.equal(rangeChange([null, null]), null);
  const c = rangeChange([100, 150]);
  assert.equal(c.abs, 50);
  assert.equal(c.pct, 50);
  assert.equal(rangeChange([0, 10]).pct, null); // no percent from a zero base
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/chart-math.test.js`
Expected: FAIL — `Cannot find module .../public/js/chart-math.js`

- [ ] **Step 3: Create `public/js/chart-math.js`**

```js
// Pure geometry for the chart. No DOM anywhere in this file — node:test imports it.

// Round a raw step up to the nearest 1, 2 or 5 times a power of ten, so axis
// labels land on numbers a human would have chosen.
export function niceStep(raw) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}

// Tick values inside [min, max], aiming for `target` gridlines.
export function niceTicks(min, max, target = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const p = Math.abs(min) * 0.01 || 1;
    min -= p; max += p;
  }
  const step = niceStep((max - min) / Math.max(1, target - 1));
  const ticks = [];
  const first = Math.ceil(min / step) * step;
  // Float error can drop the last tick; nudge the bound by a step epsilon.
  for (let v = first; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

// Maps series values into a plot box. `x` is index-based (snapshots are irregular
// in time but drawn evenly — matching the existing chart's behavior).
export function computeScales(values, box) {
  const { width, height, padLeft, padRight, padTop, padBottom, padFrac = 0.05 } = box;
  const finite = values.filter((v) => v != null && Number.isFinite(v));
  let min, max;
  if (!finite.length) { min = 0; max = 1; }
  else { min = Math.min(...finite); max = Math.max(...finite); }
  if (min === max) {
    const p = Math.abs(min) * 0.01 || 1;
    min -= p; max += p;
  } else {
    const p = (max - min) * padFrac;
    min -= p; max += p;
  }
  const x0 = padLeft, x1 = width - padRight, y0 = padTop, y1 = height - padBottom;
  return {
    min, max,
    plot: { x0, x1, y0, y1 },
    x: (i, n) => (n <= 1 ? (x0 + x1) / 2 : x0 + (i / (n - 1)) * (x1 - x0)),
    y: (v) => y1 - ((v - min) / (max - min)) * (y1 - y0),
  };
}

// Binary search for the point whose ts is closest to `ts`. Points are ascending.
export function nearestIndex(points, ts) {
  if (!points.length) return -1;
  let lo = 0, hi = points.length - 1;
  if (ts <= points[lo].ts) return lo;
  if (ts >= points[hi].ts) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].ts <= ts) lo = mid; else hi = mid;
  }
  return ts - points[lo].ts <= points[hi].ts - ts ? lo : hi;
}

// Contiguous runs of drawable values. A null is a gap in the line, not a zero —
// the old chart drew nulls as 0, which invented an observation that never happened.
export function segments(values) {
  const out = [];
  let cur = null;
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) { cur = null; return; }
    if (!cur) { cur = []; out.push(cur); }
    cur.push({ i, v });
  });
  return out;
}

// Absolute and percent change across a range. Percent is null from a zero base.
export function rangeChange(values) {
  const finite = values.filter((v) => v != null && Number.isFinite(v));
  if (finite.length < 2) return null;
  const first = finite[0], last = finite[finite.length - 1];
  return { abs: last - first, pct: first === 0 ? null : ((last - first) / Math.abs(first)) * 100 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/chart-math.test.js`
Expected: PASS — 12 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add public/js/chart-math.js test/chart-math.test.js
git commit -m "feat(ui): chart geometry helpers with unit tests"
```

---

### Task 7: Chart rendering — axes, gridlines, area fill, null gaps, sparse notice

**Goal:** Replace the bare line with a readable chart.

**Files:**
- Modify: `public/js/chart.js` (full rewrite of the draw path), `public/styles.css`, `public/index.html:41`

**Acceptance Criteria:**
- [ ] Y axis shows 4–5 compact dollar labels with gridlines
- [ ] X axis shows 3 date/time labels whose format matches the span
- [ ] A gradient area fills under the line, colored by overall direction
- [ ] A null value renders as a gap, not a point at zero
- [ ] Fewer than 2 points shows the sparse message, not an empty canvas
- [ ] Canvas is 280px tall on desktop, 200px below 760px, with height read from CSS

**Verify:** `npm start` → chart shows axes and grid; toggle to PnL on a wallet with null history rows → line breaks rather than dropping to zero

**Steps:**

- [ ] **Step 1: Let CSS own the canvas height**

In `public/index.html`, line 41, drop the `height` attribute:

```html
      <canvas id="chart"></canvas>
```

In `public/styles.css`, replace the `canvas{...}` rule:

```css
canvas{width:100%;display:block;height:280px}
@media(max-width:760px){canvas{height:200px}}
```

- [ ] **Step 2: Rewrite `public/js/chart.js`**

```js
import { fmtCompact, fmtUsd, fmtAxisTime } from './format.js';
import { niceTicks, computeScales, nearestIndex, segments, rangeChange } from './chart-math.js';

// Re-exported so consumers have one import for chart concerns.
export { niceTicks, computeScales, nearestIndex, segments, rangeChange };

const CSS = getComputedStyle(document.documentElement);
const token = (name, fallback) => (CSS.getPropertyValue(name) || '').trim() || fallback;

const COLORS = {
  grid: token('--line', '#222b3d'),
  muted: token('--muted', '#8a97b1'),
  text: token('--text', '#e6ebf5'),
  pos: token('--pos', '#1fd09a'),
  neg: token('--neg', '#ff5d6c'),
};

const PAD = { padLeft: 52, padRight: 14, padTop: 18, padBottom: 26 };

const valueOf = (p, series) => (series === 'equity' ? p.equity : p.unrealized_pnl);

export function createChart(canvas) {
  let points = [];
  let opts = { series: 'equity' };

  function draw() {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px system-ui, sans-serif';
    // Cleared up front so the pointer handler added in Task 8 can never hit-test
    // against scales left over from a previous, differently-shaped render.
    canvas._scales = null;

    const values = points.map((p) => valueOf(p, opts.series));
    const drawable = values.filter((v) => v != null && Number.isFinite(v));

    if (drawable.length < 2) {
      ctx.fillStyle = COLORS.muted;
      ctx.textAlign = 'center';
      const n = drawable.length;
      ctx.fillText(
        n === 0 ? 'No snapshots yet.' : `Only ${n} snapshot in this range.`,
        w / 2, h / 2 - 6,
      );
      ctx.fillText('Snapshots accrue while the dashboard is open.', w / 2, h / 2 + 10);
      ctx.textAlign = 'left';
      return;
    }

    const box = { width: w, height: h, ...PAD };
    const s = computeScales(values, box);
    const { x0, x1, y0, y1 } = s.plot;
    const n = points.length;

    // --- gridlines + y labels ---
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = 'right';
    for (const t of niceTicks(s.min, s.max)) {
      const y = Math.round(s.y(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillText(fmtCompact(t), x0 - 8, y + 3);
    }

    // --- x labels: first, middle, last ---
    const span = points[n - 1].ts - points[0].ts;
    ctx.fillStyle = COLORS.muted;
    const marks = n === 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
    marks.forEach((i, k) => {
      ctx.textAlign = k === 0 ? 'left' : k === marks.length - 1 ? 'right' : 'center';
      ctx.fillText(fmtAxisTime(points[i].ts, span), s.x(i, n), y1 + 18);
    });
    ctx.textAlign = 'left';

    // --- line direction sets the color ---
    const rising = drawable[drawable.length - 1] >= drawable[0];
    const stroke = rising ? COLORS.pos : COLORS.neg;
    const runs = segments(values);

    // --- area fill under each run ---
    const grad = ctx.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, hexA(stroke, 0.28));
    grad.addColorStop(1, hexA(stroke, 0));
    ctx.fillStyle = grad;
    for (const run of runs) {
      if (run.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(s.x(run[0].i, n), y1);
      for (const p of run) ctx.lineTo(s.x(p.i, n), s.y(p.v));
      ctx.lineTo(s.x(run[run.length - 1].i, n), y1);
      ctx.closePath();
      ctx.fill();
    }

    // --- the line itself, one path per run so nulls stay gaps ---
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const run of runs) {
      ctx.beginPath();
      run.forEach((p, k) => (k ? ctx.lineTo(s.x(p.i, n), s.y(p.v)) : ctx.moveTo(s.x(p.i, n), s.y(p.v))));
      ctx.stroke();
    }

    // --- sparse-data caveat ---
    if (drawable.length <= 4) {
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(`${drawable.length} snapshots`, x0 + 4, y0 + 10);
    }

    canvas._scales = { s, n, span, values };
  }

  // Canvas colors need rgba; the tokens are hex.
  function hexA(hex, a) {
    const v = hex.replace('#', '');
    const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  const onResize = () => draw();
  window.addEventListener('resize', onResize);

  return {
    render(nextPoints, nextOpts = {}) {
      points = nextPoints || [];
      opts = { ...opts, ...nextOpts };
      // A draw failure must not take the page down with it.
      try { draw(); } catch (e) {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = COLORS.muted;
        ctx.fillText("Couldn't draw the chart.", 12, 24);
        console.error(e);
      }
    },
    destroy() { window.removeEventListener('resize', onResize); },
  };
}

// Small inline trend line for the summary cards.
export function drawSparkline(canvas, values, color) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const runs = segments(values);
  if (!runs.length) return;
  const s = computeScales(values, { width: w, height: h, padLeft: 1, padRight: 1, padTop: 3, padBottom: 3 });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  for (const run of runs) {
    ctx.beginPath();
    run.forEach((p, k) => (k ? ctx.lineTo(s.x(p.i, values.length), s.y(p.v)) : ctx.moveTo(s.x(p.i, values.length), s.y(p.v))));
    ctx.stroke();
  }
}
```

- [ ] **Step 3: Verify**

Run: `npm start`
Expected: gridlines with `$48k`-style labels on the left; three date labels along the bottom; a gradient fill under the line, green when the series rises and red when it falls; on a wallet with only one snapshot, the sparse message instead of a blank canvas.

To confirm null gaps: with the app running, open the browser console and run
`document.querySelector('#chartToggle button[data-series="pnl"]').click()` on a wallet whose early snapshots predate unrealized-PnL capture. Expected: the line starts where data starts, with no segment anchored at zero.

Run: `npm test` → PASS

- [ ] **Step 4: Commit**

```bash
git add public/js/chart.js public/styles.css public/index.html
git commit -m "feat(ui): chart axes, gridlines, area fill and null gaps"
```

---

### Task 8: Chart interaction — crosshair, tooltip, last-value pill

**Goal:** Make the chart answer "what was it worth, and when?"

**Files:**
- Modify: `public/js/chart.js`

**Acceptance Criteria:**
- [ ] Moving the pointer over the plot draws a dashed crosshair and a marker on the nearest snapshot
- [ ] A tooltip shows the exact value and timestamp
- [ ] The tooltip flips left when it would overflow the right edge
- [ ] `pointerleave` clears the crosshair
- [ ] Touch drag works (pointer events, not mouse events)
- [ ] The last value stays pinned as a pill at the right edge

**Verify:** `npm start` → hover across the chart; drag on a touch device or with device emulation

**Steps:**

- [ ] **Step 1: Track hover state and redraw the overlay**

In `public/js/chart.js`, add `let hoverIndex = -1;` beside `let points = []`, and append this to the end of `draw()`, just before `canvas._scales = …`:

```js
    // --- last-value pill ---
    const lastIdx = runs[runs.length - 1][runs[runs.length - 1].length - 1].i;
    const lastVal = values[lastIdx];
    const pillText = fmtUsd(lastVal);
    const pillW = ctx.measureText(pillText).width + 16;
    const pillY = Math.min(Math.max(s.y(lastVal) - 10, y0), y1 - 20);
    ctx.fillStyle = hexA(stroke, 0.12);
    ctx.strokeStyle = hexA(stroke, 0.45);
    roundRect(ctx, x1 - pillW, pillY, pillW, 20, 10);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = stroke;
    ctx.textAlign = 'center';
    ctx.fillText(pillText, x1 - pillW / 2, pillY + 14);
    ctx.textAlign = 'left';

    // --- crosshair + tooltip ---
    if (hoverIndex >= 0 && hoverIndex < n && values[hoverIndex] != null) {
      const hx = s.x(hoverIndex, n), hy = s.y(values[hoverIndex]);
      ctx.save();
      ctx.strokeStyle = token('--accent', '#6c8cff');
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(hx, y0); ctx.lineTo(hx, y1); ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(hx, hy, 4, 0, Math.PI * 2);
      ctx.fillStyle = token('--bg', '#0b0e14');
      ctx.fill();
      ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke();

      const when = new Date(points[hoverIndex].ts).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      const what = fmtUsd(values[hoverIndex]);
      const boxW = Math.max(ctx.measureText(when).width, ctx.measureText(what).width) + 24;
      const boxH = 42;
      // Flip to the left of the crosshair when the tooltip would overflow.
      const bx = hx + 12 + boxW > x1 ? hx - 12 - boxW : hx + 12;
      const by = Math.min(Math.max(hy - boxH / 2, y0), y1 - boxH);
      ctx.fillStyle = token('--surface-3', '#10151f');
      ctx.strokeStyle = token('--line', '#222b3d');
      ctx.lineWidth = 1;
      roundRect(ctx, bx, by, boxW, boxH, 8);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(when, bx + 12, by + 17);
      ctx.fillStyle = COLORS.text;
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillText(what, bx + 12, by + 33);
      ctx.font = '10px system-ui, sans-serif';
    }
```

- [ ] **Step 2: Add the `roundRect` helper**

Add at module scope in `chart.js` (Safari versions in the wild still lack `ctx.roundRect`):

```js
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
```

- [ ] **Step 3: Wire pointer events**

Inside `createChart`, after `const onResize = …`:

```js
  // Pointer events rather than mouse events, so a touch drag scrubs the chart.
  function onPointerMove(e) {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const st = canvas._scales;
    if (!st || st.n < 2) return;
    const { x0, x1 } = st.s.plot;
    if (px < x0 - 8 || px > x1 + 8) { if (hoverIndex !== -1) { hoverIndex = -1; draw(); } return; }
    const frac = Math.min(1, Math.max(0, (px - x0) / (x1 - x0)));
    const ts = points[0].ts + frac * st.span;
    const idx = nearestIndex(points, ts);
    if (idx !== hoverIndex) { hoverIndex = idx; draw(); }
  }
  function onPointerLeave() { if (hoverIndex !== -1) { hoverIndex = -1; draw(); } }

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.style.touchAction = 'pan-y'; // let vertical page scroll through, scrub horizontally
```

Reset `hoverIndex = -1` at the top of `render()`, and remove both listeners in `destroy()`.

- [ ] **Step 4: Verify**

Run: `npm start`
Expected: hovering draws the dashed line and the dot; the tooltip tracks it and flips to the left in the right-hand quarter; leaving the canvas clears it; the last-value pill sits at the right edge. In Chrome device emulation with touch, dragging across the chart scrubs it while vertical swipes still scroll the page.

- [ ] **Step 5: Commit**

```bash
git add public/js/chart.js
git commit -m "feat(ui): chart crosshair, tooltip and last-value pill"
```

---

### Task 9: Range pills and change-over-range readout

**Goal:** Let the chart show 24h / 7d / 30d / All, using the `?since=` parameter that already exists.

**Files:**
- Modify: `public/index.html:33-42`, `public/styles.css`, `public/js/app.js`

**Acceptance Criteria:**
- [ ] Four range pills render; **All is active on load**
- [ ] Selecting a range re-fetches `/api/history/:address?since=<ms>` and redraws only the chart
- [ ] A change readout beside the title shows absolute and percent change, colored by sign
- [ ] The readout shows `—` when the range has fewer than two points
- [ ] The selection survives wallet switches within the session

**Verify:** `npm start` → click 24h; DevTools Network shows one request to `/api/history/…?since=<epoch>`; no other panel reloads

**Steps:**

- [ ] **Step 1: Update the panel head markup**

Replace `public/index.html` lines 33–42 with:

```html
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Equity / PnL History</h2>
          <div id="chartChange" class="chart-change">—</div>
        </div>
        <div class="panel-head-controls">
          <div class="toggle" id="chartToggle">
            <button class="active" data-series="equity">Equity</button>
            <button data-series="pnl">PnL</button>
          </div>
          <div class="pill" id="chartRange">
            <button data-range="86400000">24h</button>
            <button data-range="604800000">7d</button>
            <button data-range="2592000000">30d</button>
            <button class="on" data-range="all">All</button>
          </div>
        </div>
      </div>
      <canvas id="chart"></canvas>
    </section>
```

- [ ] **Step 2: Style the pills**

Append to `public/styles.css`:

```css
.panel-head-controls{display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap}
.chart-change{font-size:var(--fs-sm);color:var(--muted);margin:2px 0 var(--sp-2)}
.chart-change.pos{color:var(--pos)} .chart-change.neg{color:var(--neg)}
.pill{display:inline-flex;gap:2px;background:var(--surface-3);border:1px solid var(--line);
  border-radius:var(--r-md);padding:2px}
.pill button{background:none;border:0;color:var(--muted);font-size:11px;
  padding:var(--sp-1) var(--sp-2);border-radius:var(--r-sm);cursor:pointer;font:inherit;font-size:11px}
.pill button.on{background:var(--surface-2);color:var(--accent)}
```

- [ ] **Step 3: Wire the range in `public/js/app.js`**

Add `range: 'all'` to `state`, import `rangeChange` and `fmtUsd`/`fmtPct`, and replace `loadHistory`:

```js
import { rangeChange } from './chart-math.js';
import { fmtUsd, fmtPct } from './format.js';

function renderChange() {
  const el = $('chartChange');
  const values = state.history.map((p) => (state.series === 'equity' ? p.equity : p.unrealized_pnl));
  const c = rangeChange(values);
  const label = { all: 'all time', 86400000: '24h', 604800000: '7d', 2592000000: '30d' }[state.range];
  if (!c) { el.textContent = `— over ${label}`; el.className = 'chart-change'; return; }
  const arrow = c.abs >= 0 ? '▲' : '▼';
  const pct = c.pct == null ? '' : ` · ${fmtPct(c.pct)}`;
  el.textContent = `${arrow} ${fmtUsd(Math.abs(c.abs))}${pct} over ${label}`;
  el.className = 'chart-change ' + (c.abs > 0 ? 'pos' : c.abs < 0 ? 'neg' : '');
}

async function loadHistory() {
  if (!state.address) return;
  const since = state.range === 'all' ? 0 : Date.now() - Number(state.range);
  try {
    const { points } = await api.getHistory(state.address, since);
    state.history = points;
    chart.render(state.history, { series: state.series });
    renderChange();
  } catch {}
}
```

In `init`, add the pill handler and call `renderChange()` from the series toggle:

```js
  document.querySelectorAll('#chartRange button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#chartRange button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      state.range = b.dataset.range;
      loadHistory(); // chart only — the cards and tables are unaffected by range
    }));
```

and inside the existing `#chartToggle` handler, after `chart.render(...)`, add `renderChange();`.

- [ ] **Step 4: Verify**

Run: `npm start`
Expected: All is active on load and the chart matches the previous task exactly. Clicking 7d issues exactly one `/api/history/…?since=` request (check the Network tab) and redraws only the chart — the cards, positions table, and Trade History do not flicker. The readout reads e.g. `▲ $4,102.19 · +9.31% over 7d`. On a range with one snapshot it reads `— over 24h` and the chart shows the sparse message.

Run: `npm test` → PASS

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/styles.css public/js/app.js
git commit -m "feat(ui): chart range pills and change-over-range readout"
```

---

### Task 10: Summary cards — sparklines, 24h deltas, long/short split

**Goal:** Give the four cards trend and hierarchy.

**Files:**
- Modify: `public/js/account.js`, `public/js/app.js`, `public/index.html:24-29`, `public/styles.css`

**Acceptance Criteria:**
- [ ] Equity, Unrealized, and Realized cards each show a 20px sparkline
- [ ] Each shows a **24h** delta, independent of the chart's range pill
- [ ] With fewer than two snapshots in the last 24h the delta reads `—`, never `0.00%`
- [ ] Open Positions shows a long/short split
- [ ] Cards do not grow taller than the current layout at 1440px

**Verify:** `npm start` → set the chart to 24h then All; card deltas do not change

**Steps:**

- [ ] **Step 1: Add the card sub-elements to the markup**

Replace `public/index.html` lines 24–29 with:

```html
    <section class="cards" id="cards">
      <div class="card">
        <div class="card-label">Account Equity</div>
        <div class="card-value" id="equity">—</div>
        <div class="card-sub" id="equityDelta"></div>
        <canvas class="spark" id="equitySpark"></canvas>
      </div>
      <div class="card">
        <div class="card-label">Unrealized PnL</div>
        <div class="card-value" id="uPnl">—</div>
        <div class="card-sub" id="uPnlDelta"></div>
        <canvas class="spark" id="uPnlSpark"></canvas>
      </div>
      <div class="card">
        <div class="card-label">Realized PnL (cumulative)</div>
        <div class="card-value" id="rPnl">—</div>
        <div class="card-sub" id="rPnlRecent"></div>
        <canvas class="spark" id="rPnlSpark"></canvas>
      </div>
      <div class="card">
        <div class="card-label">Open Positions</div>
        <div class="card-value" id="posCount">—</div>
        <div class="card-sub" id="posSplit"></div>
      </div>
    </section>
```

- [ ] **Step 2: Style the sparkline**

Append to `public/styles.css`:

```css
.spark{display:block;width:100%;height:20px;margin-top:var(--sp-1)}
.card-sub.pos{color:var(--pos)} .card-sub.neg{color:var(--neg)}
```

- [ ] **Step 3: Render deltas and sparklines in `account.js`**

Add to `public/js/account.js`:

```js
import { fmtUsd, fmtNum, fmtPct, cls, esc } from './format.js';
import { drawSparkline } from './chart.js';
import { rangeChange } from './chart-math.js';

const DAY_MS = 86400000;
const SPARK_COLOR = { pos: '#1fd09a', neg: '#ff5d6c' };

// Card deltas are always 24h, deliberately independent of the chart's range pill —
// otherwise changing the chart would silently change what the cards claim.
function renderDelta(elId, values) {
  const el = document.getElementById(elId);
  const c = rangeChange(values);
  if (!c) { el.textContent = '—'; el.className = 'card-sub'; return; }
  const arrow = c.abs >= 0 ? '▲' : '▼';
  const pct = c.pct == null ? '' : ` · ${fmtPct(c.pct)}`;
  el.textContent = `${arrow} ${fmtUsd(Math.abs(c.abs))}${pct} today`;
  el.className = 'card-sub ' + cls(c.abs);
}

function spark(canvasId, values) {
  const finite = values.filter((v) => v != null && Number.isFinite(v));
  const rising = finite.length < 2 || finite[finite.length - 1] >= finite[0];
  drawSparkline(document.getElementById(canvasId), values, rising ? SPARK_COLOR.pos : SPARK_COLOR.neg);
}

// `history` is the full snapshot list; this slices its own 24h window from it.
export function renderTrends(history) {
  const cutoff = Date.now() - DAY_MS;
  const day = history.filter((p) => p.ts >= cutoff);
  renderDelta('equityDelta', day.map((p) => p.equity));
  renderDelta('uPnlDelta', day.map((p) => p.unrealized_pnl));
  spark('equitySpark', day.map((p) => p.equity));
  spark('uPnlSpark', day.map((p) => p.unrealized_pnl));
  spark('rPnlSpark', day.map((p) => p.realized_pnl_cum));
}
```

In `render(d)`, after `$('posCount').textContent = …`, add the split:

```js
  const longs = (d.positions || []).filter((p) => p.side === 'LONG').length;
  const shorts = (d.positions || []).length - longs;
  $('posSplit').textContent = (d.positions || []).length ? `${longs} long · ${shorts} short` : '';
```

In `reset()`, clear the new elements:

```js
  for (const id of ['equityDelta', 'uPnlDelta', 'posSplit']) document.getElementById(id).textContent = '';
  for (const id of ['equitySpark', 'uPnlSpark', 'rPnlSpark']) {
    const c = document.getElementById(id);
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }
```

- [ ] **Step 4: Feed the cards their own history**

The chart's `state.history` is range-filtered, so the cards must not reuse it. In `public/js/app.js`, fetch the 24h window separately once per refresh:

```js
async function loadTrends() {
  if (!state.address) return;
  try {
    const { points } = await api.getHistory(state.address, Date.now() - 86400000);
    account.renderTrends(points);
  } catch {}
}
```

Call `await loadTrends();` in `refresh()` immediately after `await loadHistory();`, and add `window.addEventListener('resize', () => loadTrends());` in `init` so the sparkline canvases resize with the cards.

- [ ] **Step 5: Verify**

Run: `npm start`
Expected: three cards carry a small trend line and a `▲ $1,204.18 · +2.56% today` line. Switch the chart range between 24h and All — the card deltas do not move. On a freshly added wallet with one snapshot, the deltas read `—` and the sparklines are blank rather than flat lines at zero.

Run: `npm test` → PASS

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/styles.css public/js/account.js public/js/app.js
git commit -m "feat(ui): card sparklines, 24h deltas and long/short split"
```

---

### Task 11: Tables — chips, sticky headers, hover, mobile scroll, empty states

**Goal:** Make the two tables read as designed rather than default.

**Files:**
- Modify: `public/styles.css`, `public/js/account.js`, `public/js/fills.js`, `public/index.html` (empty-state markup)

**Acceptance Criteria:**
- [ ] Side and Direction render as filled chips
- [ ] Rows highlight on hover; header row sticks while the table body scrolls
- [ ] Below 760px each table scrolls horizontally inside its panel with the first column pinned; the page body does not scroll sideways
- [ ] Trade History's empty state offers **Sync full history** inline
- [ ] The dex collateral suffix stays visually secondary to the coin

**Verify:** `npm start`, then narrow the window to 375px → tables scroll inside their panels, page does not

**Steps:**

- [ ] **Step 1: Add the table styles**

Append to `public/styles.css`:

```css
#tableWrap,#fillsWrap{overflow-x:auto;max-height:420px;overflow-y:auto}
thead th{position:sticky;top:0;background:var(--surface-1);z-index:2}
tbody tr{transition:background var(--dur-fast) var(--ease)}
tbody tr:hover td{background:var(--surface-2)}
td{border-bottom:1px solid var(--line-soft)}
.coin{font-weight:600}
.coin-dex{color:var(--muted);font-weight:400;font-size:var(--fs-xs)}
.chip{display:inline-block;font-size:var(--fs-xs);font-weight:700;padding:2px 7px;
  border-radius:var(--r-pill);letter-spacing:.3px}
.chip-long,.chip-buy{color:var(--pos);background:var(--pos-a12)}
.chip-short,.chip-sell{color:var(--neg);background:var(--neg-a12)}
.chip-flat{color:var(--muted);background:var(--surface-2)}
.empty{display:flex;flex-direction:column;align-items:center;gap:var(--sp-2)}
.empty-icon{font-size:20px;opacity:.6}
@media(max-width:760px){
  th:first-child,td:first-child{position:sticky;left:0;background:var(--surface-1);z-index:1}
  tbody tr:hover td:first-child{background:var(--surface-2)}
}
```

- [ ] **Step 2: Chip the positions table**

In `public/js/account.js`, replace the first two `<td>`s of the row template:

```js
      <td><span class="coin">${esc(p.coin ?? '—')}</span>${p.collateral ? `<span class="coin-dex"> · ${esc(p.collateral)}</span>` : ''}</td>
      <td><span class="chip ${p.side === 'LONG' ? 'chip-long' : 'chip-short'}">${p.side ?? '—'}</span></td>
```

- [ ] **Step 3: Chip the trade history direction**

In `public/js/fills.js`, replace the direction cell in `rowHtml`:

```js
// `dir` is HL's phrasing ("Close Long", "Open Short"); color by whether it bought or sold.
function dirChip(f) {
  const text = dirText(f);
  const buying = /buy|long/i.test(text) && !/close short/i.test(text);
  const kind = text === '—' ? 'flat' : buying ? 'buy' : 'sell';
  return `<span class="chip chip-${kind}">${esc(text)}</span>`;
}
```

and use `<td>${dirChip(f)}</td>` for the third cell, plus the same `.coin` treatment for the coin cell.

- [ ] **Step 4: Improve the empty states**

In `public/index.html`, replace line 54:

```html
        <div id="emptyState" class="empty hidden"><span class="empty-icon">◎</span>No open positions.</div>
```

and line 74:

```html
        <div id="fillsEmpty" class="empty hidden">
          <span class="empty-icon">◎</span>
          <span>No trades recorded yet.</span>
          <button id="fillsSyncBtn" class="btn">↻ Sync full history</button>
        </div>
```

In `public/js/exports.js`, add the `export` keyword to the existing `sync` declaration so the empty state can reuse it rather than duplicating it. Change the single line

```js
async function sync() {
```

to

```js
export async function sync() {
```

leaving the function body exactly as written in Task 3, and in `mount` add:

```js
  document.getElementById('fillsSyncBtn').addEventListener('click', sync);
```

- [ ] **Step 5: Verify**

Run: `npm start`
Expected: LONG/SHORT and Buy/Sell render as filled pills; rows highlight on hover; scrolling a long Trade History keeps its header visible. Narrow the window to 375px — each table scrolls horizontally within its panel with Time and Coin pinned, and the page itself has no horizontal scrollbar. On a wallet with no fills, the empty state offers the sync button and clicking it runs the same sync as the Export panel.

Run: `npm test` → PASS

- [ ] **Step 6: Commit**

```bash
git add -A public
git commit -m "feat(ui): table chips, sticky headers, mobile scroll and empty states"
```

---

### Task 12: Wallet switcher popover

**Goal:** Replace the header's control strip with a switcher plus a popover holding the list, add field, and per-wallet delete.

**Files:**
- Modify: `public/index.html:10-20`, `public/styles.css`, `public/js/wallets.js`, `public/js/app.js`

**Acceptance Criteria:**
- [ ] Header holds only the brand, the switcher, Refresh, and the status badge
- [ ] Clicking the switcher opens a popover listing every wallet with its own `✕`
- [ ] Popover closes on Escape, on outside click, and on selection
- [ ] Trigger carries `aria-expanded`; arrow keys move between wallet rows
- [ ] Deleting a **non-selected** wallet works and leaves the current view intact
- [ ] Below 640px the popover is a full-width bottom sheet

**Verify:** `npm start` → open the popover, delete a wallet other than the one loaded; the dashboard keeps showing the current wallet

**Steps:**

- [ ] **Step 1: Replace the header markup**

Replace `public/index.html` lines 10–20 with:

```html
  <header class="topbar">
    <div class="brand">⚡ Hyperliquid PnL</div>
    <div class="controls">
      <button id="walletSwitcher" class="switcher" aria-expanded="false" aria-haspopup="dialog">
        <span class="avatar" id="walletAvatar"></span>
        <span class="switcher-text">
          <span class="switcher-name" id="walletName">No wallet</span>
          <span class="switcher-sub" id="walletCount"></span>
        </span>
        <span class="switcher-caret">▾</span>
      </button>
      <button id="refreshBtn">↻ Refresh</button>
      <span id="status" class="badge">—</span>
    </div>
    <div id="walletPop" class="pop hidden" role="dialog" aria-label="Watched wallets">
      <div class="lbl">Watched wallets</div>
      <div id="walletList"></div>
      <div class="pop-divider"></div>
      <div class="lbl">Add a wallet</div>
      <div class="pop-add">
        <input id="walletInput" type="text" placeholder="0x… public address" autocomplete="off" spellcheck="false" />
        <button id="addBtn">Add</button>
      </div>
    </div>
  </header>
```

- [ ] **Step 2: Style it**

Append to `public/styles.css`:

```css
.topbar{position:relative}
.switcher{display:inline-flex;align-items:center;gap:var(--sp-2);background:var(--bg2);
  border:1px solid var(--line);border-radius:var(--r-md);padding:var(--sp-1) var(--sp-3);cursor:pointer;text-align:left}
.avatar{width:22px;height:22px;border-radius:6px;background:var(--surface-2);flex:none}
.switcher-text{display:flex;flex-direction:column;line-height:1.25}
.switcher-name{font-size:var(--fs-sm)}
.switcher-sub{font-size:var(--fs-xs);color:var(--muted)}
.switcher-caret{color:var(--muted);font-size:var(--fs-xs)}
.pop{position:absolute;top:calc(100% + var(--sp-2));right:var(--sp-5);width:340px;z-index:50;
  background:var(--surface-1);border:1px solid var(--line);border-radius:var(--r-lg);
  padding:var(--sp-3);box-shadow:var(--shadow-pop)}
.pop .lbl{color:var(--muted);font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.6px;margin-bottom:var(--sp-2)}
.pop-divider{height:1px;background:var(--line);margin:var(--sp-3) 0}
.pop-item{display:flex;justify-content:space-between;align-items:center;gap:var(--sp-2);
  padding:var(--sp-2);border-radius:var(--r-sm);font-size:var(--fs-sm);cursor:pointer;width:100%;
  background:none;border:0;color:var(--text);text-align:left}
.pop-item:hover,.pop-item.sel{background:var(--surface-2)}
.pop-item .via{color:var(--muted);font-size:var(--fs-xs)}
.pop-del{background:none;border:0;color:var(--muted);cursor:pointer;padding:var(--sp-1);border-radius:var(--r-sm)}
.pop-del:hover{color:var(--neg);background:var(--neg-a12)}
.pop-row{display:flex;align-items:center;gap:var(--sp-1)}
.pop-add{display:flex;gap:var(--sp-2)}
.pop-add input{flex:1;min-width:0}
@media(max-width:640px){
  .pop{position:fixed;left:0;right:0;bottom:0;top:auto;width:auto;
    border-radius:var(--r-lg) var(--r-lg) 0 0}
}
```

Delete the now-unused `input{min-width:280px}` rule and the `@media(max-width:760px){…input{min-width:160px}}` fragment.

- [ ] **Step 3: Rewrite the wallet UI in `public/js/wallets.js`**

Replace `load`, `selectedValue`, and `mount` (keep `renderBadge`, `renderAgents`, `reset`, and `metaFor` as they are):

```js
import { confirmDialog, toast } from './feedback.js';

let list = [];
let current = null;

// Deterministic per-address color so a wallet is recognisable at a glance.
function hueFor(address) {
  let h = 0;
  for (let i = 2; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) % 360;
  return h;
}

const nameFor = (w) => w.label || `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;

function paintSwitcher() {
  const w = list.find((x) => x.address === current);
  $('walletName').textContent = w ? nameFor(w) : 'No wallet';
  $('walletCount').textContent = list.length ? `${list.length} wallet${list.length > 1 ? 's' : ''}` : '';
  const av = $('walletAvatar');
  av.style.background = w
    ? `linear-gradient(135deg, hsl(${hueFor(w.address)} 70% 60%), hsl(${(hueFor(w.address) + 60) % 360} 70% 50%))`
    : 'var(--surface-2)';
}

function paintList() {
  const host = $('walletList');
  host.innerHTML = '';
  if (!list.length) { host.innerHTML = '<div class="agents-empty">No wallets yet.</div>'; return; }
  for (const w of list) {
    const row = document.createElement('div');
    row.className = 'pop-row';
    const pick = document.createElement('button');
    pick.className = 'pop-item' + (w.address === current ? ' sel' : '');
    pick.dataset.address = w.address;
    pick.innerHTML = `<span>${esc(nameFor(w))}${w.via_agent ? ' <span class="via">via agent</span>' : ''}</span>`;
    pick.addEventListener('click', async () => { close(); await handlers.onSelect(w.address); });
    const del = document.createElement('button');
    del.className = 'pop-del';
    del.setAttribute('aria-label', `Delete ${nameFor(w)}`);
    del.textContent = '✕';
    del.addEventListener('click', (e) => { e.stopPropagation(); remove(w); });
    row.append(pick, del);
    host.appendChild(row);
  }
}

async function remove(w) {
  const ok = await confirmDialog({
    title: `Delete ${nameFor(w)}?`,
    // Purging is irreversible: realized PnL is cumulative since first observed and
    // Hyperliquid only re-serves a limited recent window.
    body: 'This also erases its stored trade history and equity snapshots. This cannot be undone.',
  });
  if (!ok) return;
  try {
    await api.deleteWallet(w.address);
    toast(`Deleted ${nameFor(w)}`, 'success');
    const wasCurrent = w.address === current;
    await load(wasCurrent ? undefined : current);
    if (!wasCurrent) { paintList(); return; }
    if (list.length) await handlers.onSelect(list[0].address);
    else { close(); handlers.onEmpty(); }
  } catch (e) { handlers.onError(e.message); }
}

export async function load(selected) {
  const { wallets } = await api.getWallets();
  meta = {};
  list = wallets;
  for (const w of wallets) meta[w.address] = { label: w.label, viaAgent: w.via_agent };
  current = selected && wallets.some((w) => w.address === selected) ? selected : (wallets[0]?.address ?? null);
  paintSwitcher();
  paintList();
  return wallets;
}

export const selectedValue = () => current;

export function setCurrent(address) { current = address; paintSwitcher(); paintList(); }

function open() {
  $('walletPop').classList.remove('hidden');
  $('walletSwitcher').setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onOutside, true);
  $('walletList').querySelector('.pop-item')?.focus();
}

function close() {
  $('walletPop').classList.add('hidden');
  $('walletSwitcher').setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('pointerdown', onOutside, true);
}

const isOpen = () => !$('walletPop').classList.contains('hidden');

function onKey(e) {
  if (e.key === 'Escape') { close(); $('walletSwitcher').focus(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...$('walletList').querySelectorAll('.pop-item')];
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement);
  const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
  items[next].focus();
}

function onOutside(e) {
  if ($('walletPop').contains(e.target) || $('walletSwitcher').contains(e.target)) return;
  close();
}

export function mount(h) {
  handlers = h;
  $('walletSwitcher').addEventListener('click', () => (isOpen() ? close() : open()));
  $('addBtn').addEventListener('click', async () => {
    const address = $('walletInput').value.trim().toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { handlers.onError('Invalid wallet address.'); return; }
    try {
      const { resolved } = await api.addWallet(address);
      $('walletInput').value = '';
      const canonical = resolved?.address || address;
      await load(canonical);
      toast('Wallet added', 'success');
      close();
      await handlers.onSelect(canonical);
    } catch (e) { handlers.onError(e.message); }
  });
  $('walletInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addBtn').click(); });
}
```

- [ ] **Step 4: Update `app.js`**

`selectAddress` must keep the switcher label in sync — add `wallets.setCurrent(address);` as its first line. Remove any reference to `#walletSelect` and `#removeBtn` (both are gone from the markup).

- [ ] **Step 5: Verify**

Run: `npm start`
Expected: the header shows brand, switcher, Refresh, and status only. Clicking the switcher opens the popover; ArrowDown/ArrowUp move between wallets; Escape closes and returns focus to the trigger; clicking the page background closes it. Selecting a wallet switches the dashboard and closes the popover. Deleting a wallet that is **not** currently loaded removes only that row and leaves the dashboard untouched. Deleting the loaded wallet falls through to the next one, or resets the dashboard if it was the last. At 375px the popover docks to the bottom of the screen.

Run: `npm test` → PASS

- [ ] **Step 6: Commit**

```bash
git add -A public
git commit -m "feat(ui): wallet switcher popover with per-wallet delete"
```

---

### Task 13: Documentation and final verification

**Goal:** Bring the README in line with what the app now does, and run the whole manual checklist once.

**Files:**
- Modify: `README.md`

**Acceptance Criteria:**
- [ ] Features section describes the interactive chart and the switcher popover
- [ ] Project structure block reflects `public/js/`
- [ ] "no chart library" claim still present and still true
- [ ] Test section mentions the frontend unit tests
- [ ] Full manual checklist passes

**Verify:** `npm test` → PASS; manual checklist below → all green

**Steps:**

- [ ] **Step 1: Update the Features section**

In `README.md`, replace the chart bullet (line 23–24) with:

```markdown
- **Equity / PnL history chart** — hand-drawn on a `<canvas>` (no chart library),
  with dollar and date axes, a crosshair that snaps to the nearest snapshot, and
  24h / 7d / 30d / All range selection. Sparse ranges say how few snapshots they
  contain rather than drawing a confident line through three points.
```

Replace the Watched wallets bullet (lines 25–27) with:

```markdown
- **Watched wallets** — a switcher in the header opens a popover listing every
  saved wallet, with an add field and a per-wallet delete (confirmed, since
  deleting also purges that wallet's stored history — see Limitations).
```

Add after the responsive bullet:

```markdown
- **Summary cards** carry a 24-hour delta and sparkline. The delta is always 24h,
  independent of the chart's range selection.
```

- [ ] **Step 2: Update Tech stack and Test sections**

Change the Tech stack paragraph's first sentence to:

```markdown
Vanilla HTML/CSS/JS frontend, split into native ES modules with no build step
(no frameworks, no bundler, no chart library).
```

Change the Test paragraph to:

```markdown
Runs the unit tests (config, DB layer, normalizers/validation, account assembly,
the WebSocket stream, CSV export, plus the frontend formatters and chart
geometry) via Node's built-in test runner.
```

- [ ] **Step 3: Update the Project structure block**

Replace the `public/` section of the structure block:

```
public/
  index.html       Dashboard markup
  styles.css       Dark theme + design tokens
  js/
    app.js         Entry point: state, WebSocket, polling, wiring
    api.js         Route definitions (the only file holding URL strings)
    format.js      Pure formatters
    chart.js       Canvas chart: axes, crosshair, sparklines
    chart-math.js  Pure geometry (ticks, scales, nearest point)
    account.js     Summary cards + positions table
    fills.js       Trade history table
    wallets.js     Wallet switcher popover
    exports.js     Export panel + history sync
    feedback.js    Toasts, skeletons, confirm dialog
```

- [ ] **Step 4: Run the full manual checklist**

Run: `npm start` and confirm each:

- [ ] Live WebSocket updates land in the cards and prepend to Trade History
- [ ] Status badge shows Live; stopping the server flips it to Polling
- [ ] Chart: axes, grid, crosshair, tooltip, range pills, change readout
- [ ] Equity/PnL toggle updates both the chart and the change readout
- [ ] Card deltas stay fixed while the chart range changes
- [ ] Trade History paging, closes-only filter, and the page clamp (page to the end, then sync)
- [ ] Adding a wallet, switching wallets, deleting a non-selected wallet, deleting the last wallet
- [ ] Both CSV downloads fire; the period picker lists years
- [ ] A truncated sync leaves its message on screen; a complete sync toasts
- [ ] Agent badge and Connected Agent Wallets panel render
- [ ] Layout holds at 1440 / 768 / 375px with no horizontal page scroll
- [ ] OS "reduce motion" disables shimmer, pulse, and transitions

Run: `npm test`
Expected: PASS — all suites including `format` and `chart-math`.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: describe the refreshed UI and module layout"
```

---

## Self-Review Notes

**Spec coverage:** every section of the design doc maps to a task — module split (T1–T3), tokens and numerals (T4), states and feedback plus the error policy and truncated-sync rule (T5), chart math (T6), chart render including null gaps, sizing, and the sparse notice (T7), interaction (T8), range and change readout (T9), cards including the fixed-24h decision (T10), tables (T11), header popover (T12), README (T13).

**Two implementation decisions worth flagging to the reviewer:**

1. **`chart-math.js` is a separate file** from `chart.js`, which the spec did not name. `chart.js` re-exports its helpers, so the spec's stated interface holds. The reason is testability: `chart.js` reads CSS custom properties at module scope, so Node cannot import it; the math must live somewhere Node can reach.
2. **Task 10 fetches its own 24h history** rather than deriving deltas from `state.history`. Once range pills exist, `state.history` is range-filtered, so reusing it would make the card deltas silently follow the chart — exactly what the spec forbids. This is a second small `getHistory` call per refresh against an indexed local SQLite query.
