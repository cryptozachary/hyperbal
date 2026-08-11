// CSV generation for tax export. Pure — no DB, no Express, no network.

// Funding entries carry an all-zero hash because they're internal ledger events,
// not on-chain transactions. Linking one would produce a URL that 404s.
const ZERO_HASH = '0x' + '0'.repeat(64);
const EXPLORER = 'https://app.hyperliquid.xyz/explorer/tx/';

export const DETAILED_COLUMNS = [
  'time_utc', 'time_local', 'type', 'coin', 'direction', 'size', 'price', 'notional',
  'fee', 'builder_fee', 'fee_token', 'funding', 'realized_pnl', 'order_id', 'tx_hash', 'explorer_url',
];

export const KOINLY_COLUMNS = [
  'Date', 'Sent Amount', 'Sent Currency', 'Received Amount', 'Received Currency',
  'Fee Amount', 'Fee Currency', 'Net Worth Amount', 'Net Worth Currency',
  'Label', 'Description', 'TxHash',
];

// A spreadsheet treats a cell opening with one of these as a formula, so a coin
// name is an injection vector into whatever the user opens this file with.
const FORMULA_LEAD = /^[=+@\t\r]/;

// String(0.0000001) is "1e-7". Exponential notation in a tax file reads as
// corruption and defeats naive decimal parsers, so render small magnitudes in
// fixed notation. This changes the TEXT, never the value: toFixed(20) is exact
// well past the precision of anything Hyperliquid reports, and trailing zeros
// are stripped rather than rounded away.
function numCell(n) {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  if (!Number.isFinite(n)) return s;
  return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

// RFC 4180: quote anything containing a comma, quote or newline; double internal
// quotes. Builder dexes name their own markets, so don't assume coin names stay
// comma-free — or formula-free.
function csvCell(v) {
  if (v == null) return '';
  // Numbers are generated here, never user-supplied, so they skip the formula
  // guard — otherwise every negative PnL would be quoted into a text cell.
  if (typeof v === 'number') return numCell(v);
  let s = String(v);
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Callers can pass an out-of-range epoch; Date.toISOString throws on those rather
// than returning something useless, which would surface as an unhandled 500.
function isoUtc(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

// 'sv-SE' yields a sortable "YYYY-MM-DD HH:mm:ss" rather than a locale-specific
// format, which matters for a file someone will sort in a spreadsheet. An invalid
// IANA name throws, so fall back rather than failing the whole export.
function localTime(ts, tz) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('sv-SE', { timeZone: tz });
  } catch {
    return d.toLocaleString('sv-SE', { timeZone: 'UTC' });
  }
}

// True only for a timezone Intl actually accepts. The route uses this to reject a
// bogus zone rather than silently formatting in UTC while the file's preamble
// claims otherwise — on a document whose purpose is being self-describing, a
// quietly wrong timezone label is worse than an error.
export function isValidTimeZone(tz) {
  try {
    new Date(0).toLocaleString('sv-SE', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// `preamble` is an optional list of comment lines emitted above the header, each
// prefixed with '#' — the widely-recognised CSV comment convention (pandas
// `comment='#'`, R `comment.char='#'`). Used for the detailed export only; a
// vendor import must start at the header row.
export function toCsv(rows, columns, preamble = []) {
  // Preamble content can carry user input (the timezone name). A newline inside it
  // would break out of the comment block and be read as the header row, so flatten
  // any line break rather than trusting the caller.
  const lines = preamble.map((l) => `# ${String(l).replace(/[\r\n]+/g, ' ')}`);
  lines.push(columns.map(csvCell).join(','));
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

// Makes the file self-describing months later: which wallet, which range, and —
// critically — which timezone the range was computed in.
export function buildPreamble({ address, from, to, tz, generatedAt }) {
  const bound = (v) => (v == null ? 'all' : `${isoUtc(v)} (${localTime(v, tz)} ${tz})`);
  return [
    `Hyperliquid trade export`,
    `wallet: ${address}`,
    `range from: ${bound(from)}`,
    `range to:   ${bound(to)}`,
    `timezone:   ${tz}`,
    `generated:  ${isoUtc(generatedAt)}`,
    `NOTE: transaction data, not tax advice. Coverage begins when this dashboard`,
    `      first observed the wallet. Reconcile against your own records.`,
  ];
}

const explorerUrl = (hash) => (hash && hash !== ZERO_HASH ? EXPLORER + hash : '');
const realHash = (hash) => (hash && hash !== ZERO_HASH ? hash : '');

// fills/funding: rows as stored. Returns one row per event, oldest first.
export function buildDetailedRows(fills, funding, tz) {
  const rows = [];

  for (const f of fills) {
    rows.push({
      _ts: f.ts,
      time_utc: isoUtc(f.ts),
      time_local: localTime(f.ts, tz),
      type: 'fill',
      coin: f.coin ?? '',
      direction: f.dir || (f.side === 'B' ? 'Buy' : f.side === 'A' ? 'Sell' : ''),
      size: f.sz ?? '',
      price: f.px ?? '',
      // Derived, not stored. Rounded to 8dp purely so float noise doesn't put
      // "0.30000000000000004" in a tax document; the stored columns it's derived
      // from are untouched, so reconciliation is unaffected.
      notional: (f.px != null && f.sz != null) ? Number((f.px * f.sz).toFixed(8)) : '',
      fee: f.fee ?? '',
      builder_fee: f.builder_fee ?? '',
      fee_token: f.fee_token ?? '',
      funding: '',
      realized_pnl: f.closed_pnl ?? '',
      order_id: f.oid ?? '',
      tx_hash: realHash(f.hash),
      explorer_url: explorerUrl(f.hash),
    });
  }

  for (const x of funding) {
    rows.push({
      _ts: x.ts,
      time_utc: isoUtc(x.ts),
      time_local: localTime(x.ts, tz),
      type: 'funding',
      coin: x.coin ?? '',
      direction: '',
      size: '',
      price: '',
      notional: '',
      fee: '',
      builder_fee: '',
      fee_token: '',
      funding: x.usdc ?? '',
      realized_pnl: '',
      order_id: '',
      tx_hash: '',
      explorer_url: '',
    });
  }

  rows.sort((a, b) => a._ts - b._ts);
  for (const r of rows) delete r._ts;
  return rows;
}

// Best-effort mapping onto Koinly's generic CSV. Koinly's model is built around
// acquiring and disposing of a held asset; a perp fill is neither, so a realized
// gain is represented as a bare USDC inflow/outflow with no cost basis. Treat the
// detailed export as the source of truth and verify this before importing.
export function buildKoinlyRows(fills, funding, tz) {
  const rows = [];

  for (const f of fills) {
    const pnl = f.closed_pnl ?? 0;
    // Maker rebates make the exchange fee negative. Koinly's Fee Amount can't
    // express a credit, so fold a net-negative fee into the received side rather
    // than emitting a negative fee it would reject or misread.
    const feeTotal = (f.fee ?? 0) + (f.builder_fee ?? 0);
    const rebate = feeTotal < 0 ? -feeTotal : 0;
    const received = (pnl > 0 ? pnl : 0) + rebate;
    rows.push({
      _ts: f.ts,
      Date: localTime(f.ts, tz),
      'Sent Amount': pnl < 0 ? Math.abs(pnl) : '',
      'Sent Currency': pnl < 0 ? 'USDC' : '',
      'Received Amount': received > 0 ? received : '',
      'Received Currency': received > 0 ? 'USDC' : '',
      'Fee Amount': feeTotal > 0 ? feeTotal : '',
      'Fee Currency': feeTotal > 0 ? (f.fee_token || 'USDC') : '',
      'Net Worth Amount': '',
      'Net Worth Currency': '',
      Label: 'realized gain',
      Description: `${f.dir || f.side || ''} ${f.coin ?? ''} ${f.sz ?? ''} @ ${f.px ?? ''}`.trim(),
      TxHash: realHash(f.hash),
    });
  }

  for (const x of funding) {
    const usdc = x.usdc ?? 0;
    rows.push({
      _ts: x.ts,
      Date: localTime(x.ts, tz),
      'Sent Amount': usdc < 0 ? Math.abs(usdc) : '',
      'Sent Currency': usdc < 0 ? 'USDC' : '',
      'Received Amount': usdc > 0 ? usdc : '',
      'Received Currency': usdc > 0 ? 'USDC' : '',
      'Fee Amount': '',
      'Fee Currency': '',
      'Net Worth Amount': '',
      'Net Worth Currency': '',
      Label: usdc < 0 ? 'margin fee' : 'realized gain',
      Description: `Funding ${x.coin ?? ''}`.trim(),
      TxHash: '',
    });
  }

  rows.sort((a, b) => a._ts - b._ts);
  for (const r of rows) delete r._ts;
  return rows;
}
