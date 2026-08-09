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
  dir TEXT,
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

  // Migration: add fills.dir to DBs created before trade-history support.
  const fillCols = db.prepare(`PRAGMA table_info(fills)`).all();
  if (!fillCols.some((c) => c.name === 'dir')) {
    db.exec(`ALTER TABLE fills ADD COLUMN dir TEXT`);
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
    hasWallet: db.prepare(`SELECT 1 FROM wallets WHERE address = ?`),
    // Touch-only: unlike upsertWallet this never inserts, so viewing an account
    // can't resurrect a wallet that was deleted.
    touchWallet: db.prepare(`UPDATE wallets SET last_viewed_at = @now WHERE address = @address`),
    removeWallet: db.prepare(`DELETE FROM wallets WHERE address = ?`),
    removeSnapshots: db.prepare(`DELETE FROM snapshots WHERE address = ?`),
    removeFills: db.prepare(`DELETE FROM fills WHERE address = ?`),
    insertFill: db.prepare(`
      INSERT OR IGNORE INTO fills (address, tid, coin, closed_pnl, fee, px, sz, side, dir, ts)
      VALUES (@address, @tid, @coin, @closed_pnl, @fee, @px, @sz, @side, @dir, @ts)
    `),
    cumulativeRealized: db.prepare(`SELECT COALESCE(SUM(closed_pnl),0) AS total FROM fills WHERE address = ?`),
    listFillsAll: db.prepare(`
      SELECT tid, coin, closed_pnl, fee, px, sz, side, dir, ts FROM fills
      WHERE address = ? ORDER BY ts DESC, tid DESC LIMIT ? OFFSET ?
    `),
    listFillsCloses: db.prepare(`
      SELECT tid, coin, closed_pnl, fee, px, sz, side, dir, ts FROM fills
      WHERE address = ? AND closed_pnl != 0 ORDER BY ts DESC, tid DESC LIMIT ? OFFSET ?
    `),
    countFillsAll: db.prepare(`SELECT COUNT(*) AS n FROM fills WHERE address = ?`),
    countFillsCloses: db.prepare(`SELECT COUNT(*) AS n FROM fills WHERE address = ? AND closed_pnl != 0`),
    lastSnapshotTs: db.prepare(`SELECT MAX(ts) AS ts FROM snapshots WHERE address = ?`),
    insertSnapshot: db.prepare(`
      INSERT INTO snapshots (address, ts, equity, unrealized_pnl, realized_pnl_cum, open_positions)
      VALUES (@address, @ts, @equity, @unrealized_pnl, @realized_pnl_cum, @open_positions)
    `),
    getHistory: db.prepare(`SELECT ts, equity, unrealized_pnl, realized_pnl_cum, open_positions FROM snapshots WHERE address = ? AND ts >= ? ORDER BY ts ASC`),
  };

  const ingestTxn = db.transaction((address, fills) => {
    for (const f of fills) stmts.insertFill.run({ address, dir: null, ...f });
  });

  // One transaction so a mid-delete failure can't leave a wallet whose row is
  // gone but whose fills and snapshots remain.
  const deleteWalletTxn = db.transaction((address) => {
    stmts.removeWallet.run(address);
    stmts.removeSnapshots.run(address);
    stmts.removeFills.run(address);
  });

  return {
    raw: db,
    upsertWallet(address, label = null, viaAgent = null) {
      stmts.upsertWallet.run({ address, label, viaAgent, now: Date.now() });
    },
    listWallets() { return stmts.listWallets.all(); },
    hasWallet(address) { return stmts.hasWallet.get(address) !== undefined; },
    touchWallet(address) { stmts.touchWallet.run({ address, now: Date.now() }); },
    deleteWallet(address) { deleteWalletTxn(address); },
    ingestFills(address, fills) { if (fills?.length) ingestTxn(address, fills); },
    cumulativeRealized(address) { return stmts.cumulativeRealized.get(address).total; },
    listFills(address, { limit = 50, offset = 0, closesOnly = false } = {}) {
      return (closesOnly ? stmts.listFillsCloses : stmts.listFillsAll).all(address, limit, offset);
    },
    countFills(address, { closesOnly = false } = {}) {
      return (closesOnly ? stmts.countFillsCloses : stmts.countFillsAll).get(address).n;
    },
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
