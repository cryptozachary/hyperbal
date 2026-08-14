// Pure geometry for the chart. No DOM anywhere in this file — node:test imports it.

// Round a raw step up to the nearest 1, 2 or 5 times a power of ten, so axis
// labels land on numbers a human would have chosen.
export function niceStep(raw) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}

// Tick values inside [min, max], aiming for `target` gridlines. Default of 7 (rather
// than the more obvious 5) keeps the floor at >= 3 ticks across realistic padded
// ranges: niceStep always rounds up to the next 1/2/5, so a smaller target divisor
// under-shoots the count more often than intuition suggests.
export function niceTicks(min, max, target = 7) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const p = Math.abs(min) * 0.01 || 1;
    min -= p; max += p;
  }
  const step = niceStep((max - min) / Math.max(1, target - 1));
  const ticks = [];
  const first = Math.ceil(min / step) * step;
  // The loop bound is nudged by a step epsilon so float accumulation error in `v`
  // doesn't drop the last in-range tick.
  // Separately, toPrecision(12) below only cleans up each pushed value for display
  // (e.g. 0.30000000000000004 -> 0.3) — it does nothing to protect the loop bound.
  for (let v = first; v <= max + step * 1e-9; v += step) {
    const rounded = Number(v.toPrecision(12));
    // toPrecision(12) can collapse two distinct raw values to the same rounded tick
    // once `step` falls below 12-significant-figure resolution; skip the duplicate.
    if (ticks.length && rounded === ticks[ticks.length - 1]) continue;
    ticks.push(rounded);
  }
  return ticks;
}

// Maps series values into a plot box. `x` is index-based (snapshots are irregular
// in time but drawn evenly — matching the existing chart's behavior).
export function computeScales(values, box) {
  const { width, height, padLeft, padRight, padTop, padBottom, padFrac = 0.05 } = box;
  const finite = values.filter((v) => v != null && Number.isFinite(v));
  let min, max;
  if (!finite.length) { min = 0; max = 1; }
  else {
    // Spreading into Math.min/max blows the call stack around ~125k points
    // (~87 days of continuous viewing); reduce has no such ceiling.
    min = finite.reduce((a, b) => (b < a ? b : a), Infinity);
    max = finite.reduce((a, b) => (b > a ? b : a), -Infinity);
  }
  if (min === max) {
    const p = Math.abs(min) * 0.01 || 1;
    min -= p; max += p;
  } else {
    const p = (max - min) * padFrac;
    min -= p; max += p;
  }
  const x0 = padLeft, x1 = width - padRight, y0 = padTop, y1 = height - padBottom;
  return {
    min, max,
    plot: { x0, x1, y0, y1 },
    x: (i, n) => (n <= 1 ? (x0 + x1) / 2 : x0 + (i / (n - 1)) * (x1 - x0)),
    y: (v) => y1 - ((v - min) / (max - min)) * (y1 - y0),
  };
}

// Binary search for the point whose ts is closest to `ts`. Points are ascending.
export function nearestIndex(points, ts) {
  if (!points.length) return -1;
  let lo = 0, hi = points.length - 1;
  if (ts <= points[lo].ts) return lo;
  if (ts >= points[hi].ts) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].ts <= ts) lo = mid; else hi = mid;
  }
  return ts - points[lo].ts <= points[hi].ts - ts ? lo : hi;
}

// Contiguous runs of drawable values. A null is a gap in the line, not a zero —
// the old chart drew nulls as 0, which invented an observation that never happened.
export function segments(values) {
  const out = [];
  let cur = null;
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) { cur = null; return; }
    if (!cur) { cur = []; out.push(cur); }
    cur.push({ i, v });
  });
  return out;
}

// Absolute and percent change across a range. Percent is null from a zero base.
export function rangeChange(values) {
  const finite = values.filter((v) => v != null && Number.isFinite(v));
  if (finite.length < 2) return null;
  const first = finite[0], last = finite[finite.length - 1];
  return { abs: last - first, pct: first === 0 ? null : ((last - first) / Math.abs(first)) * 100 };
}

// ---- Interaction geometry ----
//
// These three would naturally live inside chart.js's draw and pointer code, where
// nothing could test them: chart.js reads CSS custom properties at module scope, so
// Node cannot import it, and no agent in this workflow can drive a browser. Keeping
// them here as pure functions is what makes the crosshair's behavior verifiable
// rather than merely asserted.

// Which point indices get an x-axis label. Three marks (first, middle, last) unless
// the series is too short for that to be meaningful.
export function pickXLabels(n) {
  if (n <= 0) return [];
  if (n === 1) return [0];
  if (n === 2) return [0, n - 1];
  return [0, Math.floor((n - 1) / 2), n - 1];
}

// Pointer x -> point index, or -1 when the pointer is outside the plot. `slack` is
// the forgiveness band beyond each edge, so the crosshair doesn't drop out the
// instant the cursor grazes the axis.
//
// The degenerate check (x1 === x0, a zero-width plot) runs before the slack-bounds
// rejection: a zero-width plot collapses the entire x axis onto a single line, so
// any pointer position "hits" it and should resolve to index 0 rather than being
// rejected for falling outside a band that is only 2*slack wide around one point.
export function pointerToIndex(px, plot, points, slack = 8) {
  if (!points.length) return -1;
  const { x0, x1 } = plot;
  if (x1 === x0) return 0;
  if (px < x0 - slack || px > x1 + slack) return -1;
  const frac = Math.min(1, Math.max(0, (px - x0) / (x1 - x0)));
  // The x scale is index-based, not time-based (see computeScales.x) — invert that
  // same mapping here, or the crosshair drifts wherever snapshots are irregularly
  // spaced in time, which is always. Math.ceil(v - 0.5) rounds halves DOWN, matching
  // nearestIndex's tie-break-low convention; Math.max(0, ...) avoids returning -0.
  return Math.max(0, Math.ceil(frac * (points.length - 1) - 0.5));
}

// Where the tooltip box goes: to the right of the crosshair normally, flipped to the
// left when it would overflow, and always clamped inside the plot vertically.
export function tooltipBox({ hx, hy, boxW, boxH, plot, gap = 12 }) {
  const { x0, x1, y0, y1 } = plot;
  const flip = hx + gap + boxW > x1;
  let bx = flip ? hx - gap - boxW : hx + gap;
  // A box wider than the plot itself would otherwise hang off the left edge.
  bx = Math.max(x0, Math.min(bx, x1 - boxW));
  const by = Math.min(Math.max(hy - boxH / 2, y0), y1 - boxH);
  return { bx, by, flip };
}
