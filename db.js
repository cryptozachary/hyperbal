import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  label TEXT,
  via_agent TEXT,
  added_at INTEGER NOT NULL,
  last_viewed_at INTEGER
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  ts INTEGER NOT NULL,
  equity REAL,
  unrealized_pnl REAL,
  realized_pnl_cum REAL,
  open_positions INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snapshots_addr_ts ON snapshots(address, ts);
CREATE TABLE IF NOT EXISTS fills (
  address TEXT NOT NULL,
  tid INTEGER NOT NULL,
  coin TEXT,
  closed_pnl REAL,
  fee REAL,
  px REAL,
  sz REAL,
  side TEXT,
  ts INTEGER,
  PRIMARY KEY (address, tid)
);
`;

export function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  // Migration: add wallets.via_agent to DBs created before agent-wallet support.
  const walletCols = db.prepare(`PRAGMA table_info(wallets)`).all();
  if (!walletCols.some((c) => c.name === 'via_agent')) {
    db.exec(`ALTER TABLE wallets ADD COLUMN via_agent TEXT`);
  }

  const stmts = {
    // via_agent uses COALESCE: a null upsert (e.g. per-load refresh) preserves it; a non-null upsert overwrites it.
    upsertWallet: db.prepare(`
      INSERT INTO wallets (address, label, via_agent, added_at, last_viewed_at)
      VALUES (@address, @label, @viaAgent, @now, @now)
      ON CONFLICT(address) DO UPDATE SET
        label = COALESCE(excluded.label, wallets.label),
        via_agent = COALESCE(excluded.via_agent, wallets.via_agent),
        last_viewed_at = excluded.last_viewed_at
    `),
    listWallets: db.prepare(`SELECT address, label, via_agent, added_at, last_viewed_at FROM wallets ORDER BY last_viewed_at DESC NULLS LAST, added_at DESC`),
    removeWallet: db.prepare(`DELETE FROM wallets WHERE address = ?`),
    insertFill: db.prepare(`
      INSERT OR IGNORE INTO fills (address, tid, coin, closed_pnl, fee, px, sz, side, ts)
      VALUES (@address, @tid, @coin, @closed_pnl, @fee, @px, @sz, @side, @ts)
    `),
    cumulativeRealized: db.prepare(`SELECT COALESCE(SUM(closed_pnl),0) AS total FROM fills WHERE address = ?`),
    lastSnapshotTs: db.prepare(`SELECT MAX(ts) AS ts FROM snapshots WHERE address = ?`),
    insertSnapshot: db.prepare(`
      INSERT INTO snapshots (address, ts, equity, unrealized_pnl, realized_pnl_cum, open_positions)
      VALUES (@address, @ts, @equity, @unrealized_pnl, @realized_pnl_cum, @open_positions)
    `),
    getHistory: db.prepare(`SELECT ts, equity, unrealized_pnl, realized_pnl_cum, open_positions FROM snapshots WHERE address = ? AND ts >= ? ORDER BY ts ASC`),
  };

  const ingestTxn = db.transaction((address, fills) => {
    for (const f of fills) stmts.insertFill.run({ address, ...f });
  });

  return {
    raw: db,
    upsertWallet(address, label = null, viaAgent = null) {
      stmts.upsertWallet.run({ address, label, viaAgent, now: Date.now() });
    },
    listWallets() { return stmts.listWallets.all(); },
    removeWallet(address) { stmts.removeWallet.run(address); },
    ingestFills(address, fills) { if (fills?.length) ingestTxn(address, fills); },
    cumulativeRealized(address) { return stmts.cumulativeRealized.get(address).total; },
    getHistory(address, since = 0) { return stmts.getHistory.all(address, since); },
    // Returns true if a snapshot was written, false if throttled.
    insertSnapshotThrottled(address, point, minIntervalMs) {
      const last = stmts.lastSnapshotTs.get(address).ts;
      if (last != null && point.ts - last < minIntervalMs) return false;
      stmts.insertSnapshot.run({ address, ...point });
      return true;
    },
  };
}
