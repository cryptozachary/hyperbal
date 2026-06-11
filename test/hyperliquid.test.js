import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidAddress, normalizeAccount, normalizeFills, parseNum, fetchInfo,
  getUserRole, getExtraAgents, resolveAccountAddress, normalizeExtraAgents } from '../hyperliquid.js';

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
