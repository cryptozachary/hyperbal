import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { _resetDexCaches } from '../hyperliquid.js';

function fakeDb(fills = []) {
  const wallets = [];
  // Mirrors SQL `closed_pnl != 0`, which excludes NULL under three-valued logic.
  const match = (f, closesOnly) => !closesOnly || (f.closed_pnl != null && f.closed_pnl !== 0);
  return {
    upsertWallet(address, label = null, viaAgent = null) {
      const existing = wallets.find((w) => w.address === address);
      if (existing) { if (label != null) existing.label = label; if (viaAgent != null) existing.via_agent = viaAgent; }
      else wallets.push({ address, label, via_agent: viaAgent });
    },
    listWallets() { return wallets; },
    hasWallet(address) { return wallets.some((w) => w.address === address); },
    touchWallet() {},
    deleteWallet(address) { const i = wallets.findIndex((w) => w.address === address); if (i >= 0) wallets.splice(i, 1); },
    ingestFills() {}, cumulativeRealized() { return 0; },
    ingestFunding() { return 0; }, listFunding() { return []; },
    backfillFills() { return { scanned: 0, inserted: 0, enriched: 0 }; },
    getHistory() { return []; }, insertSnapshotThrottled() { return false; },
    listFills(address, { limit = 50, offset = 0, closesOnly = false } = {}) {
      return fills.filter((f) => match(f, closesOnly))
        .sort((a, b) => b.ts - a.ts || b.tid - a.tid)
        .slice(offset, offset + limit);
    },
    countFills(_address, { closesOnly = false } = {}) {
      return fills.filter((f) => match(f, closesOnly)).length;
    },
    listFillsRange(_address, from = 0, to = Number.MAX_SAFE_INTEGER) {
      return fills.filter((f) => f.ts >= from && f.ts < to).sort((a, b) => a.ts - b.ts);
    },
    getRange() {
      if (!fills.length) return { minTs: null, maxTs: null };
      return { minTs: Math.min(...fills.map((f) => f.ts)), maxTs: Math.max(...fills.map((f) => f.ts)) };
    },
    // --- alerts ---
    alerts: [],
    createAlert(rule) {
      const row = { id: this.alerts.length + 1, enabled: 1, last_state: null,
        last_attempt_at: null, last_fired_at: null, created_at: 1, ...rule };
      this.alerts.push(row);
      return row;
    },
    listAlerts(address) { return this.alerts.filter((a) => a.address === address); },
    listEnabledAlerts(address) { return this.alerts.filter((a) => a.address === address && a.enabled); },
    alertAddresses() { return [...new Set(this.alerts.filter((a) => a.enabled).map((a) => a.address))]; },
    updateAlert(id, patch) {
      const row = this.alerts.find((a) => a.id === id);
      if (!row) return null;
      if (patch.enabled != null) row.enabled = patch.enabled ? 1 : 0;
      if (patch.threshold != null) row.threshold = Number(patch.threshold);
      row.last_state = null;
      return row;
    },
    deleteAlert(id) {
      const i = this.alerts.findIndex((a) => a.id === id);
      if (i < 0) return false;
      this.alerts.splice(i, 1);
      return true;
    },
    saveAlertResult() {},
  };
}

async function withServer(overrides, fn, fills = []) {
  const server = createApp(fakeDb(fills), overrides).listen(0);
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
    assert.equal(json.resolved.role, 'agent');
    assert.equal(json.resolved.viaAgent, AGENT);
    assert.equal(json.wallets[0].address, MASTER);
    assert.equal(json.wallets[0].via_agent, AGENT);
  });
});

