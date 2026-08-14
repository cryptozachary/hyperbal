// Canvas chart. No library, per the project's stated constraint.
// Geometry lives in chart-math.js (pure, node-testable); this file owns the DOM/canvas
// side: it reads CSS custom properties at module scope, which is why chart-math.js
// can't just be inlined here and tested directly.

import { fmtCompact, fmtUsd, fmtAxisTime } from './format.js';
import {
  niceTicks, computeScales, nearestIndex, segments, rangeChange,
  pickXLabels, pointerToIndex, tooltipBox,
} from './chart-math.js';

// Re-exported so consumers have one import for chart concerns.
export {
  niceTicks, computeScales, nearestIndex, segments, rangeChange,
  pickXLabels, pointerToIndex, tooltipBox,
};

const CSS = getComputedStyle(document.documentElement);
const token = (name, fallback) => (CSS.getPropertyValue(name) || '').trim() || fallback;

const COLORS = {
  grid: token('--line', '#222b3d'),
  muted: token('--muted', '#8a97b1'),
  text: token('--text', '#e6ebf5'),
  pos: token('--pos', '#1fd09a'),
  neg: token('--neg', '#ff5d6c'),
};

const PAD = { padLeft: 52, padRight: 14, padTop: 18, padBottom: 26 };

const valueOf = (p, series) => (series === 'equity' ? p.equity : p.unrealized_pnl);

// fmtCompact is lossy above $999.50, so a narrow range (e.g. equity sitting near
// $2,008 with $10 of noise) collapses every tick to the same string — "$2k" five
// times tells the user nothing about a $400 move. Fall back to full precision for
// the whole axis when abbreviating would repeat a label; which formatter to use is
// the chart's call, not chart-math's, so this lives here rather than in niceTicks.
function tickLabels(ticks) {
  const compact = ticks.map(fmtCompact);
  return new Set(compact).size === compact.length ? compact : ticks.map(fmtUsd);
}

// The series being empty and there being no snapshots at all are different facts,
// and conflating them tells a user with a year of equity history to "wait for data"
// when they toggle to PnL and their early snapshots simply predate PnL capture.
function emptyMessage(total, drawable, series) {
  if (total === 0) return ['No snapshots yet.', 'Snapshots accrue while the dashboard is open.'];
  if (drawable === 0 && series === 'pnl') {
    return ['No unrealized PnL recorded.', 'Snapshots taken before PnL capture carry no value.'];
  }
  if (drawable === 0) return ['No values in this range.', 'Snapshots accrue while the dashboard is open.'];
  return [`Only ${drawable} point in this range.`, 'Snapshots accrue while the dashboard is open.'];
}

