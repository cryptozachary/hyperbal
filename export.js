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

// RFC 4180: quote anything containing a comma, quote or newline; double internal
// quotes. Builder dexes name their own markets, so don't assume coin names stay
// comma-free.
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const isoUtc = (ts) => new Date(ts).toISOString();

// 'sv-SE' yields a sortable "YYYY-MM-DD HH:mm:ss" rather than a locale-specific
// format, which matters for a file someone will sort in a spreadsheet. An invalid
// IANA name throws, so fall back rather than failing the whole export.
function localTime(ts, tz) {
  try {
    return new Date(ts).toLocaleString('sv-SE', { timeZone: tz });
  } catch {
    return new Date(ts).toLocaleString('sv-SE', { timeZone: 'UTC' });
  }
}

// `preamble` is an optional list of comment lines emitted above the header, each
// prefixed with '#' — the widely-recognised CSV comment convention (pandas
// `comment='#'`, R `comment.char='#'`). Used for the detailed export only; a
// vendor import must start at the header row.
export function toCsv(rows, columns, preamble = []) {
  const lines = preamble.map((l) => `# ${l}`);
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
      notional: (f.px != null && f.sz != null) ? f.px * f.sz : '',
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
    const feeTotal = (f.fee ?? 0) + (f.builder_fee ?? 0);
    rows.push({
      _ts: f.ts,
      Date: localTime(f.ts, tz),
      'Sent Amount': pnl < 0 ? Math.abs(pnl) : '',
      'Sent Currency': pnl < 0 ? 'USDC' : '',
      'Received Amount': pnl > 0 ? pnl : '',
      'Received Currency': pnl > 0 ? 'USDC' : '',
      'Fee Amount': feeTotal || '',
      'Fee Currency': feeTotal ? (f.fee_token || 'USDC') : '',
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
