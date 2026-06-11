import { getClearinghouseState, getUserFills, getPerpDexs, getDexCollateral, normalizeAccount, normalizeFills, mergeAccounts } from './hyperliquid.js';

// Fetch live HL data across all perp dexs, persist fills + snapshot, return the
// normalized dashboard payload. `opts`: { fetchImpl?, apiUrl, snapshotMinIntervalMs }
export async function assembleAccount(address, db, opts) {
  const [dexs, collateral] = await Promise.all([getPerpDexs(opts), getDexCollateral(opts)]);
  const fillsPromise = getUserFills(address, opts);

  // One clearinghouseState per dex, in parallel; builder-dex failures are skipped.
  const settled = await Promise.allSettled(dexs.map((d) => getClearinghouseState(address, opts, d.name)));
  const perDex = [];
  for (let i = 0; i < dexs.length; i++) {
    const d = dexs[i];
    const r = settled[i];
    if (r.status === 'fulfilled') {
      perDex.push({ dex: d.name, collateral: collateral.get(d.name) ?? null, account: normalizeAccount(r.value) });
    } else if (d.name == null) {
      throw new Error(`Hyperliquid main dex error: ${r.reason?.message || r.reason}`);
    } else {
      console.warn(`Skipping dex ${d.name}: ${r.reason?.message || r.reason}`);
    }
  }

  const account = mergeAccounts(perDex);
  const { rows, recentRealized } = normalizeFills(await fillsPromise);

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
    notes: 'Totals span all Hyperliquid perp dexs; realized PnL is cumulative since this dashboard began observing fills.',
  };
}
