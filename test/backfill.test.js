import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { backfillWallet } from '../backfill.js';

const A = '0x' + 'a'.repeat(40);
const freshDb = () => openDb(path.join(os.tmpdir(), `hl-bf-${Date.now()}-${Math.random().toString(16).slice(2)}.db`));
const fill = (tid, ts) => ({ tid, coin: 'BTC', closed_pnl: 1, fee: 0.1, px: 100, sz: 1,
  side: 'A', dir: 'Close Long', builder_fee: 0.05, hash: '0x' + tid, oid: tid, fee_token: 'USDC', ts });

test('pages forward and does not skip same-millisecond fills', async () => {
  const db = freshDb();
  db.upsertWallet(A, 'w');
  // Page size 3. tids 2 and 3 share a timestamp and straddle the page boundary —
  // advancing the cursor to newest + 1 would drop tid 3.
  const all = [fill(1, 100), fill(2, 200), fill(3, 200), fill(4, 300)];
  const calls = [];
  const fetchFills = async (since) => {
    calls.push(since);
    return all.filter((f) => f.ts >= since).slice(0, 3);
  };
  const res = await backfillWallet(A, db, { fetchFills, fetchFunding: async () => [] });

  assert.equal(res.fills.inserted, 4, 'every fill must land, including both at ts=200');
  assert.equal(db.countFills(A), 4);
  assert.ok(calls.includes(200), 'cursor advances TO the newest ts, not past it');
  assert.equal(res.truncated, false);
});

test('is idempotent', async () => {
  const db = freshDb();
  db.upsertWallet(A, 'w');
  const all = [fill(1, 100), fill(2, 200)];
  const fetchFills = async (since) => all.filter((f) => f.ts >= since);
  const opts = { fetchFills, fetchFunding: async () => [] };

  const first = await backfillWallet(A, db, opts);
  const second = await backfillWallet(A, db, opts);
  assert.equal(first.fills.inserted, 2);
  assert.equal(second.fills.inserted, 0, 'second run inserts nothing');
  assert.equal(db.countFills(A), 2);
});

test('terminates on a page that yields nothing new', async () => {
  const db = freshDb();
  db.upsertWallet(A, 'w');
  let calls = 0;
  // always returns the same single row — a naive loop would spin forever
  const fetchFills = async () => { calls++; return [fill(1, 100)]; };
  const res = await backfillWallet(A, db, { fetchFills, fetchFunding: async () => [] });
  assert.ok(calls <= 3, `expected quick termination, made ${calls} calls`);
  assert.equal(res.truncated, false);
  assert.equal(db.countFills(A), 1);
});

test('respects the page ceiling and reports truncation', async () => {
  const db = freshDb();
  db.upsertWallet(A, 'w');
  let n = 0;
  // an endless stream of genuinely new rows with advancing timestamps
  const fetchFills = async () => { n++; return [fill(n, n * 100)]; };
  const res = await backfillWallet(A, db, { fetchFills, fetchFunding: async () => [], maxPages: 5 });
  assert.equal(res.truncated, true);
  assert.equal(n, 5, 'stops at the ceiling');
});

test('syncs funding alongside fills', async () => {
  const db = freshDb();
  db.upsertWallet(A, 'w');
  const fund = [{ ts: 100, coin: 'BTC', usdc: -0.5, funding_rate: 0.00001, szi: 2 },
                { ts: 200, coin: 'BTC', usdc: -0.6, funding_rate: 0.00001, szi: 2 }];
  const res = await backfillWallet(A, db, {
    fetchFills: async () => [],
    fetchFunding: async (since) => fund.filter((f) => f.ts >= since),
  });
  assert.equal(res.funding.inserted, 2);
  assert.equal(db.listFunding(A).length, 2);
});

test('reports enriched rows', async () => {
  const db = freshDb();
  db.upsertWallet(A, 'w');
  // a legacy row with no dir
  db.ingestFills(A, [{ tid: 1, coin: 'BTC', closed_pnl: 1, fee: 0.1, px: 100, sz: 1, side: 'A', ts: 100 }]);
  const res = await backfillWallet(A, db, {
    fetchFills: async (since) => (since === 0 ? [fill(1, 100)] : []),
    fetchFunding: async () => [],
  });
  assert.equal(res.fills.enriched, 1);
  assert.equal(res.fills.inserted, 0);
});

test('refuses a wallet that is not on the watch list', async () => {
  const db = freshDb();
  const res = await backfillWallet(A, db, { fetchFills: async () => [fill(1, 100)], fetchFunding: async () => [] });
  assert.equal(res.skipped, true);
  assert.equal(db.countFills(A), 0, 'must not resurrect an unwatched wallet');
});
