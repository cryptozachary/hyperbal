import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { assembleAccount } from '../account.js';

const ADDR = '0x' + 'a'.repeat(40);

function deps() {
  const db = openDb(path.join(os.tmpdir(), `hl-acc-${Date.now()}-${Math.random().toString(16).slice(2)}.db`));
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.type === 'clearinghouseState') {
      return { ok: true, json: async () => ({
        marginSummary: { accountValue: '500', totalMarginUsed: '10' },
        assetPositions: [{ position: { coin: 'BTC', szi: '1', entryPx: '90', positionValue: '100',
          unrealizedPnl: '10', returnOnEquity: '0.1', liquidationPx: '50',
          leverage: { type: 'cross', value: 5 }, marginUsed: '10' } }],
      }) };
    }
    return { ok: true, json: async () => ([
      { tid: 1, coin: 'BTC', closedPnl: '5', fee: '0.1', px: '90', sz: '1', side: 'B', time: 1 },
    ]) };
  };
  return { db, opts: { fetchImpl, apiUrl: 'http://x', snapshotMinIntervalMs: 60000 } };
}

test('assembleAccount returns normalized payload and persists', async () => {
  const { db, opts } = deps();
  const out = await assembleAccount(ADDR, db, opts);
  assert.equal(out.equity, 500);
  assert.equal(out.openPositionsCount, 1);
  assert.equal(out.realizedPnlRecent, 5);
  assert.equal(out.realizedPnlCumulative, 5);
  assert.equal(db.getHistory(ADDR).length, 1);     // snapshot written
  assert.equal(db.listWallets().length, 1);        // wallet upserted
});
