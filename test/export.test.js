import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, buildPreamble, buildDetailedRows, buildKoinlyRows, DETAILED_COLUMNS, KOINLY_COLUMNS } from '../export.js';

const FILL = { tid: 1, coin: 'BTC', closed_pnl: 12.5, fee: 0.331490, builder_fee: 0.231488,
  fee_token: 'USDC', px: 81224, sz: 0.00285, side: 'A', dir: 'Close Long',
  hash: '0xabc123', oid: 422020718303, ts: Date.parse('2026-05-12T10:00:00Z') };
const FUND = { ts: Date.parse('2026-05-12T11:00:00Z'), coin: 'ETH', usdc: -0.00982,
  funding_rate: 0.0000125, szi: 130 };

test('toCsv escapes commas, quotes and newlines', () => {
  const csv = toCsv([{ a: 'x,y', b: 'say "hi"', c: 'line1\nline2', d: 'plain' }], ['a', 'b', 'c', 'd']);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'a,b,c,d');
  assert.equal(lines[1], '"x,y","say ""hi""","line1\nline2",plain');
});

test('toCsv renders null and undefined as empty, not as the strings', () => {
  const csv = toCsv([{ a: null, b: undefined, c: 0 }], ['a', 'b', 'c']);
  assert.equal(csv.split('\r\n')[1], ',,0');
});

test('toCsv with no rows still emits the header', () => {
  const csv = toCsv([], ['a', 'b']);
  assert.equal(csv, 'a,b\r\n');
});

test('toCsv emits a comment preamble above the header when given one', () => {
  const csv = toCsv([{ a: 1 }], ['a'], ['wallet: 0xabc', 'timezone: UTC']);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], '# wallet: 0xabc');
  assert.equal(lines[1], '# timezone: UTC');
  assert.equal(lines[2], 'a', 'header follows the preamble');
  assert.equal(lines[3], '1');
});

test('buildPreamble records wallet, range, timezone and the not-tax-advice note', () => {
  const lines = buildPreamble({
    address: '0xabc', from: Date.parse('2026-01-01T00:00:00Z'),
    to: Date.parse('2027-01-01T00:00:00Z'), tz: 'UTC', generatedAt: Date.parse('2026-08-11T12:00:00Z'),
  });
  const text = lines.join('\n');
  assert.match(text, /wallet: 0xabc/);
  assert.match(text, /timezone:\s+UTC/);
  assert.match(text, /not tax advice/);
  assert.match(text, /2026-01-01/);
});

test('buildPreamble renders unbounded ranges as "all"', () => {
  const text = buildPreamble({ address: '0xabc', from: null, to: null, tz: 'UTC', generatedAt: 0 }).join('\n');
  assert.match(text, /range from: all/);
  assert.match(text, /range to:\s+all/);
});

test('detailed rows merge fills and funding chronologically', () => {
  const rows = buildDetailedRows([FILL], [FUND], 'UTC');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, 'fill');
  assert.equal(rows[1].type, 'funding');
  assert.ok(rows[0].time_utc < rows[1].time_utc);
});

test('detailed fill row carries an explorer link and full precision', () => {
  const [row] = buildDetailedRows([FILL], [], 'UTC');
  assert.equal(row.explorer_url, 'https://app.hyperliquid.xyz/explorer/tx/0xabc123');
  assert.equal(row.order_id, 422020718303);
  assert.equal(row.fee, 0.331490);
  assert.equal(row.builder_fee, 0.231488);
  assert.equal(row.realized_pnl, 12.5);
  assert.equal(row.direction, 'Close Long');
  // notional is derived, not stored
  assert.equal(row.notional, 81224 * 0.00285);
});

test('funding rows have no explorer link', () => {
  const [row] = buildDetailedRows([], [FUND], 'UTC');
  assert.equal(row.type, 'funding');
  assert.equal(row.explorer_url, '');
  assert.equal(row.tx_hash, '');
  assert.equal(row.funding, -0.00982);
  assert.equal(row.realized_pnl, '');
});

test('a zero-filled hash produces no link', () => {
  const zeroHash = { ...FILL, hash: '0x' + '0'.repeat(64) };
  const [row] = buildDetailedRows([zeroHash], [], 'UTC');
  assert.equal(row.explorer_url, '');
  assert.equal(row.tx_hash, '');
});

