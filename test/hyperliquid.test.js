import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidAddress, normalizeAccount, normalizeFills, parseNum, fetchInfo,
  getUserRole, getExtraAgents, resolveAccountAddress, normalizeExtraAgents,
  getPerpDexs, getDexCollateral, mergeAccounts, _resetDexCaches } from '../hyperliquid.js';

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

test('normalizeFills carries dir and tolerates its absence', () => {
  const { rows } = normalizeFills([
    { tid: 1, coin: 'BTC', closedPnl: '5', fee: '0.1', px: '100', sz: '1', side: 'A', dir: 'Close Long', time: 10 },
    { tid: 2, coin: 'ETH', closedPnl: '0', fee: '0.1', px: '50', sz: '2', side: 'B', time: 20 },
  ]);
  assert.equal(rows[0].dir, 'Close Long');
  assert.equal(rows[1].dir, null);
});

test('normalizeFills carries builderFee, hash, oid and feeToken', () => {
  const { rows } = normalizeFills([
    { tid: 1, coin: 'BTC', closedPnl: '5', fee: '0.33', builderFee: '0.23', px: '100', sz: '1',
      side: 'A', dir: 'Close Long', hash: '0xabc', oid: 42, feeToken: 'USDC', time: 10 },
    { tid: 2, coin: 'ETH', closedPnl: '0', fee: '0.1', px: '50', sz: '2', side: 'B', time: 20 },
  ]);
  assert.equal(rows[0].builder_fee, 0.23);
  assert.equal(rows[0].hash, '0xabc');
  assert.equal(rows[0].oid, 42);
  assert.equal(rows[0].fee_token, 'USDC');
  // absent builderFee means no builder took a cut, which is 0 — not unknown
  assert.equal(rows[1].builder_fee, 0);
  assert.equal(rows[1].hash, null);
  assert.equal(rows[1].oid, null);
  assert.equal(rows[1].fee_token, null);
});

test('fetchInfo throws on non-ok', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(() => fetchInfo({ type: 'x' }, { fetchImpl: fakeFetch, apiUrl: 'http://x' }), /Hyperliquid API error 500/);
});

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

test('resolveAccountAddress lowercases the resolved master', async () => {
  const upperMaster = '0x' + 'A'.repeat(40);
  const res = await resolveAccountAddress(AGENT, { fetchImpl: okJson({ role: 'agent', data: { user: upperMaster } }), apiUrl: 'http://x' });
  assert.equal(res.address, '0x' + 'a'.repeat(40));
  assert.equal(res.viaAgent, AGENT);
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

test('normalizeExtraAgents treats validUntil=0 as a real (expired) timestamp', () => {
  const out = normalizeExtraAgents([{ name: 'Epoch', address: '0x' + 'd'.repeat(40), validUntil: 0 }], 1000);
  assert.equal(out.length, 1);
  assert.equal(out[0].validUntil, 0);
  assert.equal(out[0].expired, true);
});

test('getPerpDexs normalizes (main first) and caches within TTL', async () => {
  _resetDexCaches();
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ([null, { name: 'xyz', fullName: 'XYZ' }, { name: 'flx', fullName: 'Felix' }]) }; };
  const a = await getPerpDexs({ fetchImpl, apiUrl: 'http://x' });
  assert.deepEqual(a, [{ name: null, fullName: 'Main' }, { name: 'xyz', fullName: 'XYZ' }, { name: 'flx', fullName: 'Felix' }]);
  await getPerpDexs({ fetchImpl, apiUrl: 'http://x' });
  assert.equal(calls, 1); // second call served from cache
});

test('getPerpDexs degrades to main-only on failure and does NOT cache it', async () => {
  _resetDexCaches();
  let calls = 0, fail = true;
  const fetchImpl = async () => {
    calls++;
    if (fail) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, json: async () => ([null, { name: 'xyz', fullName: 'XYZ' }]) };
  };
  const a = await getPerpDexs({ fetchImpl, apiUrl: 'http://x' });
  assert.deepEqual(a, [{ name: null, fullName: 'Main' }]);
  // failure was not cached: a subsequent (now-succeeding) call refetches
  fail = false;
  const b = await getPerpDexs({ fetchImpl, apiUrl: 'http://x' });
  assert.equal(calls, 2);
  assert.deepEqual(b, [{ name: null, fullName: 'Main' }, { name: 'xyz', fullName: 'XYZ' }]);
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
  assert.equal(out.equity, 100);
  assert.equal(out.totalUnrealizedPnl, null);
  assert.equal(out.openPositionsCount, 0);
});
