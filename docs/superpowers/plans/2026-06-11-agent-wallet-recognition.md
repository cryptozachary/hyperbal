# Agent Wallet Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognize Hyperliquid agent (API) wallets — resolve an entered agent address to its master account, and list the agents connected to an account.

**Architecture:** Resolution happens once, at the wallet-entry boundary (`POST /api/wallets` calls `userRole`). Only `role:"agent"` redirects to the master; the canonical master address is persisted and the agent is stored as `via_agent` metadata. REST account/history, the browser WS `watch` path, upstream `webData2`/`userFills` subscriptions, and DB keying all keep operating on a master address unchanged. A new `GET /api/agents/:address` (`extraAgents`) feeds a connected-agents UI panel.

**Tech Stack:** Node 18+, Express, vanilla HTML/CSS/JS, `better-sqlite3`, `ws`, `dotenv`, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-11-agent-wallet-recognition-design.md`

---

### Task 1: Hyperliquid agent API layer

**Goal:** Add `userRole`/`extraAgents` clients, an agent→master resolver, and an extraAgents normalizer to `hyperliquid.js`, all unit-tested via injected `fetchImpl`.

**Files:**
- Modify: `hyperliquid.js` (append after `getUserFills`, ~line 102)
- Test: `test/hyperliquid.test.js` (append)

**Acceptance Criteria:**
- [ ] `getUserRole`/`getExtraAgents` POST the correct `info` body.
- [ ] `resolveAccountAddress` returns the master for `role:"agent"`, passes through other roles, and falls back to the entered address on malformed data or API failure.
- [ ] `normalizeExtraAgents` flags expired agents and drops rows with an invalid address.

**Verify:** `npm test` → all tests pass (new agent tests included).

**Steps:**

- [ ] **Step 1: Write the failing tests** — append to `test/hyperliquid.test.js`

Update the import on line 3 to include the new names, then add the tests:

```js
// line 3 becomes:
import { isValidAddress, normalizeAccount, normalizeFills, parseNum, fetchInfo,
  getUserRole, getExtraAgents, resolveAccountAddress, normalizeExtraAgents } from '../hyperliquid.js';
```

```js
const MASTER = '0x' + '1'.repeat(40);
const AGENT = '0x' + '2'.repeat(40);
const okJson = (payload) => async () => ({ ok: true, json: async () => payload });

test('getUserRole / getExtraAgents send correct request bodies', async () => {
  const bodies = [];
  const fakeFetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; };
  await getUserRole('0xabc', { fetchImpl: fakeFetch, apiUrl: 'http://x' });
  await getExtraAgents('0xdef', { fetchImpl: fakeFetch, apiUrl: 'http://x' });
  assert.deepEqual(bodies[0], { type: 'userRole', user: '0xabc' });
  assert.deepEqual(bodies[1], { type: 'extraAgents', user: '0xdef' });
});

test('resolveAccountAddress redirects an agent to its master', async () => {
  const res = await resolveAccountAddress(AGENT, { fetchImpl: okJson({ role: 'agent', data: { user: MASTER } }), apiUrl: 'http://x' });
  assert.deepEqual(res, { address: MASTER, role: 'agent', viaAgent: AGENT });
});

test('resolveAccountAddress passes through non-agent roles', async () => {
  for (const role of ['user', 'vault', 'subAccount', 'missing']) {
    const res = await resolveAccountAddress(MASTER, { fetchImpl: okJson({ role }), apiUrl: 'http://x' });
    assert.deepEqual(res, { address: MASTER, role, viaAgent: null });
  }
});

test('resolveAccountAddress falls back on malformed agent data', async () => {
  const res = await resolveAccountAddress(AGENT, { fetchImpl: okJson({ role: 'agent', data: { user: 'not-an-address' } }), apiUrl: 'http://x' });
  assert.deepEqual(res, { address: AGENT, role: 'agent', viaAgent: null });
});

test('resolveAccountAddress falls back when userRole fails', async () => {
  const failFetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const res = await resolveAccountAddress(AGENT, { fetchImpl: failFetch, apiUrl: 'http://x' });
  assert.deepEqual(res, { address: AGENT, role: 'unknown', viaAgent: null });
});

