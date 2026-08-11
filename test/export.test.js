import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, buildPreamble, buildDetailedRows, buildKoinlyRows, isValidTimeZone, DETAILED_COLUMNS, KOINLY_COLUMNS } from '../export.js';

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

// --- regressions from the backend review ---

test('small magnitudes render in fixed notation, never exponential', () => {
  const rows = buildDetailedRows(
    [{ tid: 1, coin: 'BTC', closed_pnl: 0.00000012, fee: 1e-7, builder_fee: 0,
       px: 100, sz: 1, side: 'A', dir: 'x', hash: '0xa', oid: 1, ts: 100 }],
    [{ ts: 200, coin: 'ETH', usdc: -0.00000012, funding_rate: 0, szi: 1 }], 'UTC');
  const csv = toCsv(rows, DETAILED_COLUMNS);
  assert.ok(!/\de[+-]/i.test(csv), `exponential notation reached the file:\n${csv}`);
  assert.match(csv, /0\.0000001,/);
  assert.match(csv, /-0\.00000012/);
});

test('fixed notation preserves the value exactly', () => {
  const rows = buildDetailedRows(
    [{ tid: 1, coin: 'B', closed_pnl: 1.2e-7, fee: 0, builder_fee: 0, px: 1, sz: 1,
       side: 'A', dir: 'x', hash: '', oid: 1, ts: 100 }], [], 'UTC');
  const cell = toCsv(rows, DETAILED_COLUMNS).split('\r\n')[1].split(',')[12];
  assert.equal(Number(cell), 1.2e-7, 'round-trips to the same double');
});

test('a formula-leading coin name is neutralised', () => {
  const evil = '=HYPERLINK("http://evil","x")';
  const rows = buildDetailedRows(
    [{ tid: 1, coin: evil, closed_pnl: 1, fee: 0, builder_fee: 0, px: 1, sz: 1,
       side: 'A', dir: '@SUM(A1)', hash: '', oid: 1, ts: 100 }], [], 'UTC');
  const csv = toCsv(rows, DETAILED_COLUMNS);
  // the cell is quoted and its internal quotes doubled, so match the escaped form
  const escaped = `"'${evil.replace(/"/g, '""')}"`;
  assert.ok(csv.includes(escaped), `coin not neutralised:\n${csv}`);
  assert.ok(csv.includes("'@SUM(A1)"), 'direction not neutralised');
  // negative numbers must NOT be quoted into text cells by the same guard
  const neg = buildDetailedRows([{ tid: 2, coin: 'BTC', closed_pnl: -4.25, fee: 0,
    builder_fee: 0, px: 1, sz: 1, side: 'A', dir: 'x', hash: '', oid: 1, ts: 100 }], [], 'UTC');
  assert.match(toCsv(neg, DETAILED_COLUMNS), /,-4\.25,/);
});

test('a newline in the preamble cannot break out of the comment block', () => {
  const csv = toCsv([{ a: 1 }], ['a'], ['timezone: UTC\r\nINJECTED,row,here']);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], '# timezone: UTC INJECTED,row,here');
  assert.equal(lines[1], 'a', 'header is still the first non-comment line');
});

test('an out-of-range epoch yields an empty cell rather than throwing', () => {
  assert.doesNotThrow(() => buildPreamble({ address: '0xa', from: 9e15, to: null, tz: 'UTC', generatedAt: 0 }));
  const rows = buildDetailedRows([{ tid: 1, coin: 'B', closed_pnl: 1, fee: 0, builder_fee: 0,
    px: 1, sz: 1, side: 'A', dir: 'x', hash: '', oid: 1, ts: 9e15 }], [], 'UTC');
  assert.equal(rows[0].time_utc, '');
});

test('isValidTimeZone accepts IANA names and rejects junk', () => {
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone('Not/AZone'), false);
  assert.equal(isValidTimeZone('UTC\r\nINJECTED'), false);
});

test('koinly folds a maker rebate into received rather than a negative fee', () => {
  const [row] = buildKoinlyRows([{ tid: 1, coin: 'BTC', closed_pnl: 10, fee: -0.05,
    builder_fee: 0, fee_token: 'USDC', px: 1, sz: 1, side: 'A', dir: 'x', hash: '', oid: 1, ts: 100 }], [], 'UTC');
  assert.equal(row['Fee Amount'], '', 'no negative fee reaches Koinly');
  assert.equal(row['Received Amount'], 10.05, 'the rebate is credited instead');
});

test('a null builder_fee exports as empty, not as a fabricated zero', () => {
  const [row] = buildDetailedRows([{ tid: 1, coin: 'BTC', closed_pnl: 1, fee: 0.1,
    builder_fee: null, px: 1, sz: 1, side: 'A', dir: 'x', hash: '', oid: 1, ts: 100 }], [], 'UTC');
  assert.equal(row.builder_fee, '', 'unknown must not read as "no builder fee charged"');
});

// Minimal RFC 4180 reader — deliberately not reusing anything from export.js, so a
// bug in the writer can't cancel itself out against a matching bug in the reader.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

