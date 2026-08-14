// Pure formatters. No DOM access anywhere in this file — node:test imports it directly.

export const fmtUsd = (n) =>
  n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

export const fmtNum = (n, d = 4) =>
  n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });

export const fmtPct = (n, d = 2) =>
  n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;

export const fmtTime = (ts) => (ts == null ? '—' : new Date(ts).toLocaleString());

const trimUnit = (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v))).replace(/\.0$/, '');

// Axis labels need to fit in ~40px, so full currency formatting won't do. Thresholds sit
// at the point where trimUnit's rounding flips to the next unit, not at the round number
// itself, so e.g. 999999 reads as $1M rather than $1000k.
export const fmtCompact = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a === 0) return '$0';
  if (a >= 999.5e6) return `${sign}$${trimUnit(a / 1e9)}B`;
  if (a >= 999.5e3) return `${sign}$${trimUnit(a / 1e6)}M`;
  if (a >= 999.5) return `${sign}$${trimUnit(a / 1e3)}k`;
  return `${sign}$${a < 10 ? a.toFixed(2) : String(Math.round(a))}`;
};

// The x axis means something different at 24h than at two years, so the label follows the span.
export const fmtAxisTime = (ts, spanMs) => {
  if (ts == null || !Number.isFinite(spanMs)) return '—';
  const d = new Date(ts);
  if (spanMs <= 36 * 3600e3) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (spanMs <= 400 * 86400e3) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
};

export const cls = (n) => (n == null ? '' : n > 0 ? 'pos' : n < 0 ? 'neg' : '');

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
