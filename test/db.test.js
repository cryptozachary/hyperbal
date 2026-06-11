import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `hl-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  return openDb(p);
}

test('wallet upsert/list/remove', () => {
  const db = freshDb();
  db.upsertWallet('0xabc', 'main');
  db.upsertWallet('0xabc', 'renamed'); // upsert keeps single row
  let rows = db.listWallets();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'renamed');
  db.removeWallet('0xabc');
  assert.equal(db.listWallets().length, 0);
});

test('fills dedupe and cumulative realized', () => {
  const db = freshDb();
  const fills = [
    { tid: 1, coin: 'BTC', closed_pnl: 10, fee: 1, px: 100, sz: 1, side: 'B', ts: 1 },
    { tid: 2, coin: 'BTC', closed_pnl: -4, fee: 1, px: 100, sz: 1, side: 'A', ts: 2 },
  ];
  db.ingestFills('0xabc', fills);
  db.ingestFills('0xabc', fills); // duplicate tids ignored
  assert.equal(db.cumulativeRealized('0xabc'), 6);
});

test('snapshot throttling', () => {
  const db = freshDb();
  const w = db.insertSnapshotThrottled('0xabc', { ts: 1000, equity: 1, unrealized_pnl: 0, realized_pnl_cum: 0, open_positions: 0 }, 60000);
  const blocked = db.insertSnapshotThrottled('0xabc', { ts: 2000, equity: 2, unrealized_pnl: 0, realized_pnl_cum: 0, open_positions: 0 }, 60000);
  const allowed = db.insertSnapshotThrottled('0xabc', { ts: 70000, equity: 3, unrealized_pnl: 0, realized_pnl_cum: 0, open_positions: 0 }, 60000);
  assert.equal(w, true);
  assert.equal(blocked, false);
  assert.equal(allowed, true);
  assert.equal(db.getHistory('0xabc').length, 2);
});

test('wallets carry via_agent and preserve it on null upsert', () => {
  const db = freshDb();
  db.upsertWallet('0xmaster', 'main', '0xagent');
  let rows = db.listWallets();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].via_agent, '0xagent');
  // a later upsert without an agent (e.g. per-load refresh) must not wipe it
  db.upsertWallet('0xmaster');
  rows = db.listWallets();
  assert.equal(rows[0].via_agent, '0xagent');
});

test('migration adds via_agent to a pre-existing wallets table', async () => {
  const Database = (await import('better-sqlite3')).default;
  const p = path.join(os.tmpdir(), `hl-migrate-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  // create an OLD-schema wallets table (no via_agent), then close
  const old = new Database(p);
  old.exec(`CREATE TABLE wallets (address TEXT PRIMARY KEY, label TEXT, added_at INTEGER NOT NULL, last_viewed_at INTEGER)`);
  old.prepare(`INSERT INTO wallets (address, label, added_at, last_viewed_at) VALUES (?,?,?,?)`).run('0xold', 'legacy', 1, 1);
  old.close();
  // reopen via openDb -> migration should add the column and preserve the row
  const db = openDb(p);
  const rows = db.listWallets();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].address, '0xold');
  assert.equal(rows[0].via_agent, null);
});