test('normalizeExtraAgents flags expired and drops malformed', () => {
  const now = 1000;
  const out = normalizeExtraAgents([
    { name: 'Live', address: '0x' + 'a'.repeat(40), validUntil: 2000 },
    { name: 'Dead', address: '0x' + 'b'.repeat(40), validUntil: 500 },
    { name: 'Bad', address: '0xnope', validUntil: 2000 },
    { name: 'NoExpiry', address: '0x' + 'c'.repeat(40), validUntil: null },
  ], now);
  assert.equal(out.length, 3);
  assert.equal(out[0].expired, false);
  assert.equal(out[1].expired, true);
  assert.equal(out[2].name, 'NoExpiry');
  assert.equal(out[2].expired, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `getUserRole`/`getExtraAgents`/`resolveAccountAddress`/`normalizeExtraAgents` are not exported (import error / not a function).

- [ ] **Step 3: Implement** — append to `hyperliquid.js` after line 102 (`getUserFills`)

```js
export function getUserRole(address, opts) {
  return fetchInfo({ type: 'userRole', user: address }, opts);
}
export function getExtraAgents(address, opts) {
  return fetchInfo({ type: 'extraAgents', user: address }, opts);
}

// Resolve an entered address to the canonical fund-holding account.
// Only agent wallets are redirected (they hold no funds); user/vault/subAccount
// are used as entered. Any failure falls back to the entered address.
export async function resolveAccountAddress(address, opts) {
  let role;
  try {
    role = await getUserRole(address, opts);
  } catch {
    return { address, role: 'unknown', viaAgent: null };
  }
  const r = role?.role ?? 'unknown';
  const master = role?.data?.user;
  if (r === 'agent' && isValidAddress(master)) {
    return { address: master.toLowerCase(), role: 'agent', viaAgent: address };
  }
  return { address, role: r, viaAgent: null };
}

// extraAgents -> [{ name, address, validUntil, expired }], dropping malformed rows.
export function normalizeExtraAgents(agents, now = Date.now()) {
  const arr = Array.isArray(agents) ? agents : [];
  return arr
    .filter((a) => isValidAddress(a?.address))
    .map((a) => {
      const validUntil = parseNum(a.validUntil);
      return {
        name: a.name ?? null,
        address: a.address.toLowerCase(),
        validUntil,
        expired: validUntil != null && validUntil < now,
      };
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add hyperliquid.js test/hyperliquid.test.js
git commit -m "feat: add HL userRole/extraAgents client, agent->master resolver, agent normalizer"
```

---

### Task 2: DB `via_agent` column + migration

**Goal:** Persist the agent address an account was reached through, with an idempotent migration for existing databases.

**Files:**
- Modify: `db.js` (SCHEMA ~lines 6-11; migration after `db.exec(SCHEMA)` ~line 41; `upsertWallet` stmt lines 44-50; `listWallets` stmt line 51; `upsertWallet` method lines 72-74)
- Test: `test/db.test.js` (append)

**Acceptance Criteria:**
- [ ] Fresh DBs include a `via_agent` column; pre-existing DBs gain it via `ALTER TABLE` without data loss.
- [ ] `upsertWallet(address, label, viaAgent)` stores `via_agent` and preserves it on a later null upsert.
- [ ] `listWallets()` returns `via_agent`.

**Verify:** `npm test` → all tests pass.

**Steps:**

- [ ] **Step 1: Write the failing tests** — append to `test/db.test.js`

```js
test('wallets carry via_agent and preserve it on null upsert', () => {
  const db = freshDb();
  db.upsertWallet('0xmaster', 'main', '0xagent');
  let rows = db.listWallets();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].via_agent, '0xagent');
  // a later upsert without an agent (e.g. per-load refresh) must not wipe it
  db.upsertWallet('0xmaster');
  rows = db.listWallets();
  assert.equal(rows[0].via_agent, '0xagent');
});

test('migration adds via_agent to a pre-existing wallets table', async () => {
  const Database = (await import('better-sqlite3')).default;
  const os = await import('node:os');
  const path = await import('node:path');
  const p = path.join(os.tmpdir(), `hl-migrate-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  // create an OLD-schema wallets table (no via_agent), then close
  const old = new Database(p);
  old.exec(`CREATE TABLE wallets (address TEXT PRIMARY KEY, label TEXT, added_at INTEGER NOT NULL, last_viewed_at INTEGER)`);
  old.prepare(`INSERT INTO wallets (address, label, added_at, last_viewed_at) VALUES (?,?,?,?)`).run('0xold', 'legacy', 1, 1);
  old.close();
  // reopen via openDb -> migration should add the column and preserve the row
  const db = openDb(p);
  const rows = db.listWallets();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].address, '0xold');
  assert.equal(rows[0].via_agent, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `upsertWallet` ignores the 3rd arg / `via_agent` is undefined; migration test fails because `openDb` doesn't add the column.

- [ ] **Step 3: Implement** — edit `db.js`

Add `via_agent TEXT` to the `wallets` table in `SCHEMA` (so fresh DBs have it):

```sql
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  label TEXT,
  via_agent TEXT,
  added_at INTEGER NOT NULL,
  last_viewed_at INTEGER
);
```

After `db.exec(SCHEMA);` (line 41), add the idempotent migration for existing DBs:

```js
  db.exec(SCHEMA);

  // Migration: add wallets.via_agent to DBs created before agent-wallet support.
  const walletCols = db.prepare(`PRAGMA table_info(wallets)`).all();
  if (!walletCols.some((c) => c.name === 'via_agent')) {
    db.exec(`ALTER TABLE wallets ADD COLUMN via_agent TEXT`);
  }
```

Update the `upsertWallet` prepared statement (lines 44-50) to write + preserve `via_agent`:

```js
    upsertWallet: db.prepare(`
      INSERT INTO wallets (address, label, via_agent, added_at, last_viewed_at)
      VALUES (@address, @label, @viaAgent, @now, @now)
      ON CONFLICT(address) DO UPDATE SET
        label = COALESCE(excluded.label, wallets.label),
        via_agent = COALESCE(excluded.via_agent, wallets.via_agent),
        last_viewed_at = excluded.last_viewed_at
    `),
```

Update the `listWallets` statement (line 51) to select `via_agent`:

```js
    listWallets: db.prepare(`SELECT address, label, via_agent, added_at, last_viewed_at FROM wallets ORDER BY last_viewed_at DESC NULLS LAST, added_at DESC`),
```

Update the `upsertWallet` method (lines 72-74) to accept and bind `viaAgent`:

```js
    upsertWallet(address, label = null, viaAgent = null) {
      stmts.upsertWallet.run({ address, label, viaAgent, now: Date.now() });
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (existing wallet/fills/snapshot tests + the two new ones).

- [ ] **Step 5: Commit**

```bash
git add db.js test/db.test.js
git commit -m "feat: persist wallet via_agent with idempotent migration"
```

---

### Task 3: Server routes + testability seam

**Goal:** `POST /api/wallets` resolves the entered address before saving and returns the resolution; add `GET /api/agents/:address`. Add a `fetchImpl` override seam to `createApp` so routes are testable offline.

**Files:**
- Modify: `server.js` (import line 4; `createApp` signature + `opts` lines 9-13; `POST /api/wallets` lines 39-45; add new route near line 51)
- Test: `test/server.test.js` (create)

**Acceptance Criteria:**
- [ ] `createApp(db, { fetchImpl })` threads `fetchImpl` into `opts`; `createApp(db)` is unchanged in production.
- [ ] `POST /api/wallets` with an agent address saves the master and returns `resolved:{entered, address, role, viaAgent}`.
- [ ] `GET /api/agents/:address` returns `{address, agents:[normalized]}`; invalid address → 400; HL failure → 502.

**Verify:** `npm test` → all tests pass (new `server.test.js` included).

**Steps:**

- [ ] **Step 1: Write the failing tests** — create `test/server.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

function fakeDb() {
  const wallets = [];
  return {
    upsertWallet(address, label = null, viaAgent = null) {
      const existing = wallets.find((w) => w.address === address);
      if (existing) { if (label != null) existing.label = label; if (viaAgent != null) existing.via_agent = viaAgent; }
      else wallets.push({ address, label, via_agent: viaAgent });
    },
    listWallets() { return wallets; },
    removeWallet() {}, ingestFills() {}, cumulativeRealized() { return 0; },
    getHistory() { return []; }, insertSnapshotThrottled() { return false; },
  };
}

async function withServer(overrides, fn) {
  const server = createApp(fakeDb(), overrides).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.close(); }
}

const MASTER = '0x' + '1'.repeat(40);
const AGENT = '0x' + '2'.repeat(40);

test('POST /api/wallets resolves an agent wallet to its master', async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.type === 'userRole') return { ok: true, json: async () => ({ role: 'agent', data: { user: MASTER } }) };
    throw new Error('unexpected ' + body.type);
  };
  await withServer({ fetchImpl }, async (base) => {
    const res = await fetch(`${base}/api/wallets`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: AGENT }),
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.resolved.entered, AGENT);
    assert.equal(json.resolved.address, MASTER);
    assert.equal(json.resolved.viaAgent, AGENT);
    assert.equal(json.wallets[0].address, MASTER);
    assert.equal(json.wallets[0].via_agent, AGENT);
  });
});

