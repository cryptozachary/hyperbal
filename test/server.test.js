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