test('POST /api/wallets rejects an invalid address', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/wallets`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: 'nope' }),
    });
    assert.equal(res.status, 400);
  });
});

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

test('GET /api/agents returns 502 when Hyperliquid fails', async () => {
  const ACC = '0x' + '4'.repeat(40);
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await withServer({ fetchImpl }, async (base) => {
    const res = await fetch(`${base}/api/agents/${ACC}`);
    assert.equal(res.status, 502);
  });
});

test('GET /api/account aggregates positions across main + builder dex', async () => {
  _resetDexCaches();
  const ACC = '0x' + '5'.repeat(40);
  const POS = (coin, szi) => ({ position: { coin, szi, entryPx: '90', positionValue: '100', unrealizedPnl: '1', returnOnEquity: '0.1', liquidationPx: '50', leverage: { type: 'cross', value: 5 }, marginUsed: '10' } });
  const fetchImpl = async (_url, init) => {
    const b = JSON.parse(init.body);
    if (b.type === 'perpDexs') return { ok: true, json: async () => ([null, { name: 'xyz', fullName: 'XYZ' }]) };
    if (b.type === 'spotMeta') return { ok: true, json: async () => ({ tokens: [{ index: 0, name: 'USDC' }] }) };
    if (b.type === 'meta') return { ok: true, json: async () => ({ collateralToken: 0 }) };
    if (b.type === 'clearinghouseState') {
      const cs = b.dex === 'xyz'
        ? { marginSummary: { accountValue: '583' }, assetPositions: [POS('xyz:SP500', '-0.753')] }
        : { marginSummary: { accountValue: '500' }, assetPositions: [POS('BTC', '1')] };
      return { ok: true, json: async () => cs };
    }
    if (b.type === 'userFills') return { ok: true, json: async () => ([]) };
    return { ok: true, json: async () => ({}) };
  };
  await withServer({ fetchImpl }, async (base) => {
    const res = await fetch(`${base}/api/account/${ACC}`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.equity, 1083);
    const sp = json.positions.find((p) => p.coin === 'xyz:SP500');
    assert.equal(sp.dex, 'xyz');
    assert.equal(sp.collateral, 'USDC');
  });
});

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

// The fakeDb double slices a JS array, which tolerates 1.5 and Infinity — only a
// real SQLite binding proves the clamp produces a usable integer.
test('GET /api/fills survives non-integer limit/offset against a real DB', async () => {
  const { openDb } = await import('../db.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const db = openDb(path.join(os.tmpdir(), `hl-route-${Date.now()}-${Math.random().toString(16).slice(2)}.db`));
  db.ingestFills(FILLS_ACC, SEED_FILLS);

  const server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/fills/${FILLS_ACC}`;
  try {
    for (const q of ['offset=1.5', 'offset=Infinity', 'offset=1e999', 'offset=1e20', 'limit=1.5', 'limit=2.5', 'limit=abc', 'limit=-3']) {
      const res = await fetch(`${base}?${q}`);
      const json = await res.json();
      assert.equal(res.status, 200, `${q} should not 500`);
      assert.ok(Number.isSafeInteger(json.limit), `${q} -> limit ${json.limit} must be a safe integer`);
      assert.ok(Number.isSafeInteger(json.offset), `${q} -> offset ${json.offset} must be a safe integer`);
      assert.ok(json.limit >= 1 && json.limit <= 200, `${q} -> limit ${json.limit} out of range`);
      assert.ok(json.offset >= 0, `${q} -> offset ${json.offset} negative`);
    }
    // repeated params arrive as an array; Number([]) is NaN -> defaults
    const rep = await (await fetch(`${base}?limit=1&limit=2`)).json();
    assert.equal(rep.limit, 50);
  } finally { server.close(); }
});

test('GET /api/export returns a detailed CSV download with a preamble', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/export/${FILLS_ACC}.csv?format=detailed&tz=UTC`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename=/);
    const lines = (await res.text()).split('\r\n');
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

test('GET /api/export applies a half-open from/to range', async () => {
  await withServer({}, async (base) => {
    // SEED_FILLS are at ts 10, 20, 30
    const body = await (await fetch(`${base}/api/export/${FILLS_ACC}.csv?format=koinly&tz=UTC&from=10&to=30`)).text();
    const dataRows = body.trim().split('\r\n').slice(1);
    assert.equal(dataRows.length, 2, 'to is exclusive, so ts=30 is out');
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

test('GET /api/range rejects an invalid address', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/api/range/nope`)).status, 400);
  });
});

// --- regressions from the backend review ---

test('GET /api/export survives an out-of-range from/to instead of 500ing', async () => {
  await withServer({}, async (base) => {
    for (const q of ['from=9000000000000000', 'from=1e30', 'to=-1e30']) {
      const res = await fetch(`${base}/api/export/${FILLS_ACC}.csv?format=detailed&tz=UTC&${q}`);
      assert.equal(res.status, 200, `${q} should not 500`);
      assert.match(res.headers.get('content-type'), /text\/csv/);
    }
  }, SEED_FILLS);
});

