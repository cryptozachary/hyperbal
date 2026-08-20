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
  builder_fee REAL,
  hash TEXT,
  oid INTEGER,
  fee_token TEXT,
  ts INTEGER,
  PRIMARY KEY (address, tid)
);
CREATE TABLE IF NOT EXISTS funding (
  address TEXT NOT NULL,
  ts INTEGER NOT NULL,
  coin TEXT NOT NULL,
  usdc REAL,
  funding_rate REAL,
  szi REAL,
  PRIMARY KEY (address, ts, coin)
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  scope TEXT NOT NULL,
  coin TEXT,
  metric TEXT NOT NULL,
  operator TEXT NOT NULL,
  threshold REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_state INTEGER,
  last_attempt_at INTEGER,
  last_fired_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_addr ON alerts(address);
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

  // Migration: add fills columns introduced after the original schema. Data-driven
  // so each new column is one entry rather than another copy of this block.
  const fillCols = db.prepare(`PRAGMA table_info(fills)`).all().map((c) => c.name);
  for (const [name, type] of [['dir', 'TEXT'], ['builder_fee', 'REAL'], ['hash', 'TEXT'], ['oid', 'INTEGER'], ['fee_token', 'TEXT']]) {
    if (!fillCols.includes(name)) db.exec(`ALTER TABLE fills ADD COLUMN ${name} ${type}`);
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
    removeFunding: db.prepare(`DELETE FROM funding WHERE address = ?`),
    insertFill: db.prepare(`
      INSERT OR IGNORE INTO fills (address, tid, coin, closed_pnl, fee, px, sz, side, dir, builder_fee, hash, oid, fee_token, ts)
      VALUES (@address, @tid, @coin, @closed_pnl, @fee, @px, @sz, @side, @dir, @builder_fee, @hash, @oid, @fee_token, @ts)
    `),
    // The live path uses INSERT OR IGNORE — a duplicate there is nothing to do.
    // Backfill wants the opposite: enrich rows that predate the newer columns.
    // COALESCE(existing, incoming) fills gaps without overwriting what's recorded.
    // Money columns are deliberately absent from DO UPDATE: a fill's economics are
    // fixed once observed, and a sync must never silently rewrite them.
    backfillFill: db.prepare(`
      INSERT INTO fills (address, tid, coin, closed_pnl, fee, px, sz, side, dir, builder_fee, hash, oid, fee_token, ts)
      VALUES (@address, @tid, @coin, @closed_pnl, @fee, @px, @sz, @side, @dir, @builder_fee, @hash, @oid, @fee_token, @ts)
      ON CONFLICT(address, tid) DO UPDATE SET
        dir         = COALESCE(fills.dir,         excluded.dir),
        builder_fee = COALESCE(fills.builder_fee, excluded.builder_fee),
        hash        = COALESCE(fills.hash,        excluded.hash),
        oid         = COALESCE(fills.oid,         excluded.oid),
        fee_token   = COALESCE(fills.fee_token,   excluded.fee_token)
    `),
    // Rows still missing at least one of the columns the backfill can repair.
    // Counting only `dir` would under-report: since dir capture shipped, new rows
    // all have one, so a builder-fee repair — the money column — would score zero.
    countIncomplete: db.prepare(`
      SELECT COUNT(*) AS n FROM fills WHERE address = ?
        AND (dir IS NULL OR builder_fee IS NULL OR hash IS NULL OR oid IS NULL OR fee_token IS NULL)
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
    insertFunding: db.prepare(`
      INSERT OR IGNORE INTO funding (address, ts, coin, usdc, funding_rate, szi)
      VALUES (@address, @ts, @coin, @usdc, @funding_rate, @szi)
    `),
    listFunding: db.prepare(`
      SELECT ts, coin, usdc, funding_rate, szi FROM funding
      WHERE address = ? AND ts >= ? AND ts < ? ORDER BY ts ASC, coin ASC
    `),
    listFillsRange: db.prepare(`
      SELECT tid, coin, closed_pnl, fee, builder_fee, fee_token, px, sz, side, dir, hash, oid, ts
      FROM fills WHERE address = ? AND ts >= ? AND ts < ? ORDER BY ts ASC, tid ASC
    `),
    rangeFills: db.prepare(`SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM fills WHERE address = ?`),
    rangeFunding: db.prepare(`SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM funding WHERE address = ?`),
    insertAlert: db.prepare(`
      INSERT INTO alerts (address, scope, coin, metric, operator, threshold, enabled, created_at)
      VALUES (@address, @scope, @coin, @metric, @operator, @threshold, 1, @now)
    `),
    getAlert: db.prepare(`SELECT * FROM alerts WHERE id = ?`),
    listAlerts: db.prepare(`SELECT * FROM alerts WHERE address = ? ORDER BY created_at ASC, id ASC`),
    listEnabledAlerts: db.prepare(`SELECT * FROM alerts WHERE address = ? AND enabled = 1 ORDER BY id ASC`),
    alertAddresses: db.prepare(`SELECT DISTINCT address FROM alerts WHERE enabled = 1 ORDER BY address ASC`),
    // Patch what was sent and leave the rest: COALESCE(@x, column) makes an
    // omitted field mean "unchanged" rather than "set to null".
    //
    // last_state is deliberately NOT coalesced — it resets to NULL on every patch.
    // A threshold that moved, or a rule coming back from disabled, describes a
    // world the old edge state no longer refers to; carrying last_state = 1 across
    // would suppress the first real crossing under the new settings.
    // last_fired_at survives, so the UI keeps its history.
    updateAlert: db.prepare(`
      UPDATE alerts SET
        enabled = COALESCE(@enabled, enabled),
        threshold = COALESCE(@threshold, threshold),
        last_state = NULL
      WHERE id = @id
    `),
    deleteAlert: db.prepare(`DELETE FROM alerts WHERE id = ?`),
    removeAlerts: db.prepare(`DELETE FROM alerts WHERE address = ?`),
    // Compare-and-set on last_state. The runner reads a rule, awaits a network
    // round trip, then writes back — and in that window a PATCH may have reset
    // last_state to NULL to re-arm the rule. Writing the pre-await value over that
    // would silently undo the re-arm and suppress the next real crossing, which is
    // the exact bug updateAlert's NULL reset exists to prevent. `IS` rather than
    // `=` because the expected value is very often NULL.
    saveAlertResult: db.prepare(`
      UPDATE alerts SET
        last_state = @lastState,
        last_attempt_at = COALESCE(@attemptAt, last_attempt_at),
        last_fired_at = COALESCE(@firedAt, last_fired_at)
      WHERE id = @id AND last_state IS @prevState
    `),
    // The send-failure path: advance the retry throttle without touching
    // last_state at all, so there is nothing to clobber and no guard needed.
    saveAlertAttempt: db.prepare(`UPDATE alerts SET last_attempt_at = @attemptAt WHERE id = @id`),
  };

  const FILL_DEFAULTS = { dir: null, builder_fee: null, hash: null, oid: null, fee_token: null };

  const ingestTxn = db.transaction((address, fills) => {
    for (const f of fills) stmts.insertFill.run({ address, ...FILL_DEFAULTS, ...f });
  });

  const backfillTxn = db.transaction((address, rows) => {
    for (const r of rows) stmts.backfillFill.run({ address, ...FILL_DEFAULTS, ...r });
  });

  const ingestFundingTxn = db.transaction((address, rows) => {
    let inserted = 0;
    for (const r of rows) inserted += stmts.insertFunding.run({ address, ...r }).changes;
    return inserted;
  });

  // One transaction so a mid-delete failure can't leave a wallet whose row is
  // gone but whose fills, snapshots, and alerts remain.
  const deleteWalletTxn = db.transaction((address) => {
    stmts.removeWallet.run(address);
    stmts.removeSnapshots.run(address);
    stmts.removeFills.run(address);
    stmts.removeFunding.run(address);
    stmts.removeAlerts.run(address);
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
    // SQLite's upsert reports a change for both an insert and a no-op update, so
    // counts are derived from before/after totals instead of from `changes`.
    backfillFills(address, rows) {
      if (!rows?.length) return { scanned: 0, inserted: 0, enriched: 0 };
      const beforeTotal = stmts.countFillsAll.get(address).n;
      const beforeIncomplete = stmts.countIncomplete.get(address).n;
      backfillTxn(address, rows);
      const afterTotal = stmts.countFillsAll.get(address).n;
      const afterIncomplete = stmts.countIncomplete.get(address).n;
      const inserted = afterTotal - beforeTotal;
      // Pre-existing rows that went from missing something to complete. Floored at
      // 0 because a newly inserted row that is itself incomplete raises the after
      // count; that under-reports rather than going negative.
      const enriched = Math.max(0, beforeIncomplete - afterIncomplete);
      return { scanned: rows.length, inserted, enriched };
    },
    cumulativeRealized(address) { return stmts.cumulativeRealized.get(address).total; },
    listFills(address, { limit = 50, offset = 0, closesOnly = false } = {}) {
      return (closesOnly ? stmts.listFillsCloses : stmts.listFillsAll).all(address, limit, offset);
    },
    countFills(address, { closesOnly = false } = {}) {
      return (closesOnly ? stmts.countFillsCloses : stmts.countFillsAll).get(address).n;
    },
    getHistory(address, since = 0) { return stmts.getHistory.all(address, since); },
    // Returns the number of rows actually inserted (duplicates are ignored).
    ingestFunding(address, rows) { return rows?.length ? ingestFundingTxn(address, rows) : 0; },
    listFunding(address, from = 0, to = Number.MAX_SAFE_INTEGER) { return stmts.listFunding.all(address, from, to); },
    listFillsRange(address, from = 0, to = Number.MAX_SAFE_INTEGER) {
      return stmts.listFillsRange.all(address, from, to);
    },
    // Oldest and newest event across both tables, for building the year picker.
    getRange(address) {
      const f = stmts.rangeFills.get(address);
      const g = stmts.rangeFunding.get(address);
      const lows = [f.lo, g.lo].filter((v) => v != null);
      const highs = [f.hi, g.hi].filter((v) => v != null);
      return { minTs: lows.length ? Math.min(...lows) : null, maxTs: highs.length ? Math.max(...highs) : null };
    },
    // Returns true if a snapshot was written, false if throttled.
    insertSnapshotThrottled(address, point, minIntervalMs) {
      const last = stmts.lastSnapshotTs.get(address).ts;
      if (last != null && point.ts - last < minIntervalMs) return false;
      stmts.insertSnapshot.run({ address, ...point });
      return true;
    },
    createAlert({ address, scope, coin = null, metric, operator, threshold }) {
      const info = stmts.insertAlert.run({ address, scope, coin, metric, operator, threshold, now: Date.now() });
      return stmts.getAlert.get(info.lastInsertRowid);
    },
    listAlerts(address) { return stmts.listAlerts.all(address); },
    listEnabledAlerts(address) { return stmts.listEnabledAlerts.all(address); },
    alertAddresses() { return stmts.alertAddresses.all().map((r) => r.address); },
    // Returns the updated row, or null if there is no such alert.
    updateAlert(id, { enabled, threshold } = {}) {
      stmts.updateAlert.run({
        id,
        // better-sqlite3 rejects booleans and undefined bindings outright, so both
        // are normalized here rather than at every call site.
        enabled: enabled == null ? null : (enabled ? 1 : 0),
        threshold: threshold == null ? null : Number(threshold),
      });
      return stmts.getAlert.get(id) ?? null;
    },
    deleteAlert(id) { return stmts.deleteAlert.run(id).changes > 0; },
    // Returns true if the write landed, false if the rule changed underneath us
    // (patched, or written by an overlapping evaluation) — in which case the newer
    // state wins and this pass's conclusion is stale.
    saveAlertResult(id, { prevState = null, lastState = null, attemptAt = null, firedAt = null } = {}) {
      return stmts.saveAlertResult.run({ id, prevState, lastState, attemptAt, firedAt }).changes > 0;
    },
    saveAlertAttempt(id, attemptAt) { stmts.saveAlertAttempt.run({ id, attemptAt }); },
  };
}
