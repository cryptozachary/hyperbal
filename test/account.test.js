import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { assembleAccount } from '../account.js';
import { _resetDexCaches } from '../hyperliquid.js';

const ADDR = '0x' + 'a'.repeat(40);
const ok = (payload) => ({ ok: true, json: async () => payload });
const fail = () => ({ ok: false, status: 500, text: async () => 'boom' });
const freshDb = () => openDb(path.join(os.tmpdir(), `hl-acc-${Date.now()}-${Math.random().toString(16).slice(2)}.db`));
const POS = (coin, szi, uPnl) => ({ position: { coin, szi, entryPx: '90', positionValue: '100', unrealizedPnl: uPnl, returnOnEquity: '0.1', liquidationPx: '50', leverage: { type: 'cross', value: 5 }, marginUsed: '10' } });

// dexs: builder dexs [{name,fullName}]; cs: map of dexKey('main'|name)->clearinghouseState; failDex: dexKey to fail; failFills: fail userFills too
function makeOpts({ dexs = [], cs = {}, failDex = null, failFills = false } = {}) {
  const fetchImpl = async (_url, init) => {
    const b = JSON.parse(init.body);
    if (b.type === 'perpDexs') return ok([null, ...dexs]);
    if (b.type === 'spotMeta') return ok({ tokens: [{ index: 0, name: 'USDC' }] });
    if (b.type === 'meta') return ok({ collateralToken: 0 });
    if (b.type === 'clearinghouseState') {
      const key = b.dex || 'main';
      if (failDex === key) return fail();
      return ok(cs[key] || { marginSummary: {}, assetPositions: [] });
    }
    if (b.type === 'userFills') return failFills ? fail() : ok([{ tid: 1, coin: 'BTC', closedPnl: '5', fee: '0.1', px: '90', sz: '1', side: 'B', time: 1 }]);
    return ok({});
  };
  return { fetchImpl, apiUrl: 'http://x', snapshotMinIntervalMs: 60000 };
}

test('assembleAccount (main dex only) returns normalized payload and persists', async () => {
  _resetDexCaches();
  const db = freshDb();
  db.upsertWallet(ADDR); // persistence is scoped to watched wallets; POST /api/wallets is the insertion path
  const opts = makeOpts({ cs: { main: { marginSummary: { accountValue: '500', totalMarginUsed: '10' }, assetPositions: [POS('BTC', '1', '10')] } } });
  const out = await assembleAccount(ADDR, db, opts);
  assert.equal(out.equity, 500);
  assert.equal(out.openPositionsCount, 1);
  assert.equal(out.realizedPnlCumulative, 5);
  assert.equal(out.realizedPnlRecent, 5);
  assert.equal(db.getHistory(ADDR).length, 1);
  assert.equal(db.listWallets().length, 1);
});

test('assembleAccount aggregates across main + builder dex', async () => {
  _resetDexCaches();
  const db = freshDb();
  const opts = makeOpts({
    dexs: [{ name: 'xyz', fullName: 'XYZ' }],
    cs: {
      main: { marginSummary: { accountValue: '500', totalMarginUsed: '10' }, assetPositions: [POS('BTC', '1', '10')] },
      xyz: { marginSummary: { accountValue: '583', totalMarginUsed: '583' }, assetPositions: [POS('xyz:SP500', '-0.753', '-625')] },
    },
  });
  const out = await assembleAccount(ADDR, db, opts);
  assert.equal(out.equity, 1083);
  assert.equal(out.openPositionsCount, 2);
  const sp = out.positions.find((p) => p.coin === 'xyz:SP500');
  assert.equal(sp.dex, 'xyz');
  assert.equal(sp.collateral, 'USDC');
  assert.equal(sp.side, 'SHORT');
});

test('assembleAccount skips a failing builder dex but keeps main', async () => {
  _resetDexCaches();
  const db = freshDb();
  const opts = makeOpts({
    dexs: [{ name: 'xyz', fullName: 'XYZ' }],
    cs: { main: { marginSummary: { accountValue: '500' }, assetPositions: [POS('BTC', '1', '10')] } },
    failDex: 'xyz',
  });
  const out = await assembleAccount(ADDR, db, opts);
  assert.equal(out.equity, 500);
  assert.equal(out.openPositionsCount, 1);
});

test('assembleAccount throws if the main dex fails', async () => {
  _resetDexCaches();
  const db = freshDb();
  await assert.rejects(() => assembleAccount(ADDR, db, makeOpts({ failDex: 'main' })), /main dex/i);
});

test('assembleAccount rejects cleanly when main dex and userFills both fail (no orphan rejection)', async () => {
  _resetDexCaches();
  const db = freshDb();
  await assert.rejects(() => assembleAccount(ADDR, db, makeOpts({ failDex: 'main', failFills: true })), /main dex/i);
});

test('assembleAccount does not resurrect a wallet that was deleted mid-flight', async () => {
  _resetDexCaches();
  const db = openDb(path.join(os.tmpdir(), `hl-resurrect-${Date.now()}-${Math.random().toString(16).slice(2)}.db`));
  const A = '0x' + '9'.repeat(40);

  const fetchImpl = async (_url, init) => {
    const b = JSON.parse(init.body);
    if (b.type === 'perpDexs') return { ok: true, json: async () => ([null]) };
    if (b.type === 'spotMeta') return { ok: true, json: async () => ({ tokens: [] }) };
    if (b.type === 'clearinghouseState') return { ok: true, json: async () => ({ marginSummary: { accountValue: '500' }, assetPositions: [] }) };
    if (b.type === 'userFills') return { ok: true, json: async () => ([{ tid: 1, coin: 'BTC', closedPnl: '5', fee: '0.1', px: '100', sz: '1', side: 'A', dir: 'Close Long', time: 10 }]) };
    return { ok: true, json: async () => ({}) };
  };
  const opts = { fetchImpl, apiUrl: 'http://x', snapshotMinIntervalMs: 0 };

  // watched: fills and snapshot persist, wallet row stays
  db.upsertWallet(A, 'watched');
  await assembleAccount(A, db, opts);
  assert.equal(db.countFills(A), 1);
  assert.equal(db.getHistory(A).length, 1);

  // deleted, then a poll (or a second tab) hits /api/account again
  db.deleteWallet(A);
  await assembleAccount(A, db, opts);
  assert.equal(db.listWallets().length, 0, 'wallet row must not come back');
  assert.equal(db.countFills(A), 0, 'fills must not come back');
  assert.equal(db.cumulativeRealized(A), 0, 'cumulative realized must not come back');
  assert.equal(db.getHistory(A).length, 0, 'snapshots must not come back');
});
