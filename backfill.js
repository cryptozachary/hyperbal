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

  return { scanned, inserted, pages, truncated };
}

// opts: { fetchFills, fetchFunding, from = 0, maxPages = MAX_PAGES }
export async function backfillWallet(address, db, opts) {
  const { fetchFills, fetchFunding, from = 0, maxPages = MAX_PAGES } = opts;

  // Same invariant as everywhere else: nothing is persisted for a wallet that
  // isn't on the watch list, so a backfill can't resurrect a deleted one.
  if (!db.hasWallet(address)) {
    return { address, skipped: true, fills: { scanned: 0, inserted: 0, enriched: 0 },
      funding: { scanned: 0, inserted: 0 }, from, truncated: false };
  }

  let enriched = 0;
  const fills = await pageForward(fetchFills, (rows) => {
    const r = db.backfillFills(address, rows);
    enriched += r.enriched;
    return r.inserted;
  }, from, maxPages);

  const funding = await pageForward(fetchFunding, (rows) => db.ingestFunding(address, rows), from, maxPages);

  return {
    address,
    skipped: false,
    fills: { scanned: fills.scanned, inserted: fills.inserted, enriched },
    funding: { scanned: funding.scanned, inserted: funding.inserted },
    from,
    truncated: fills.truncated || funding.truncated,
  };
}
