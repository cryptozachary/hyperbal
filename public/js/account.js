import { fmtUsd, fmtNum, cls, esc, changeReadout } from './format.js';
import { drawSparkline } from './chart.js';
import { rangeChange } from './chart-math.js';

const $ = (id) => document.getElementById(id);

// Matches chart.js's own pattern for turning CSS custom properties into colors a
// canvas can use directly — kept independent of chart.js's internal COLORS so this
// module doesn't reach into another module's private state.
const CSS = getComputedStyle(document.documentElement);
const token = (name, fallback) => (CSS.getPropertyValue(name) || '').trim() || fallback;
// Captured once at module load — matches chart.js's own COLORS pattern, but note
// this means these three would go stale if a light/dark toggle is ever added;
// that would need live token() reads per paint instead of a frozen object.
const SPARK_COLOR = { pos: token('--pos', '#1fd09a'), neg: token('--neg', '#ff5d6c'), muted: token('--muted', '#8a97b1') };

export function render(d) {
  $('equity').textContent = fmtUsd(d.equity);
  $('uPnl').textContent = fmtUsd(d.totalUnrealizedPnl);
  $('uPnl').className = 'card-value ' + cls(d.totalUnrealizedPnl);
  $('rPnl').textContent = fmtUsd(d.realizedPnlCumulative);
  $('rPnl').className = 'card-value ' + cls(d.realizedPnlCumulative);
  // Provenance note, not a trend — how much of the cumulative figure above came
  // from Hyperliquid's recent-fills window. Distinct from rPnlDelta (the 24h
  // change, painted separately by renderSparks once the sparkline history
  // arrives): this one is available immediately from the account payload.
  $('rPnlRecent').textContent =
    d.realizedPnlRecent != null ? `recent window: ${fmtUsd(d.realizedPnlRecent)}` : '';
  $('posCount').textContent = d.openPositionsCount ?? 0;

  const positions = d.positions || [];
  const longs = positions.filter((p) => p.side === 'LONG').length;
  $('posSplit').textContent = positions.length ? `${longs} long · ${positions.length - longs} short` : '';

  const tbody = $('positions').querySelector('tbody');
  tbody.innerHTML = '';
  $('emptyState').classList.toggle('hidden', positions.length > 0);
  for (const p of positions) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="coin">${esc(p.coin ?? '—')}</span>${p.collateral ? `<span class="coin-dex"> · ${esc(p.collateral)}</span>` : ''}</td>
      <td><span class="chip ${p.side === 'LONG' ? 'chip-long' : p.side === 'SHORT' ? 'chip-short' : 'chip-flat'}">${p.side ?? '—'}</span></td>
      <td>${fmtNum(p.size)}</td>
      <td>${fmtNum(p.entryPrice, 2)}</td>
      <td>${fmtNum(p.markPrice, 2)}</td>
      <td>${fmtNum(p.liquidationPrice, 2)}</td>
      <td>${p.leverage != null ? p.leverage + 'x' : '—'}</td>
      <td>${fmtUsd(p.marginUsed)}</td>
      <td class="${cls(p.unrealizedPnl)}">${fmtUsd(p.unrealizedPnl)}</td>
      <td class="${cls(p.roe)}">${p.roe != null ? p.roe.toFixed(2) + '%' : '—'}</td>`;
    tbody.appendChild(tr);
  }
}

// Live realized PnL arrives over the socket without a full account payload.
export function setRealized(value) {
  $('rPnl').textContent = fmtUsd(value);
  $('rPnl').className = 'card-value ' + cls(value);
}

function renderDelta(elId, values) {
  const el = $(elId);
  if (!el) return;
  const r = changeReadout(rangeChange(values), '24h');
  el.textContent = r.text;
  el.className = ('card-sub ' + r.cls).trim();
}

function spark(canvasId, values) {
  const finite = values.filter((v) => v != null && Number.isFinite(v));
  let color = SPARK_COLOR.pos; // fewer than 2 points: no trend to speak of, same
                                // default chart.js itself uses for a single dot
  if (finite.length >= 2) {
    const delta = finite[finite.length - 1] - finite[0];
    // Match changeReadout's tie-break: a flat run (delta exactly 0) reads as the
    // neutral `·`, not the up arrow, so it shouldn't paint green either.
    color = delta > 0 ? SPARK_COLOR.pos : delta < 0 ? SPARK_COLOR.neg : SPARK_COLOR.muted;
  }
  drawSparkline($(canvasId), values, color);
}

// Cached so a resize can repaint without re-fetching — the points came from a
// network round trip (see app.js's loadSparks); a resize is purely a layout event
// and shouldn't imply fresh data.
let lastSparkPoints = [];

function paintSparks() {
  spark('equitySpark', lastSparkPoints.map((p) => p.equity));
  spark('uPnlSpark', lastSparkPoints.map((p) => p.unrealized_pnl));
  spark('rPnlSpark', lastSparkPoints.map((p) => p.realized_pnl_cum));
}

// `points` is a 24h-scoped snapshot list app.js fetches with its own
// api.getHistory call, separate from the chart panel's range-scoped history —
// that's what keeps these deltas fixed at 24h regardless of the chart's range
// pill. This resolves strictly after render(d) (a separate network round trip),
// so it's kept as its own function rather than folded into render() — render()
// stays a pure function of the account payload, and the cards don't get painted
// twice per refresh.
export function renderSparks(points) {
  lastSparkPoints = points || [];
  renderDelta('equityDelta', lastSparkPoints.map((p) => p.equity));
  renderDelta('uPnlDelta', lastSparkPoints.map((p) => p.unrealized_pnl));
  renderDelta('rPnlDelta', lastSparkPoints.map((p) => p.realized_pnl_cum));
  paintSparks();
}

// The sparklines need a redraw on resize, same as the main chart, but unlike the
// chart they don't need fresh data — just a repaint of what's already cached. One
// listener for all three canvases (not one per canvas), coalesced through rAF the
// same way chart.js debounces its own resize handler.
let resizeFrame = null;
window.addEventListener('resize', () => {
  if (resizeFrame != null) return;
  resizeFrame = requestAnimationFrame(() => { resizeFrame = null; paintSparks(); });
});

// Clears just the trend-bearing pieces — the 24h deltas, the sparklines, and the
// cache resize repaints from — without touching the card values or the position
// table. Called by reset() below, and also by app.js at the top of every wallet
// switch: render(d) repaints the values synchronously, but renderSparks() only
// arrives after a second, separate network round trip that can be slow or can
// fail outright. Without this, a switch (or a delete-and-select-next) would
// otherwise leave the previous wallet's deltas/sparklines sitting under the new
// wallet's numbers — at full opacity once loading clears — until the next
// successful refresh happens to overwrite them.
export function clearTrends() {
  for (const id of ['equityDelta', 'uPnlDelta', 'rPnlDelta']) {
    const el = $(id);
    el.textContent = '';
    el.className = 'card-sub';
  }
  lastSparkPoints = [];
  for (const id of ['equitySpark', 'uPnlSpark', 'rPnlSpark']) {
    const c = $(id);
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }
}

export function reset() {
  for (const id of ['equity', 'uPnl', 'rPnl']) {
    $(id).textContent = '—';
    $(id).className = 'card-value';
  }
  $('posCount').textContent = '—';
  $('posSplit').textContent = '';
  $('posSplit').className = 'card-sub';
  $('rPnlRecent').textContent = '';
  clearTrends();
  $('positions').querySelector('tbody').innerHTML = '';
  $('emptyState').classList.remove('hidden');
}
