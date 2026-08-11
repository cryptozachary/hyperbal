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
  db.deleteWallet('0xabc');
  assert.equal(db.listWallets().length, 0);
});

test('deleteWallet purges snapshots and fills for that address only', () => {
  const db = freshDb();
  for (const addr of ['0xaaa', '0xbbb']) {
    db.upsertWallet(addr, 'w');
    db.ingestFills(addr, [{ tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1, side: 'A', dir: 'Close Long', ts: 10 }]);
    db.insertSnapshotThrottled(addr, { ts: 1000, equity: 1, unrealized_pnl: 0, realized_pnl_cum: 0, open_positions: 0 }, 0);
  }
  db.deleteWallet('0xaaa');

  assert.equal(db.listWallets().length, 1);
  assert.equal(db.listWallets()[0].address, '0xbbb');
  assert.equal(db.countFills('0xaaa'), 0);
  assert.equal(db.cumulativeRealized('0xaaa'), 0);
  assert.equal(db.getHistory('0xaaa').length, 0);
  // the surviving wallet is untouched
  assert.equal(db.countFills('0xbbb'), 1);
  assert.equal(db.getHistory('0xbbb').length, 1);
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

test('migration adds dir to a pre-existing fills table', async () => {
  const Database = (await import('better-sqlite3')).default;
  const p = path.join(os.tmpdir(), `hl-fills-migrate-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const old = new Database(p);
  old.exec(`CREATE TABLE fills (address TEXT NOT NULL, tid INTEGER NOT NULL, coin TEXT,
    closed_pnl REAL, fee REAL, px REAL, sz REAL, side TEXT, ts INTEGER, PRIMARY KEY (address, tid))`);
  old.prepare(`INSERT INTO fills (address, tid, coin, closed_pnl, fee, px, sz, side, ts)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('0xold', 1, 'BTC', 5, 0.1, 100, 1, 'B', 10);
  old.close();
  const db = openDb(p);
  const rows = db.raw.prepare(`SELECT tid, dir FROM fills WHERE address = ?`).all('0xold');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dir, null);
});

test('ingestFills stores dir and defaults it when the caller omits it', () => {
  const db = freshDb();
  db.ingestFills('0xabc', [
    { tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1, side: 'A', dir: 'Close Long', ts: 10 },
    { tid: 2, coin: 'ETH', closed_pnl: 0, fee: 0.1, px: 50, sz: 2, side: 'B', ts: 20 },
  ]);
  const rows = db.raw.prepare(`SELECT tid, dir FROM fills WHERE address = ? ORDER BY tid`).all('0xabc');
  assert.equal(rows[0].dir, 'Close Long');
  assert.equal(rows[1].dir, null);
});

test('listFills paginates newest-first with stable ordering and closesOnly filter', () => {
  const db = freshDb();
  // tids 3 and 4 share a timestamp — ordering must still be total
  db.ingestFills('0xabc', [
    { tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1, side: 'A', dir: 'Close Long', ts: 10 },
    { tid: 2, coin: 'BTC', closed_pnl: 0, fee: 0.1, px: 100, sz: 1, side: 'B', dir: 'Open Long', ts: 20 },
    { tid: 3, coin: 'ETH', closed_pnl: -2, fee: 0.1, px: 50, sz: 2, side: 'A', dir: 'Close Long', ts: 30 },
    { tid: 4, coin: 'ETH', closed_pnl: 0, fee: 0.1, px: 50, sz: 2, side: 'B', dir: 'Open Long', ts: 30 },
  ]);

  const all = db.listFills('0xabc', { limit: 50, offset: 0 });
  assert.deepEqual(all.map((r) => r.tid), [4, 3, 2, 1]);
  assert.equal(db.countFills('0xabc'), 4);

  // pagination covers every row exactly once
  const p1 = db.listFills('0xabc', { limit: 2, offset: 0 });
  const p2 = db.listFills('0xabc', { limit: 2, offset: 2 });
  assert.deepEqual(p1.map((r) => r.tid), [4, 3]);
  assert.deepEqual(p2.map((r) => r.tid), [2, 1]);

  const closes = db.listFills('0xabc', { limit: 50, offset: 0, closesOnly: true });
  assert.deepEqual(closes.map((r) => r.tid), [3, 1]);
  assert.equal(db.countFills('0xabc', { closesOnly: true }), closes.length);

  // rows carry the columns the UI renders
  assert.equal(all[0].coin, 'ETH');
  assert.equal(all[0].dir, 'Open Long');
  assert.equal(all[0].fee, 0.1);
});

test('listFills is scoped to one address', () => {
  const db = freshDb();
  db.ingestFills('0xaaa', [{ tid: 1, coin: 'BTC', closed_pnl: 1, fee: 0, px: 1, sz: 1, side: 'A', dir: 'Close Long', ts: 1 }]);
  db.ingestFills('0xbbb', [{ tid: 2, coin: 'ETH', closed_pnl: 2, fee: 0, px: 1, sz: 1, side: 'A', dir: 'Close Long', ts: 2 }]);
  assert.equal(db.countFills('0xaaa'), 1);
  assert.equal(db.listFills('0xaaa', { limit: 50, offset: 0 })[0].coin, 'BTC');
});

test('migration adds all fills columns to a pre-existing table', async () => {
  const Database = (await import('better-sqlite3')).default;
  const p = path.join(os.tmpdir(), `hl-cols-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const old = new Database(p);
  old.exec(`CREATE TABLE fills (address TEXT NOT NULL, tid INTEGER NOT NULL, coin TEXT,
    closed_pnl REAL, fee REAL, px REAL, sz REAL, side TEXT, ts INTEGER, PRIMARY KEY (address, tid))`);
  old.prepare(`INSERT INTO fills (address, tid, coin, closed_pnl, fee, px, sz, side, ts)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('0xold', 1, 'BTC', 5, 0.1, 100, 1, 'B', 10);
  old.close();

  const db = openDb(p);
  const cols = db.raw.prepare(`PRAGMA table_info(fills)`).all().map((c) => c.name);
  for (const c of ['dir', 'builder_fee', 'hash', 'oid', 'fee_token']) {
    assert.ok(cols.includes(c), `missing column ${c}`);
  }
  const row = db.raw.prepare(`SELECT * FROM fills WHERE address = ?`).get('0xold');
  assert.equal(row.tid, 1);
  assert.equal(row.closed_pnl, 5, 'existing data must survive the migration');
  assert.equal(row.builder_fee, null);
});

test('ingestFills stores the new columns and defaults them when omitted', () => {
  const db = freshDb();
  db.ingestFills('0xabc', [
    { tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.33, builder_fee: 0.23, px: 100, sz: 1,
      side: 'A', dir: 'Close Long', hash: '0xabc', oid: 42, fee_token: 'USDC', ts: 10 },
    { tid: 2, coin: 'ETH', closed_pnl: 0, fee: 0.1, px: 50, sz: 2, side: 'B', ts: 20 },
  ]);
  const rows = db.raw.prepare(`SELECT * FROM fills WHERE address = ? ORDER BY tid`).all('0xabc');
  assert.equal(rows[0].builder_fee, 0.23);
  assert.equal(rows[0].hash, '0xabc');
  assert.equal(rows[0].oid, 42);
  assert.equal(rows[1].builder_fee, null);
  assert.equal(rows[1].hash, null);
});

test('funding dedupes on (address, ts, coin) and reports inserted count', () => {
  const db = freshDb();
  const rows = [
    { ts: 100, coin: 'BTC', usdc: -0.5, funding_rate: 0.0000125, szi: 2 },
    { ts: 100, coin: 'ETH', usdc: 0.25, funding_rate: 0.00001, szi: 1 },  // same ts, different coin
    { ts: 200, coin: 'BTC', usdc: -0.6, funding_rate: 0.0000125, szi: 2 },
  ];
  assert.equal(db.ingestFunding('0xabc', rows), 3);
  assert.equal(db.ingestFunding('0xabc', rows), 0, 're-ingest must insert nothing');
  assert.equal(db.listFunding('0xabc').length, 3);
  assert.equal(db.listFunding('0xabc', 150, 300).length, 1, 'range is half-open');
  // scoped per address
  db.ingestFunding('0xbbb', [{ ts: 100, coin: 'BTC', usdc: -9, funding_rate: 0, szi: 1 }]);
  assert.equal(db.listFunding('0xabc').length, 3);
});

test('deleteWallet purges funding too', () => {
  const db = freshDb();
  db.upsertWallet('0xabc', 'w');
  db.ingestFunding('0xabc', [{ ts: 100, coin: 'BTC', usdc: -0.5, funding_rate: 0, szi: 1 }]);
  db.ingestFills('0xabc', [{ tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1, side: 'A', ts: 10 }]);
  db.deleteWallet('0xabc');
  assert.equal(db.listFunding('0xabc').length, 0);
  assert.equal(db.countFills('0xabc'), 0);
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