test('the emitted CSV TEXT reconciles with SQL over the same half-open range', async () => {
  const { openDb } = await import('../db.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const db = openDb(path.join(os.tmpdir(), `hl-csvrecon-${Date.now()}-${Math.random().toString(16).slice(2)}.db`));
  const A = '0x' + 'd'.repeat(40);
  const FROM = 1000, TO = 2000;

  db.ingestFills(A, [
    { tid: 1, coin: 'BTC', closed_pnl: 12.5, fee: 0.33149, builder_fee: 0.231488, fee_token: 'USDC',
      px: 81224, sz: 0.00285, side: 'A', dir: 'Close Long', hash: '0xa', oid: 1, ts: FROM },      // exactly on `from` — included
    { tid: 2, coin: 'xyz:SP,500', closed_pnl: -4.25, fee: -0.05, builder_fee: 0.05, fee_token: 'USDC',
      px: 3000, sz: 0.1, side: 'B', dir: 'Close Short', hash: '0xb', oid: 2, ts: 1500 },          // comma in coin, maker rebate
    { tid: 3, coin: '=EVIL()', closed_pnl: 0.00000012, fee: 1e-7, builder_fee: null, fee_token: null,
      px: 1, sz: 1, side: 'B', dir: null, hash: null, oid: null, ts: 1800 },                      // formula, sub-microdollar, legacy nulls
    { tid: 4, coin: 'ETH', closed_pnl: 999, fee: 9, builder_fee: 9, fee_token: 'USDC',
      px: 1, sz: 1, side: 'A', dir: 'x', hash: '0xd', oid: 4, ts: TO },                           // exactly on `to` — EXCLUDED
  ]);
  db.ingestFunding(A, [
    { ts: 1200, coin: 'BTC', usdc: -0.00982, funding_rate: 0.0000125, szi: 130 },
    { ts: 1900, coin: 'ETH', usdc: -0.00000012, funding_rate: 0.0000125, szi: 1 },
    { ts: TO, coin: 'SOL', usdc: 500, funding_rate: 0, szi: 1 },                                  // on `to` — EXCLUDED
  ]);

  const fills = db.listFillsRange(A, FROM, TO);
  const funding = db.listFunding(A, FROM, TO);
  const csv = toCsv(buildDetailedRows(fills, funding, 'UTC'), DETAILED_COLUMNS);

  const parsed = parseCsv(csv);
  const header = parsed[0];
  const body = parsed.slice(1);
  const col = (r, name) => r[header.indexOf(name)];
  const sumCol = (name) => body.reduce((s, r) => s + (Number(col(r, name)) || 0), 0);

  assert.equal(body.length, 5, '3 fills + 2 funding; the rows on `to` are excluded');

  // the numbers that would land on a tax return, read back out of the file itself
  const sqlPnl = fills.reduce((s, f) => s + f.closed_pnl, 0);
  const sqlFee = fills.reduce((s, f) => s + f.fee, 0);
  const sqlBuilder = fills.reduce((s, f) => s + (f.builder_fee ?? 0), 0);
  const sqlFunding = funding.reduce((s, f) => s + f.usdc, 0);
  assert.ok(Math.abs(sumCol('realized_pnl') - sqlPnl) < 1e-12, `pnl ${sumCol('realized_pnl')} vs ${sqlPnl}`);
  assert.ok(Math.abs(sumCol('fee') - sqlFee) < 1e-12, `fee ${sumCol('fee')} vs ${sqlFee}`);
  assert.ok(Math.abs(sumCol('builder_fee') - sqlBuilder) < 1e-12, `builder ${sumCol('builder_fee')} vs ${sqlBuilder}`);
  assert.ok(Math.abs(sumCol('funding') - sqlFunding) < 1e-12, `funding ${sumCol('funding')} vs ${sqlFunding}`);

  // The excluded boundary rows really are absent, not merely summing to zero.
  // Keyed on the timestamp rather than on a coin name or a substring: "xyz:SP,500"
  // contains "500", and an in-range funding row also uses the coin ETH.
  const onBound = new Date(TO).toISOString();
  assert.ok(!body.some((r) => col(r, 'time_utc') === onBound), '`to` must be exclusive');
  assert.ok(body.some((r) => col(r, 'time_utc') === new Date(FROM).toISOString()), '`from` must be inclusive');

  // hostile values survived the round trip intact
  const commaRow = body.find((r) => col(r, 'coin') === 'xyz:SP,500');
  assert.ok(commaRow, 'comma-bearing coin did not survive parsing');
  assert.equal(Number(col(commaRow, 'realized_pnl')), -4.25);
  assert.ok(body.some((r) => col(r, 'coin') === "'=EVIL()"), 'formula guard missing on round trip');
  assert.ok(!/\de[+-]/i.test(csv), 'exponential notation in the file');
  // a legacy NULL builder_fee reads as blank, never as a fabricated 0
  const legacy = body.find((r) => col(r, 'coin') === "'=EVIL()");
  assert.equal(col(legacy, 'builder_fee'), '');
});
