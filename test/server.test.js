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
