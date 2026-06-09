import { getClearinghouseState, getUserFills, normalizeAccount, normalizeFills } from './hyperliquid.js';

// Fetch live HL data, persist fills + snapshot, return the normalized dashboard payload.
// `opts`: { fetchImpl?, apiUrl, snapshotMinIntervalMs }
export async function assembleAccount(address, db, opts) {
  const [cs, fills] = await Promise.all([
    getClearinghouseState(address, opts),
    getUserFills(address, opts),
  ]);

  const account = normalizeAccount(cs);
  const { rows, recentRealized } = normalizeFills(fills);

  db.ingestFills(address, rows);
  const realizedPnlCumulative = db.cumulativeRealized(address);

  db.upsertWallet(address);
  db.insertSnapshotThrottled(address, {
    ts: Date.now(),
    equity: account.equity,
    unrealized_pnl: account.totalUnrealizedPnl,
    realized_pnl_cum: realizedPnlCumulative,
    open_positions: account.openPositionsCount,
  }, opts.snapshotMinIntervalMs);

  return {
    address,
    ...account,
    realizedPnlCumulative,
    realizedPnlRecent: recentRealized,
    asOf: Date.now(),
    notes: 'Realized PnL is cumulative since this dashboard began observing fills.',
  };
}
