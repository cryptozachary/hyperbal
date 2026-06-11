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
export function getClearinghouseState(address, opts, dex) {
  const body = { type: 'clearinghouseState', user: address };
  if (dex) body.dex = dex;
  return fetchInfo(body, opts);
}
export function getUserFills(address, opts) {
  return fetchInfo({ type: 'userFills', user: address }, opts);
}

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
  address = address.toLowerCase();
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
      // validUntil is a Unix millisecond timestamp (compared against Date.now()).
      const validUntil = parseNum(a.validUntil);
      return {
        name: a.name ?? null,
        address: a.address.toLowerCase(),
        validUntil,
        expired: validUntil != null && validUntil < now,
      };
    });
}

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
