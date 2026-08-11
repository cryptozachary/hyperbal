// Paginated history sync for one wallet. Fetchers are injected so this is
// testable without network access and without Express.

const MAX_PAGES = 50;

// Pages one endpoint forward. `fetchPage(since)` returns normalized rows carrying
// a `ts`; `ingest(rows)` returns the number of rows actually inserted.
async function pageForward(fetchPage, ingest, from, maxPages) {
  let cursor = from;
  let scanned = 0, inserted = 0, pages = 0, truncated = false;

  while (true) {
    if (pages >= maxPages) { truncated = true; break; }
    const rows = await fetchPage(cursor);
    pages++;
    if (!Array.isArray(rows) || !rows.length) break;

    scanned += rows.length;
    const pageInserted = ingest(rows);
    inserted += pageInserted;

    const times = rows.map((r) => r.ts).filter(Number.isFinite);
    if (!times.length) break;
    const newest = Math.max(...times);

    // Advance to the newest timestamp, NOT newest + 1: several fills can share a
    // millisecond and +1 would skip the rest of them. The resulting overlap is
    // absorbed by the dedupe on insert.
    if (newest > cursor) { cursor = newest; continue; }

    // The cursor can't advance. If this page still brought new rows, try once
    // more — a repeat page inserts nothing and ends the loop on the next pass.
    // This assumes a page is never entirely filled by a single timestamp, which
    // holds at Hyperliquid's page size against realistic same-millisecond
    // clustering; if it ever didn't, the loop would stop early rather than spin.
    if (pageInserted === 0) break;
  }

  // `cursor` is returned so a truncated run can be resumed from where it stopped.
  // Without it a re-run restarts at 0, burns the same page budget on rows it
  // already has, and stops at exactly the same place — forever.
  return { scanned, inserted, pages, truncated, cursor };
}

// Each endpoint keeps its own cursor: one can truncate while the other completes,
// and resuming both from a single shared value would skip the completed one's tail.
// opts: { fetchFills, fetchFunding, fillsFrom = 0, fundingFrom = 0, maxPages = MAX_PAGES }
export async function backfillWallet(address, db, opts) {
  const { fetchFills, fetchFunding, fillsFrom = 0, fundingFrom = 0, maxPages = MAX_PAGES } = opts;

  const skippedResult = {
    address, skipped: true,
    fills: { scanned: 0, inserted: 0, enriched: 0, nextFrom: fillsFrom },
    funding: { scanned: 0, inserted: 0, nextFrom: fundingFrom },
    truncated: false,
  };

  // Same invariant as everywhere else: nothing is persisted for a wallet that
  // isn't on the watch list, so a backfill can't resurrect a deleted one.
  if (!db.hasWallet(address)) return skippedResult;

  let enriched = 0;
  // Re-checked inside each ingest rather than only up front: the wallet can be
  // deleted while this is awaiting a page, and writing after that would resurrect
  // exactly what the purge removed.
  const fills = await pageForward(fetchFills, (rows) => {
    if (!db.hasWallet(address)) return 0;
    const r = db.backfillFills(address, rows);
    enriched += r.enriched;
    return r.inserted;
  }, fillsFrom, maxPages);

  const funding = await pageForward(fetchFunding, (rows) => (
    db.hasWallet(address) ? db.ingestFunding(address, rows) : 0
  ), fundingFrom, maxPages);

  if (!db.hasWallet(address)) return skippedResult;

  return {
    address,
    skipped: false,
    fills: { scanned: fills.scanned, inserted: fills.inserted, enriched, nextFrom: fills.cursor },
    funding: { scanned: funding.scanned, inserted: funding.inserted, nextFrom: funding.cursor },
    truncated: fills.truncated || funding.truncated,
  };
}