test('GET /api/agents returns normalized connected agents', async () => {
  const ACC = '0x' + '3'.repeat(40);
  const A1 = '0x' + 'a'.repeat(40);
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.type === 'extraAgents') return { ok: true, json: async () => ([{ name: 'Bot', address: A1, validUntil: 9999999999999 }]) };
    throw new Error('unexpected ' + body.type);
  };
  await withServer({ fetchImpl }, async (base) => {
    const res = await fetch(`${base}/api/agents/${ACC}`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.agents.length, 1);
    assert.equal(json.agents[0].name, 'Bot');
    assert.equal(json.agents[0].expired, false);
  });
});

test('GET /api/agents rejects an invalid address', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/agents/nope`);
    assert.equal(res.status, 400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `createApp` ignores `overrides` (real `fetch` would be called / route missing), `GET /api/agents` returns 404, `resolved` absent from POST response.

- [ ] **Step 3: Implement** — edit `server.js`

Update the import (line 4):

```js
import { isValidAddress, resolveAccountAddress, getExtraAgents, normalizeExtraAgents } from './hyperliquid.js';
```

Add the `overrides` param and thread it into `opts` (lines 9-13):

```js
export function createApp(db, overrides = {}) {
  const app = express();
  app.use(express.json());

  const opts = { apiUrl: config.hlApiUrl, snapshotMinIntervalMs: config.snapshotMinIntervalMs, ...overrides };
```

Replace `POST /api/wallets` (lines 39-45) with the resolving version:

```js
  app.post('/api/wallets', async (req, res) => {
    const entered = String(req.body?.address || '').toLowerCase();
    const label = req.body?.label ? String(req.body.label).slice(0, 60) : null;
    if (!isValidAddress(entered)) return res.status(400).json({ error: 'Invalid wallet address.' });
    const resolved = await resolveAccountAddress(entered, opts);
    db.upsertWallet(resolved.address, label, resolved.viaAgent);
    res.json({ wallets: db.listWallets(), resolved: { entered, ...resolved } });
  });
```

Add the new route after the `DELETE /api/wallets/:address` route (after line 51), before `app.use(express.static('public'))`:

```js
  app.get('/api/agents/:address', async (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    try {
      const agents = normalizeExtraAgents(await getExtraAgents(address, opts));
      res.json({ address, agents });
    } catch (err) {
      res.status(502).json({ error: `Failed to load connected agents: ${err.message}` });
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all suites including `server.test.js`).

- [ ] **Step 5: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat: resolve agent wallets in POST /api/wallets, add GET /api/agents"
```

---

### Task 4: Frontend resolution badge + connected-agents panel

**Goal:** Select the resolved master after adding a wallet, show a badge when viewing a via-agent wallet, and render a connected-agents panel for the selected account.

**Files:**
- Modify: `public/index.html` (add `#walletBadge` in `<main>` ~line 23; add agents panel after the Open Positions section ~line 53)
- Modify: `public/styles.css` (append badge + agent styles)
- Modify: `public/app.js` (helpers ~lines 1-6; `loadWallets` 115-124; `selectAddress` 126-130; `addBtn` handler 143-149)

**Acceptance Criteria:**
- [ ] Adding an agent address selects the resolved master and shows the badge.
- [ ] Selecting a via-agent wallet shows the badge; a normal wallet hides it.
- [ ] The connected-agents panel lists agents (name, short address, valid-until, expired marker), with empty and soft-error states.
- [ ] Agent names are HTML-escaped.

**Verify:** Manual — `npm start`, open <http://localhost:3000>:
1. Add `0x2ba553d9f990a3b66b03b2dc0d030dfc1c061036` → the **Connected Agent Wallets** panel lists at least one agent (live HL example with an "Mobile QR" agent).
2. Add an account with no agents → panel shows "No agent wallets connected."
3. Adding a known agent wallet selects a different (master) address and shows the badge.

**Steps:**

- [ ] **Step 1: Add markup** — `public/index.html`

Insert a badge as the first child of `<main>` (before `<section class="cards" ...>` on line 23):

```html
  <main>
    <div id="walletBadge" class="wallet-badge hidden"></div>
```

Add a connected-agents panel immediately after the Open Positions `</section>` (after line 53), before `<div id="loading" ...>`:

```html
    <section class="panel">
      <h2>Connected Agent Wallets</h2>
      <div id="agentsPanel" class="agents"></div>
    </section>
```

- [ ] **Step 2: Add styles** — append to `public/styles.css`

```css
.wallet-badge{margin:0 0 14px;padding:8px 12px;border-radius:10px;border:1px solid rgba(108,140,255,.4);
  background:rgba(108,140,255,.08);color:var(--accent);font-size:12px}
.wallet-badge code{color:var(--text)}
.agents{display:flex;flex-direction:column;gap:8px}
.agent-row{display:flex;justify-content:space-between;gap:12px;align-items:center;
  padding:8px 12px;border:1px solid var(--line);border-radius:10px;font-size:13px}
.agent-row .agent-name{font-weight:600}
.agent-row .agent-meta{color:var(--muted);font-size:12px}
.agent-row.expired{opacity:.55}
.agent-badge-expired{color:var(--neg);margin-left:6px}
.agents-empty{color:var(--muted);font-size:13px}
```

- [ ] **Step 3: Update client logic** — `public/app.js`

Add `short` + `esc` helpers and a `walletMeta` field. Replace lines 1-6:

```js
const $ = (id) => document.getElementById(id);
const fmtUsd = (n) => n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtNum = (n, d = 4) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
const cls = (n) => n == null ? '' : n > 0 ? 'pos' : n < 0 ? 'neg' : '';
const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = { address: null, ws: null, pollTimer: null, series: 'equity', history: [], wsConnected: false, walletMeta: {} };
```

Add the badge + agents renderers (place after `renderAccount`, ~after line 47):

```js
function renderWalletBadge(address) {
  const meta = state.walletMeta[address];
  const el = $('walletBadge');
  if (meta && meta.viaAgent) {
    el.innerHTML = `Agent wallet <code>${short(meta.viaAgent)}</code> → showing master <code>${short(address)}</code>`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

async function loadAgents(address) {
  const panel = $('agentsPanel');
  panel.innerHTML = '';
  try {
    const { agents } = await api(`/api/agents/${address}`);
    if (!agents.length) { panel.innerHTML = '<div class="agents-empty">No agent wallets connected.</div>'; return; }
    for (const a of agents) {
      const row = document.createElement('div');
      row.className = 'agent-row' + (a.expired ? ' expired' : '');
      const validTxt = a.validUntil ? new Date(a.validUntil).toLocaleDateString() : '—';
      const expiredTxt = a.expired ? ' <span class="agent-badge-expired">expired</span>' : '';
      row.innerHTML = `<span class="agent-name">${esc(a.name || 'Agent')}</span>
        <span class="agent-meta">${short(a.address)} · valid until ${validTxt}${expiredTxt}</span>`;
      panel.appendChild(row);
    }
  } catch {
    panel.innerHTML = '<div class="agents-empty">Couldn’t load connected agents.</div>';
  }
}
```

Replace `loadWallets` (lines 115-124) to record metadata:

```js
async function loadWallets(selected) {
  const { wallets } = await api('/api/wallets');
  state.walletMeta = {};
  const sel = $('walletSelect'); sel.innerHTML = '';
  for (const w of wallets) {
    state.walletMeta[w.address] = { label: w.label, viaAgent: w.via_agent };
    const o = document.createElement('option'); o.value = w.address;
    o.textContent = w.label ? `${w.label} (${w.address.slice(0, 6)}…)` : `${w.address.slice(0, 10)}…${w.address.slice(-4)}`;
    sel.appendChild(o);
  }
  if (selected) sel.value = selected;
}
```

Replace `selectAddress` (lines 126-130) to render the badge + agents:

```js
async function selectAddress(address) {
  state.address = address; state.history = [];
  renderWalletBadge(address);
  await refresh(true);
  await loadAgents(address);
  if (state.wsConnected) state.ws.send(JSON.stringify({ type: 'watch', address }));
}
```

Replace the `addBtn` handler (lines 143-149) to select the resolved master:

```js
  $('addBtn').addEventListener('click', async () => {
    const address = $('walletInput').value.trim().toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { showError('Invalid wallet address.'); return; }
    try {
      const { resolved } = await api('/api/wallets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) });
      $('walletInput').value = '';
      const canonical = resolved?.address || address;
      await loadWallets(canonical);
      await selectAddress(canonical);
    } catch (e) { showError(e.message); }
  });
```

- [ ] **Step 4: Verify manually**

Run: `npm start`, then perform the three checks in the **Verify** section above. Confirm the badge appears only for via-agent wallets and the panel renders/empties/soft-fails correctly.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/styles.css public/app.js
git commit -m "feat: show agent->master badge and connected-agents panel in UI"
```

---

### Task 5: README documentation

**Goal:** Document agent-wallet recognition (resolution + connected-agents panel) and the new endpoints.

**Files:**
- Modify: `README.md` (Features list ~line 25; "Hyperliquid endpoints used" ~lines 93-103; add a "Limitations" bullet ~line 129)

**Acceptance Criteria:**
- [ ] README explains pasting an agent/API wallet resolves to the master, and describes the connected-agents panel.
- [ ] The two new `info` request types are listed under endpoints.

**Verify:** `git diff README.md` shows the three additions; prose reads cleanly.

**Steps:**

- [ ] **Step 1: Add a Features bullet** — after the "Watched wallets" bullet (line 25)

```markdown
- **Agent wallet recognition** — paste a Hyperliquid agent (API) wallet address and
  it automatically resolves to the master account it signs for (agent wallets hold
  no funds), with a badge showing the relationship. A **Connected Agent Wallets**
  panel lists the agents authorized on the viewed account (name, address, expiry).
```

- [ ] **Step 2: Extend "Hyperliquid endpoints used"** — add two bullets under the REST list (after line 100)

```markdown
  - `{ "type": "userRole", "user": "0x…" }` — detects whether an address is an
    agent wallet and, if so, returns its master account (used to resolve agent
    addresses on entry).
  - `{ "type": "extraAgents", "user": "0x…" }` — the agent/API wallets approved on
    an account (name, address, valid-until), shown in the Connected Agent Wallets panel.
```

- [ ] **Step 3: Add a Limitations bullet** — after the snapshots bullet (line 128)

```markdown
- **Agent wallets resolve to the master account** and have no separate PnL — all
  trading through an agent accrues to the master. The dashboard never approves,
  revokes, or names agents (read-only); it only reads the `userRole`/`extraAgents`
  relationships.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document agent wallet recognition and new endpoints"
```

---

## Notes

- **WS / stream and `/api/account` are intentionally untouched.** The browser only
  ever sends master addresses (from the saved list), so live subscriptions and DB
  keying stay consistent without per-request resolution.
- **Only `role:"agent"` redirects.** Vaults and sub-accounts hold their own funds
  and return their own `clearinghouseState`, so they're used as entered.
- **Test boundary:** `server.test.js` spins up `app.listen(0)` with an injected
  `fetchImpl` (no network). Frontend has no test runner in this project, so Task 4
  is verified manually, consistent with the existing codebase.