test('a legacy fill with no dir falls back to side', () => {
  const [buy] = buildDetailedRows([{ ...FILL, dir: null, side: 'B' }], [], 'UTC');
  const [sell] = buildDetailedRows([{ ...FILL, dir: null, side: 'A' }], [], 'UTC');
  assert.equal(buy.direction, 'Buy');
  assert.equal(sell.direction, 'Sell');
});

test('time_local honours the requested timezone', () => {
  const [utc] = buildDetailedRows([FILL], [], 'UTC');
  const [ny] = buildDetailedRows([FILL], [], 'America/New_York');
  assert.notEqual(utc.time_local, ny.time_local);
  assert.ok(utc.time_local.startsWith('2026-05-12 10:00'));
  assert.ok(ny.time_local.startsWith('2026-05-12 06:00'), `got ${ny.time_local}`);
});

test('an invalid timezone falls back instead of throwing', () => {
  const [row] = buildDetailedRows([FILL], [], 'Not/AZone');
  assert.ok(row.time_local.startsWith('2026-05-12 10:00'), `got ${row.time_local}`);
});

test('detailed rows use the declared column set', () => {
  const [row] = buildDetailedRows([FILL], [], 'UTC');
  for (const c of DETAILED_COLUMNS) assert.ok(c in row, `missing column ${c}`);
  assert.equal(Object.keys(row).length, DETAILED_COLUMNS.length, 'no stray keys leak into the row');
});

test('koinly rows split gains and losses across sent/received', () => {
  const gain = buildKoinlyRows([FILL], [], 'UTC');
  assert.equal(gain[0]['Received Amount'], 12.5);
  assert.equal(gain[0]['Received Currency'], 'USDC');
  assert.equal(gain[0]['Sent Amount'], '');
  // total fee is exchange fee plus builder fee
  assert.equal(gain[0]['Fee Amount'], 0.331490 + 0.231488);
  assert.equal(gain[0]['TxHash'], '0xabc123');

  const loss = buildKoinlyRows([{ ...FILL, closed_pnl: -4 }], [], 'UTC');
  assert.equal(loss[0]['Sent Amount'], 4);
  assert.equal(loss[0]['Received Amount'], '');
});

test('koinly funding rows label paid funding as a cost', () => {
  const paid = buildKoinlyRows([], [FUND], 'UTC');
  assert.equal(paid[0]['Sent Amount'], 0.00982);
  assert.equal(paid[0].Label, 'margin fee');
  const received = buildKoinlyRows([], [{ ...FUND, usdc: 0.5 }], 'UTC');
  assert.equal(received[0]['Received Amount'], 0.5);
  assert.equal(received[0].Label, 'realized gain');
});

test('koinly rows use the declared column set', () => {
  const [row] = buildKoinlyRows([FILL], [], 'UTC');
  for (const c of KOINLY_COLUMNS) assert.ok(c in row, `missing column ${c}`);
  assert.equal(Object.keys(row).length, KOINLY_COLUMNS.length, 'no stray keys leak into the row');
});

test('detailed CSV totals reconcile with the source rows', async () => {
  const { openDb } = await import('../db.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const db = openDb(path.join(os.tmpdir(), `hl-recon-${Date.now()}-${Math.random().toString(16).slice(2)}.db`));
  const A = '0x' + 'c'.repeat(40);

  db.ingestFills(A, [
    { tid: 1, coin: 'BTC', closed_pnl: 12.5, fee: 0.33149, builder_fee: 0.231488, fee_token: 'USDC',
      px: 81224, sz: 0.00285, side: 'A', dir: 'Close Long', hash: '0xa', oid: 1, ts: 100 },
    { tid: 2, coin: 'ETH', closed_pnl: -4.25, fee: 0.1, builder_fee: 0.05, fee_token: 'USDC',
      px: 3000, sz: 0.1, side: 'B', dir: 'Close Short', hash: '0xb', oid: 2, ts: 200 },
  ]);
  db.ingestFunding(A, [{ ts: 150, coin: 'BTC', usdc: -0.00982, funding_rate: 0.0000125, szi: 130 }]);

  const rows = buildDetailedRows(db.listFillsRange(A), db.listFunding(A), 'UTC');
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);

  assert.equal(rows.length, 3);
  assert.equal(sum('realized_pnl'), 12.5 - 4.25);
  assert.equal(sum('fee'), 0.33149 + 0.1);
  assert.equal(sum('builder_fee'), 0.231488 + 0.05);
  assert.equal(sum('funding'), -0.00982);
  // the merged order is chronological across both tables
  assert.deepEqual(rows.map((r) => r.type), ['fill', 'funding', 'fill']);
});