export function createChart(canvas) {
  let points = [];
  let opts = { series: 'equity' };

  function draw() {
    // An unlaid-out canvas (0 width/height — e.g. mid wallet-switch, or before the
    // panel has been given layout) would otherwise compute negative coordinates and
    // silently paint nothing. Bail rather than draw an invisible chart.
    if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    // Round, not truncate: at a fractional DPR, floor-by-cast would leave an
    // unpainted rightmost/bottom column in the backing store.
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px system-ui, sans-serif';
    // Cleared up front so the pointer handler added in Task 8 can never hit-test
    // against scales left over from a previous, differently-shaped render.
    canvas._scales = null;

    const values = points.map((p) => valueOf(p, opts.series));
    const drawable = values.filter((v) => v != null && Number.isFinite(v));

    if (drawable.length < 2) {
      ctx.fillStyle = COLORS.muted;
      // The empty-state text is the panel's only visible content in this state —
      // give it a real font size instead of inheriting the 10px axis label font.
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const [line1, line2] = emptyMessage(points.length, drawable.length, opts.series);
      ctx.fillText(line1, w / 2, h / 2 - 6);
      ctx.fillText(line2, w / 2, h / 2 + 10);
      ctx.textAlign = 'left';
      return;
    }

    const box = { width: w, height: h, ...PAD };
    const s = computeScales(values, box);
    const { x0, x1, y0, y1 } = s.plot;
    const n = points.length;

    // --- gridlines + y labels ---
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const ticks = niceTicks(s.min, s.max);
    const labels = tickLabels(ticks);
    ticks.forEach((t, i) => {
      const y = Math.round(s.y(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillText(labels[i], x0 - 8, y);
    });
    ctx.textBaseline = 'alphabetic';

    // --- x labels: first, middle, last ---
    const span = points[n - 1].ts - points[0].ts;
    ctx.fillStyle = COLORS.muted;
    const marks = pickXLabels(n);
    marks.forEach((i, k) => {
      ctx.textAlign = k === 0 ? 'left' : k === marks.length - 1 ? 'right' : 'center';
      ctx.fillText(fmtAxisTime(points[i].ts, span), s.x(i, n), y1 + 18);
    });
    ctx.textAlign = 'left';

    // --- line direction sets the color ---
    const rising = drawable[drawable.length - 1] >= drawable[0];
    const stroke = rising ? COLORS.pos : COLORS.neg;
    const runs = segments(values);

    // --- area fill under each run ---
    const grad = ctx.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, hexA(stroke, 0.28));
    grad.addColorStop(1, hexA(stroke, 0));
    ctx.fillStyle = grad;
    for (const run of runs) {
      if (run.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(s.x(run[0].i, n), y1);
      for (const p of run) ctx.lineTo(s.x(p.i, n), s.y(p.v));
      ctx.lineTo(s.x(run[run.length - 1].i, n), y1);
      ctx.closePath();
      ctx.fill();
    }

    // --- the line itself, one path per run so nulls stay gaps ---
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const run of runs) {
      // A run of length 1 has no segment to stroke — moveTo with no lineTo paints
      // nothing at all, silently dropping isolated snapshots from an alternating-null
      // series (entirely plausible: snapshots only accrue while the dashboard is
      // open). Paint it as a dot instead so it isn't lost.
      if (run.length === 1) {
        ctx.beginPath();
        ctx.arc(s.x(run[0].i, n), s.y(run[0].v), 2.5, 0, Math.PI * 2);
        ctx.fillStyle = stroke;
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      run.forEach((p, k) => (k ? ctx.lineTo(s.x(p.i, n), s.y(p.v)) : ctx.moveTo(s.x(p.i, n), s.y(p.v))));
      ctx.stroke();
    }

    // --- sparse-data caveat ---
    if (drawable.length <= 4) {
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(`${drawable.length} snapshots`, x0 + 4, y0 + 10);
    }

    canvas._scales = { s, n, span, values };
  }

  // Canvas colors need rgba; the tokens are hex.
  function hexA(hex, a) {
    const v = hex.replace('#', '');
    const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  // A draw failure must not take the page down with it, and must not leave a
  // half-painted canvas that reads as "no data" rather than "broken": draw() can
  // throw after gridlines/labels are already on the canvas (e.g. a bad hex token
  // makes addColorStop throw), so the fallback clears everything first and resets
  // the context state draw() may have left mid-change (a right-aligned fallback
  // string at x=12 renders almost entirely off-canvas).
  function safeDraw() {
    try {
      draw();
    } catch (e) {
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.font = '13px system-ui, sans-serif';
        ctx.fillStyle = COLORS.muted;
        ctx.fillText("Couldn't draw the chart.", 12, 24);
      }
      console.error(e);
    }
  }

  // Every resize event reassigns canvas.width, which reallocates the backing
  // store — coalesce bursts (window drag) into one draw per frame, and route
  // through the same guarded path so a mid-resize throw doesn't go uncaught.
  let resizeFrame = null;
  const onResize = () => {
    if (resizeFrame != null) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      safeDraw();
    });
  };
  window.addEventListener('resize', onResize);

  return {
    render(nextPoints, nextOpts = {}) {
      points = nextPoints || [];
      opts = { ...opts, ...nextOpts };
      safeDraw();
    },
    destroy() {
      window.removeEventListener('resize', onResize);
      if (resizeFrame != null) cancelAnimationFrame(resizeFrame);
    },
  };
}

// Small inline trend line for the summary cards.
export function drawSparkline(canvas, values, color) {
  // Guard against the expected transient shapes: sparklines arrive from a request
  // that resolves after the cards paint, and history is cleared on wallet switch,
  // so undefined/empty values are routine, not exceptional. Also bail on a canvas
  // that hasn't been laid out yet rather than silently paint an invisible line.
  if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return;
  try {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const vals = values || [];
    const runs = segments(vals);
    if (!runs.length) return;
    const s = computeScales(vals, { width: w, height: h, padLeft: 1, padRight: 1, padTop: 3, padBottom: 3 });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    for (const run of runs) {
      if (run.length === 1) {
        ctx.beginPath();
        ctx.arc(s.x(run[0].i, vals.length), s.y(run[0].v), 1.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      run.forEach((p, k) => (k ? ctx.lineTo(s.x(p.i, vals.length), s.y(p.v)) : ctx.moveTo(s.x(p.i, vals.length), s.y(p.v))));
      ctx.stroke();
    }
  } catch (e) {
    console.error(e);
  }
}
