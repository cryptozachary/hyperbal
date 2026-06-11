# Agent Wallet Recognition — Design Spec

**Date:** 2026-06-11
**Status:** Approved

## 1. Purpose

Make the dashboard understand Hyperliquid **agent wallets** (a.k.a. API wallets).
Agent wallets are permissioned signers that hold no funds and trade on behalf of
a **master account**. Querying account data (`clearinghouseState`, `userFills`)
for an agent address returns an empty result — so today, pasting an agent wallet
into the dashboard shows a blank/zero account.

This feature delivers two behaviors:

1. **Resolve agent → master.** When a user enters an agent wallet, detect it and
   transparently use the master account's address, with an explicit badge so the
   redirect is honest (consistent with the app's read-only transparency).
2. **List connected agents.** For the viewed account, show which agent/API
   wallets are authorized on it (name, address, expiry).

Agent wallets have **no separate PnL** — all trading accrues to the master — so
"recognition" means resolution + listing, never per-agent PnL.

## 2. Constraints

- Stay within the existing stack: Node 18+, Express, vanilla frontend,
  `better-sqlite3`, `ws`, `dotenv`. No new dependencies.
- **Read-only.** Both new Hyperliquid calls are public `info` POSTs; no private
  keys, no approving/revoking agents.
- Preserve the existing live pipeline: REST, browser WS, upstream stream, and DB
  all key off a single account address. The design must not introduce
  inconsistency between those paths.

## 3. Core Decision — Resolve at the Wallet-Entry Boundary

Resolution happens **once**, when a wallet is added/selected, producing a
canonical **master** address that the rest of the system uses unchanged. The
agent address is stored as metadata only.

Rationale (vs. resolving per-request or client-re-pointing): a single resolution
point means REST (`/api/account`, `/api/history`), the browser WS `watch` path,
the upstream `webData2`/`userFills` subscriptions, and DB snapshot/fill keying
all continue to operate on a master address with **zero changes**. Per-request
resolution would duplicate logic across REST + WS, add an API call per refresh,
and make DB keying ambiguous (history keyed by the agent address would be empty).

## 4. Data Flow

```
Add wallet 0xAGENT
  → POST /api/wallets
      → resolveAccountAddress(0xAGENT) → info {type:"userRole", user:0xAGENT}
          role "agent"  → save wallet {address: 0xMASTER, via_agent: 0xAGENT}
          role "user" | "vault" | "subAccount" | "missing"
                        → save wallet {address: as-entered, via_agent: null}
      → response { wallets, resolved: {entered, address, role, viaAgent} }
  → client selects 0xMASTER for REST account/history + WS watch
  → client shows one-time resolution notice; persistent badge if via_agent set

Select any wallet
  → GET /api/agents/:address → info {type:"extraAgents", user} → agents panel
```

**Only `role:"agent"` redirects.** Vaults and sub-accounts hold their own funds
and have their own `clearinghouseState`, so they are used as entered.

## 5. Hyperliquid API Usage (new)

Both are `POST {HL_API_URL}` `info` calls, same client (`fetchInfo`) as today.

- `{type:"userRole", user}` → role of an address:
  - `{"role":"user"}`
  - `{"role":"agent", "data":{"user":"0x<master>"}}`
  - `{"role":"vault"}`
  - `{"role":"subAccount", "data":{"master":"0x<master>"}}`
  - `{"role":"missing"}`
- `{type:"extraAgents", user}` → array of agents approved on the (master)
  account: `[{ "name": string, "address": "0x…", "validUntil": <unix ms> }]`.

## 6. Modules & Changes

### `hyperliquid.js` (new functions; same module style)

- `getUserRole(address, opts)` → `fetchInfo({type:"userRole", user: address}, opts)`.
- `getExtraAgents(address, opts)` → `fetchInfo({type:"extraAgents", user: address}, opts)`.
- `resolveAccountAddress(address, opts)` → `{ address, role, viaAgent }`:
  - Calls `getUserRole`. If `role === "agent"` and `data.user` is a valid
    address → `{ address: data.user.toLowerCase(), role: "agent", viaAgent: address }`.
  - Any other role, or malformed `data.user` → `{ address, role: <role|"unknown">, viaAgent: null }` (passthrough).
  - **On API error → graceful fallback** `{ address, role: "unknown", viaAgent: null }`.
    Adding a wallet must never hard-fail because resolution failed.
- `normalizeExtraAgents(arr, now = Date.now())` → `[{ name, address, validUntil, expired }]`
  where `expired = validUntil != null && validUntil < now`; rows with an invalid
  `address` are dropped.

### `db.js` (one nullable column + idempotent migration)

- After `db.exec(SCHEMA)`, run a lightweight migration: read
  `PRAGMA table_info(wallets)`; if no `via_agent` column,
  `ALTER TABLE wallets ADD COLUMN via_agent TEXT`. (Plain `CREATE TABLE IF NOT
  EXISTS` can't add columns to an existing table, so the ALTER is required for
  upgrades.)
- `upsertWallet(address, label = null, viaAgent = null)` — set
  `via_agent = COALESCE(excluded.via_agent, wallets.via_agent)` (same
  preserve-on-null pattern as `label`, so the per-load `upsertWallet(address)`
  call in `account.js` never wipes a stored agent).
- `listWallets()` includes `via_agent` in its `SELECT`.

### `server.js` (routes)

- `POST /api/wallets`: validate entered address → `resolveAccountAddress` →
  `upsertWallet(resolved.address, label, resolved.viaAgent)` → respond
  `{ wallets: db.listWallets(), resolved: { entered, address, role, viaAgent } }`.
  `resolveAccountAddress` is called with `opts` (same `apiUrl` used elsewhere).
- `GET /api/agents/:address` (new): validate → `getExtraAgents` →
  `normalizeExtraAgents` → `{ address, agents }`. HL failure → `502` with a clear
  message (frontend treats it as a non-blocking note).
- `GET /api/account/:address`: **unchanged** — no per-request resolution; it
  trusts that the address is already canonical (guaranteed by the entry path).

### WS / stream

**No changes.** The browser always sends master addresses from the saved list,
so `watch`/`track`, the upstream `webData2`/`userFills` subscriptions, and DB
keying remain consistent.

### Frontend (`public/`)

- `app.js`
  - `addBtn` handler: after `POST /api/wallets`, use `resolved` to `loadWallets`,
    select `resolved.address`, and — if `resolved.viaAgent` — show a one-time
    notice (e.g., "Agent 0x… → showing master 0x…").
  - `loadWallets`: keep a client-side `address → { label, via_agent }` map so
    `selectAddress` can render a small **persistent badge** near the header when
    the selected wallet has a `via_agent`.
  - `selectAddress`: also `GET /api/agents/:address` and render the
    connected-agents panel.
- `index.html`: add `#walletBadge` (near the wallet selector/header) and an
  `#agentsPanel` section below the positions table.
- `styles.css`: badge, agent-row, and expired-agent styles.

Connected-agents panel renders name, shortened address, valid-until date, with
expired rows visually de-emphasized; shows "No agent wallets connected" when the
list is empty and a soft "Couldn't load connected agents" note on API failure.

## 7. Error Handling

- `userRole` failure during add → fall back to saving the entered address as-is;
  the dashboard still works (optional soft notice via `resolved.role === "unknown"`).
- `extraAgents` failure → panel-only soft note; the rest of the dashboard is
  unaffected.
- Malformed `data.user` from `userRole` → treated as passthrough (no redirect).
- `role:"missing"` (address never traded on HL) → used as-is; renders the normal
  empty-account state, which is correct.
- Canonical master from `userRole` is validated with `isValidAddress` before use.

## 8. Testing

- `test/hyperliquid.test.js`:
  - `getUserRole` / `getExtraAgents` send the correct request body (assert via
    injected `fetchImpl`).
  - `resolveAccountAddress`: agent → master; passthrough for `user`/`vault`/
    `subAccount`/`missing`; malformed `data.user` fallback; fetch-error fallback.
  - `normalizeExtraAgents`: `expired` flag computed correctly; malformed rows
    filtered.
- `test/db.test.js`:
  - Migration adds `via_agent` to a pre-existing DB without it.
  - `upsertWallet` stores `via_agent` and preserves it on a later null upsert.
  - `listWallets` returns `via_agent`.
- README: document that pasting an agent/API wallet resolves to the master, and
  describe the connected-agents panel.

## 9. Out of Scope (YAGNI)

- No per-request resolution in `/api/account`.
- No approving, revoking, or naming agents (read-only).
- No resolution caching layer (resolution is once-per-add; roles change rarely).
- No per-agent PnL (agents have none).

## 10. Acceptance Criteria

- Adding an agent wallet address saves the **master** address; the dashboard
  shows the master's equity/PnL/positions and a badge indicating it was reached
  via an agent.
- Adding a normal account, vault, or sub-account address behaves exactly as
  today (no redirect).
- Selecting any account shows a connected-agents panel listing approved agents
  (name, address, valid-until), with expired agents marked; empty and error
  states render cleanly.
- `userRole` / `extraAgents` API failures never break adding or viewing a
  wallet — they degrade to soft fallbacks.
- DB gains a `via_agent` column on upgrade without data loss; existing snapshots,
  fills, and wallets are preserved.
- New unit tests for `resolveAccountAddress`, `normalizeExtraAgents`, the two
  request bodies, and the DB migration pass.