test('GET /api/export rejects a bogus timezone rather than silently using UTC', async () => {
  await withServer({}, async (base) => {
    const bad = await fetch(`${base}/api/export/${FILLS_ACC}.csv?format=detailed&tz=Not/AZone`);
    assert.equal(bad.status, 400);
    const injected = await fetch(`${base}/api/export/${FILLS_ACC}.csv?format=detailed&tz=${encodeURIComponent('UTC\r\nINJECTED,row,here')}`);
    assert.equal(injected.status, 400, 'a newline-bearing tz must not reach the preamble');
  }, SEED_FILLS);
});

test('POST /api/backfill accepts resume cursors and returns the next ones', async () => {
  const fetchImpl = async (_url, init) => {
    const b = JSON.parse(init.body);
    if (b.type === 'userRole') return { ok: true, json: async () => ({ role: 'user' }) };
    if (b.type === 'userFillsByTime' || b.type === 'userFunding') return { ok: true, json: async () => ([]) };
    return { ok: true, json: async () => ({}) };
  };
  await withServer({ fetchImpl }, async (base) => {
    await fetch(`${base}/api/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: MASTER }) });
    const res = await fetch(`${base}/api/backfill/${MASTER}?fillsFrom=5000&fundingFrom=6000`, { method: 'POST' });
    const json = await res.json();
    assert.equal(res.status, 200);
    // an empty first page leaves each cursor where it started, so a resume is a no-op
    assert.equal(json.fills.nextFrom, 5000);
    assert.equal(json.funding.nextFrom, 6000);
  });
});

test('backfill resolves an absent builderFee to 0, not to unknown', async () => {
  const { openDb } = await import('../db.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const db = openDb(path.join(os.tmpdir(), `hl-bfee-${Date.now()}-${Math.random().toString(16).slice(2)}.db`));
  const A = '0x' + '7'.repeat(40);
  db.upsertWallet(A, 'w');
  // a legacy row with builder_fee unknown
  db.ingestFills(A, [{ tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1, side: 'A', ts: 100 }]);

  // Hyperliquid returns this fill with NO builderFee — it never routed through a builder
  const fetchImpl = async (_url, init) => {
    const b = JSON.parse(init.body);
    if (b.type === 'userFillsByTime') {
      return { ok: true, json: async () => (b.startTime > 100 ? [] : [
        { tid: 1, coin: 'BTC', closedPnl: '5', fee: '0.1', px: '100', sz: '1',
          side: 'A', dir: 'Close Long', hash: '0xa', oid: 9, feeToken: 'USDC', time: 100 },
      ]) };
    }
    if (b.type === 'userFunding') return { ok: true, json: async () => ([]) };
    return { ok: true, json: async () => ({}) };
  };

  const server = createApp(db, { fetchImpl }).listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/backfill/${A}`, { method: 'POST' });
    const json = await res.json();
    assert.equal(res.status, 200);
    const row = db.raw.prepare('SELECT builder_fee FROM fills WHERE tid = 1').get();
    assert.equal(row.builder_fee, 0, 'an authoritative absence is 0, so it exports as 0 rather than blank');
    assert.equal(json.fills.enriched, 1, 'and the row counts as fully repaired');
  } finally { server.close(); }
});

// --- alerts ---

const ADDR = '0x' + '3'.repeat(40);

// POST /api/wallets requires a live userRole lookup; this stub answers it so the
// alert tests can get a wallet onto the watch list.
const roleFetch = async () => ({ ok: true, json: async () => ({ role: 'user' }) });

async function withWallet(fn, overrides = {}) {
  await withServer({ fetchImpl: roleFetch, ...overrides }, async (base) => {
    await fetch(`${base}/api/wallets`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: ADDR }),
    });
    return fn(base);
  });
}

