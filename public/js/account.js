import { fmtUsd, fmtNum, cls, esc, changeReadout } from './format.js';
import { drawSparkline } from './chart.js';
import { rangeChange } from './chart-math.js';

const $ = (id) => document.getElementById(id);

// Matches chart.js's own pattern for turning CSS custom properties into colors a
// canvas can use directly — kept independent of chart.js's internal COLORS so this
// module doesn't reach into another module's private state.
const CSS = getComputedStyle(document.documentElement);
const token = (name, fallback) => (CSS.getPropertyValue(name) || '').trim() || fallback;
const SPARK_COLOR = { pos: token('--pos', '#1fd09a'), neg: token('--neg', '#ff5d6c') };

export function render(d) {
  $('equity').textContent = fmtUsd(d.equity);
  $('uPnl').textContent = fmtUsd(d.totalUnrealizedPnl);
  $('uPnl').className = 'card-value ' + cls(d.totalUnrealizedPnl);
  $('rPnl').textContent = fmtUsd(d.realizedPnlCumulative);
  $('rPnl').className = 'card-value ' + cls(d.realizedPnlCumulative);
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
      <td>${esc(p.coin ?? '—')}${p.collateral ? ` · ${esc(p.collateral)}` : ''}</td>
      <td class="${p.side === 'LONG' ? 'side-long' : 'side-short'}">${p.side ?? '—'}</td>
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
  const rising = finite.length < 2 || finite[finite.length - 1] >= finite[0];
  drawSparkline($(canvasId), values, rising ? SPARK_COLOR.pos : SPARK_COLOR.neg);
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

export function reset() {
  for (const id of ['equity', 'uPnl', 'rPnl']) {
    $(id).textContent = '—';
    $(id).className = 'card-value';
  }
  $('posCount').textContent = '—';
  for (const id of ['equityDelta', 'uPnlDelta', 'rPnlDelta', 'posSplit']) {
    const el = $(id);
    el.textContent = '';
    el.className = 'card-sub';
  }
  lastSparkPoints = [];
  for (const id of ['equitySpark', 'uPnlSpark', 'rPnlSpark']) {
    const c = $(id);
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }
  $('positions').querySelector('tbody').innerHTML = '';
  $('emptyState').classList.remove('hidden');
}
