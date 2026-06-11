import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { _resetDexCaches } from '../hyperliquid.js';

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
