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

test('backfillFills enriches null columns without overwriting existing values', () => {
  const db = freshDb();
  // a legacy row: no dir, no builder_fee, no hash
  db.ingestFills('0xabc', [{ tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.33, px: 100, sz: 1, side: 'A', ts: 10 }]);
  let row = db.raw.prepare(`SELECT * FROM fills WHERE tid = 1`).get();
  assert.equal(row.dir, null);
  assert.equal(row.builder_fee, null);

  const res = db.backfillFills('0xabc', [
    // same tid, now with the enriched fields, plus DIFFERENT money values
    { tid: 1, coin: 'BTC', closed_pnl: 999, fee: 999, px: 999, sz: 999, side: 'A',
      dir: 'Close Long', builder_fee: 0.23, hash: '0xdead', oid: 42, fee_token: 'USDC', ts: 10 },
    // a genuinely new row
    { tid: 2, coin: 'ETH', closed_pnl: 1, fee: 0.1, px: 50, sz: 2, side: 'B',
      dir: 'Open Long', builder_fee: 0.05, hash: '0xbeef', oid: 43, fee_token: 'USDC', ts: 20 },
  ]);

  assert.equal(res.scanned, 2);
  assert.equal(res.inserted, 1, 'only tid 2 is new');
  assert.equal(res.enriched, 1, 'tid 1 gained a dir');

  row = db.raw.prepare(`SELECT * FROM fills WHERE tid = 1`).get();
  assert.equal(row.dir, 'Close Long', 'null dir filled in');
  assert.equal(row.builder_fee, 0.23);
  assert.equal(row.hash, '0xdead');
  assert.equal(row.oid, 42);
  // the economics of an observed fill must never be rewritten by a later sync
  assert.equal(row.closed_pnl, 5);
  assert.equal(row.fee, 0.33);
  assert.equal(row.px, 100);
  assert.equal(row.sz, 1);
});

test('backfillFills does not overwrite an already-populated dir', () => {
  const db = freshDb();
  db.ingestFills('0xabc', [{ tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1,
    side: 'A', dir: 'Close Long', ts: 10 }]);
  const res = db.backfillFills('0xabc', [{ tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1,
    side: 'A', dir: 'WRONG', builder_fee: 0.2, hash: '0xaa', oid: 1, fee_token: 'USDC', ts: 10 }]);
  const row = db.raw.prepare(`SELECT * FROM fills WHERE tid = 1`).get();
  assert.equal(row.dir, 'Close Long', 'existing value wins');
  assert.equal(row.builder_fee, 0.2, 'but a null column is still filled');
  // enriched counts any repaired column, not just dir — a builder-fee repair is
  // real money recovered and must not score zero just because dir was already set
  assert.equal(res.enriched, 1, 'the row went from incomplete to complete');
});

test('backfillFills on an empty list is a no-op', () => {
  const db = freshDb();
  assert.deepEqual(db.backfillFills('0xabc', []), { scanned: 0, inserted: 0, enriched: 0 });
});

test('listFillsRange is half-open and getRange spans fills and funding', () => {
  const db = freshDb();
  db.ingestFills('0xabc', [
    { tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.1, px: 100, sz: 1, side: 'A', ts: 100 },
    { tid: 2, coin: 'BTC', closed_pnl: 3, fee: 0.1, px: 100, sz: 1, side: 'A', ts: 200 },
    { tid: 3, coin: 'BTC', closed_pnl: 1, fee: 0.1, px: 100, sz: 1, side: 'A', ts: 300 },
  ]);
  db.ingestFunding('0xabc', [{ ts: 50, coin: 'BTC', usdc: -1, funding_rate: 0, szi: 1 }]);

  assert.deepEqual(db.listFillsRange('0xabc', 100, 300).map((r) => r.tid), [1, 2], 'to is exclusive');
  assert.equal(db.listFillsRange('0xabc').length, 3, 'no bounds means everything');

  const range = db.getRange('0xabc');
  assert.equal(range.minTs, 50, 'funding can predate the first fill');
  assert.equal(range.maxTs, 300);
  assert.deepEqual(db.getRange('0xnothing'), { minTs: null, maxTs: null });
});

test('listFillsRange returns the columns the export needs', () => {
  const db = freshDb();
  db.ingestFills('0xabc', [{ tid: 1, coin: 'BTC', closed_pnl: 5, fee: 0.33, builder_fee: 0.23,
    fee_token: 'USDC', px: 100, sz: 1, side: 'A', dir: 'Close Long', hash: '0xaa', oid: 7, ts: 100 }]);
  const [row] = db.listFillsRange('0xabc');
  for (const c of ['tid', 'coin', 'closed_pnl', 'fee', 'builder_fee', 'fee_token', 'px', 'sz', 'side', 'dir', 'hash', 'oid', 'ts']) {
    assert.ok(c in row, `missing column ${c}`);
  }
});

const ALERT = { address: '0xaaa', scope: 'account', coin: null, metric: 'equity', operator: 'below', threshold: 5000 };