const postAlert = (base, body) => fetch(`${base}/api/alerts`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const VALID = { address: ADDR, scope: 'account', metric: 'equity', operator: 'below', threshold: 5000 };

test('GET /api/alerts requires a valid address', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/api/alerts`)).status, 400);
    assert.equal((await fetch(`${base}/api/alerts?address=nope`)).status, 400);
  });
});

test('GET /api/alerts returns rules, the whitelist, and mail status', async () => {
  await withWallet(async (base) => {
    await postAlert(base, VALID);
    const res = await fetch(`${base}/api/alerts?address=${ADDR}`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.alerts.length, 1);
    assert.equal(json.alerts[0].metric, 'equity');
    // The UI builds its dropdowns from this, so it cannot drift from the server.
    assert.ok(json.metrics.account.equity);
    assert.ok(json.metrics.position.markPrice);
    assert.equal(json.emailConfigured, false);
  });
});

test('POST /api/alerts creates a rule', async () => {
  await withWallet(async (base) => {
    const res = await postAlert(base, VALID);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.alert.scope, 'account');
    assert.equal(json.alert.threshold, 5000);
    assert.equal(json.alert.coin, null);
  });
});

test('POST /api/alerts creates a position rule with its coin', async () => {
  await withWallet(async (base) => {
    const res = await postAlert(base, { ...VALID, scope: 'position', coin: 'BTC', metric: 'liquidationDistancePct', threshold: 5 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).alert.coin, 'BTC');
  });
});

test('POST /api/alerts rejects every malformed shape', async () => {
  await withWallet(async (base) => {
    const bad = [
      { ...VALID, address: 'nope' },
      { ...VALID, scope: 'galaxy' },
      { ...VALID, metric: 'nonsense' },
      { ...VALID, metric: 'markPrice' },                          // position metric, account scope
      { ...VALID, scope: 'position', metric: 'markPrice' },       // position scope, no coin
      { ...VALID, operator: 'equals' },
      { ...VALID, threshold: 'abc' },
      { ...VALID, threshold: Infinity },
    ];
    for (const body of bad) {
      const res = await postAlert(base, body);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.ok((await res.json()).error);
    }
  });
});

test('POST /api/alerts refuses a wallet that is not on the watch list', async () => {
  await withServer({}, async (base) => {
    const res = await postAlert(base, VALID);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /watch list/);
  });
});

test('PATCH /api/alerts/:id updates and validates', async () => {
  await withWallet(async (base) => {
    const { alert } = await (await postAlert(base, VALID)).json();
    const patch = (body) => fetch(`${base}/api/alerts/${alert.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    assert.equal((await (await patch({ threshold: 7000 })).json()).alert.threshold, 7000);
    assert.equal((await (await patch({ enabled: false })).json()).alert.enabled, 0);
    assert.equal((await patch({})).status, 400);              // nothing to update
    assert.equal((await patch({ threshold: 'abc' })).status, 400);

    const missing = await fetch(`${base}/api/alerts/9999`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threshold: 1 }),
    });
    assert.equal(missing.status, 404);
  });
});

test('resuming a paused alert re-establishes the stream subscription', async () => {
  const watched = [];
  const runner = { watch: (a) => watched.push(a), unwatch: () => {} };
  await withWallet(async (base) => {
    const { alert } = await (await postAlert(base, VALID)).json();
    watched.length = 0; // ignore the watch POST already did
    const patch = (body) => fetch(`${base}/api/alerts/${alert.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    await patch({ enabled: false });
    assert.deepEqual(watched, [], 'pausing does not watch');
    await patch({ enabled: true });
    assert.deepEqual(watched, [ADDR], 'resuming does');
  }, { runner });
});

test('DELETE /api/alerts/:id removes a rule', async () => {
  await withWallet(async (base) => {
    const { alert } = await (await postAlert(base, VALID)).json();
    assert.equal((await fetch(`${base}/api/alerts/${alert.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${base}/api/alerts/${alert.id}`, { method: 'DELETE' })).status, 404);
  });
});

test('POST /api/alerts/test reports unconfigured mail rather than pretending', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/alerts/test`, { method: 'POST' });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /not configured/i);
  });
});

test('POST /api/alerts/test sends through a configured notifier', async () => {
  const sent = [];
  const notifier = { configured: true, send: async (m) => { sent.push(m); return { sent: true }; } };
  await withServer({ notifier }, async (base) => {
    const res = await fetch(`${base}/api/alerts/test`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
  });
});
