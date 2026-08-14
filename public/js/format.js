// Pure formatters. No DOM access anywhere in this file — node:test imports it directly.

export const fmtUsd = (n) =>
  n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

export const fmtNum = (n, d = 4) =>
  n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });

export const fmtPct = (n, d = 2) =>
  n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;

export const fmtTime = (ts) => (ts == null ? '—' : new Date(ts).toLocaleString());

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

// Turns a chart-math `rangeChange()` result (or null, for < 2 points) into display
// text + a sign class. Shared by the chart panel's readout and (per Task 10) the
// card deltas, so the arrow/color tie-break at exactly zero and the pct===null
// (zero-base) case only need fixing in one place.
export function changeReadout(c, suffix) {
  if (!c) return { text: `— over ${suffix}`, cls: '' };
  const arrow = c.abs > 0 ? '▲' : c.abs < 0 ? '▼' : '·';
  const pct = c.pct == null ? '' : ` · ${fmtPct(c.pct)}`;
  return { text: `${arrow} ${fmtUsd(Math.abs(c.abs))}${pct} over ${suffix}`, cls: cls(c.abs) };
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