test('createAlert stores and returns the row', () => {
  const db = freshDb();
  const a = db.createAlert(ALERT);
  assert.ok(a.id > 0);
  assert.equal(a.address, '0xaaa');
  assert.equal(a.metric, 'equity');
  assert.equal(a.threshold, 5000);
  assert.equal(a.enabled, 1);
  assert.equal(a.last_state, null);
  assert.equal(a.last_fired_at, null);
  assert.ok(a.created_at > 0);
});

test('listAlerts and listEnabledAlerts', () => {
  const db = freshDb();
  const on = db.createAlert(ALERT);
  const off = db.createAlert({ ...ALERT, metric: 'marginUsed', threshold: 1 });
  db.createAlert({ ...ALERT, address: '0xbbb' });
  db.updateAlert(off.id, { enabled: 0 });

  assert.equal(db.listAlerts('0xaaa').length, 2);
  const enabled = db.listEnabledAlerts('0xaaa');
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].id, on.id);
  assert.equal(db.listAlerts('0xbbb').length, 1);
});

test('alertAddresses lists distinct addresses with an enabled rule', () => {
  const db = freshDb();
  db.createAlert(ALERT);
  db.createAlert({ ...ALERT, metric: 'marginUsed' }); // same address, second rule
  const disabled = db.createAlert({ ...ALERT, address: '0xbbb' });
  db.updateAlert(disabled.id, { enabled: 0 });

  assert.deepEqual(db.alertAddresses(), ['0xaaa']);
});

test('updateAlert patches and re-arms', () => {
  const db = freshDb();
  const a = db.createAlert(ALERT);
  db.saveAlertResult(a.id, { lastState: 1, attemptAt: 111, firedAt: 111 });

  const updated = db.updateAlert(a.id, { threshold: 7000 });
  assert.equal(updated.threshold, 7000);
  // Re-armed: the old edge state described a threshold that no longer exists.
  assert.equal(updated.last_state, null);
  // Firing history is NOT reset — the UI still shows when it last fired.
  assert.equal(updated.last_fired_at, 111);

  assert.equal(db.updateAlert(9999, { threshold: 1 }), null);
});

test('updateAlert toggles enabled without touching threshold', () => {
  const db = freshDb();
  const a = db.createAlert(ALERT);
  const off = db.updateAlert(a.id, { enabled: 0 });
  assert.equal(off.enabled, 0);
  assert.equal(off.threshold, 5000);
  assert.equal(db.updateAlert(a.id, { enabled: 1 }).enabled, 1);
});

test('deleteAlert', () => {
  const db = freshDb();
  const a = db.createAlert(ALERT);
  assert.equal(db.deleteAlert(a.id), true);
  assert.equal(db.listAlerts('0xaaa').length, 0);
  assert.equal(db.deleteAlert(a.id), false);
});

test('saveAlertResult writes state and leaves null timestamps alone', () => {
  const db = freshDb();
  const a = db.createAlert(ALERT);
  assert.equal(db.saveAlertResult(a.id, { prevState: null, lastState: 1, attemptAt: 500, firedAt: 500 }), true);

  // A no-fire pass: state advances, timestamps must survive untouched.
  db.saveAlertResult(a.id, { prevState: 1, lastState: 0 });
  let row = db.listAlerts('0xaaa')[0];
  assert.equal(row.last_state, 0);
  assert.equal(row.last_attempt_at, 500);
  assert.equal(row.last_fired_at, 500);

  // Parking writes a genuine NULL rather than being swallowed as "no change".
  db.saveAlertResult(a.id, { prevState: 0, lastState: null });
  assert.equal(db.listAlerts('0xaaa')[0].last_state, null);
});

test('saveAlertResult refuses to write over a state that moved underneath it', () => {
  const db = freshDb();
  const a = db.createAlert(ALERT);
  db.saveAlertResult(a.id, { prevState: null, lastState: 1, attemptAt: 500, firedAt: 500 });

  // A PATCH re-arms the rule to NULL while an evaluation that read `1` is still
  // awaiting the network. That evaluation's write must not land.
  db.updateAlert(a.id, { threshold: 7000 });
  assert.equal(db.saveAlertResult(a.id, { prevState: 1, lastState: 1 }), false);
  assert.equal(db.listAlerts('0xaaa')[0].last_state, null, 're-arm survives');
});

test('saveAlertAttempt advances the retry throttle and nothing else', () => {
  const db = freshDb();
  const a = db.createAlert(ALERT);
  db.saveAlertResult(a.id, { prevState: null, lastState: 1, attemptAt: 500, firedAt: 500 });

  db.saveAlertAttempt(a.id, 900);
  const row = db.listAlerts('0xaaa')[0];
  assert.equal(row.last_attempt_at, 900);
  assert.equal(row.last_fired_at, 500, 'a failed send never claims it fired');
  assert.equal(row.last_state, 1, 'state untouched, so the rule retries');
});

test('deleteWallet purges that wallet alerts only', () => {
  const db = freshDb();
  for (const addr of ['0xaaa', '0xbbb']) {
    db.upsertWallet(addr, 'w');
    db.createAlert({ ...ALERT, address: addr });
  }
  db.deleteWallet('0xaaa');
  assert.equal(db.listAlerts('0xaaa').length, 0);
  assert.equal(db.listAlerts('0xbbb').length, 1);
});
