import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  niceStep, niceTicks, computeScales, nearestIndex, segments, rangeChange,
  pickXLabels, pointerToIndex, tooltipBox,
} from '../public/js/chart-math.js';

test('niceStep snaps to 1/2/5 x 10^n', () => {
  assert.equal(niceStep(0.7), 1);
  assert.equal(niceStep(1.3), 2);
  assert.equal(niceStep(3), 5);
  assert.equal(niceStep(7), 10);
  assert.equal(niceStep(230), 500);
  assert.equal(niceStep(0.03), 0.05);
});

test('niceTicks covers ordinary ranges with round values', () => {
  const t = niceTicks(43120, 48950);
  assert.ok(t.length >= 3 && t.length <= 6, `got ${t.length} ticks`);
  assert.ok(t[0] >= 43120 && t[t.length - 1] <= 48950);
  for (const v of t) assert.equal(v % 1000, 0);
});

test('niceTicks handles a range spanning zero', () => {
  const t = niceTicks(-620, 380);
  assert.ok(t.includes(0), `expected a zero tick in ${t}`);
});

test('niceTicks handles a flat series without dividing by zero', () => {
  const t = niceTicks(500, 500);
  assert.ok(t.length > 0);
  assert.ok(t.every(Number.isFinite));
});

test('niceTicks handles sub-unit ranges', () => {
  const t = niceTicks(0.012, 0.048);
  assert.ok(t.length >= 2);
  assert.ok(t.every(Number.isFinite));
});

const BOX = { width: 600, height: 200, padLeft: 52, padRight: 12, padTop: 20, padBottom: 28 };

test('computeScales maps values into the plot box', () => {
  const s = computeScales([100, 200], BOX);
  assert.ok(s.y(s.max) >= BOX.padTop - 0.001);
  assert.ok(s.y(s.min) <= BOX.height - BOX.padBottom + 0.001);
  assert.equal(s.x(0, 2), BOX.padLeft);
  assert.equal(s.x(1, 2), BOX.width - BOX.padRight);
});

test('computeScales centers a flat series', () => {
  const s = computeScales([500, 500, 500], BOX);
  const mid = (BOX.padTop + (BOX.height - BOX.padBottom)) / 2;
  assert.ok(Math.abs(s.y(500) - mid) < 0.001);
});

test('computeScales survives an all-null series', () => {
  const s = computeScales([null, null], BOX);
  assert.ok(Number.isFinite(s.y(0)));
});

const PTS = [{ ts: 10 }, { ts: 20 }, { ts: 30 }, { ts: 100 }];

test('nearestIndex finds the closest point', () => {
  assert.equal(nearestIndex([], 5), -1);
  assert.equal(nearestIndex([{ ts: 7 }], 999), 0);
  assert.equal(nearestIndex(PTS, 20), 1);   // exact
  assert.equal(nearestIndex(PTS, 0), 0);    // before start
  assert.equal(nearestIndex(PTS, 500), 3);  // past end
  assert.equal(nearestIndex(PTS, 22), 1);   // closer to 20
  assert.equal(nearestIndex(PTS, 28), 2);   // closer to 30
  assert.equal(nearestIndex(PTS, 65), 2);   // tie-ish, lower wins
});

test('segments splits on nulls and keeps original indices', () => {
  const s = segments([1, 2, null, 4, 5]);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0].map((p) => p.i), [0, 1]);
  assert.deepEqual(s[1].map((p) => p.i), [3, 4]);
});

test('rangeChange needs two finite points', () => {
  assert.equal(rangeChange([5]), null);
  assert.equal(rangeChange([null, null]), null);
  const c = rangeChange([100, 150]);
  assert.equal(c.abs, 50);
  assert.equal(c.pct, 50);
  assert.equal(rangeChange([0, 10]).pct, null); // no percent from a zero base
});

// ---- Interaction geometry ----
// These cover what would otherwise be unverifiable: no agent in this workflow can
// drive a browser, so the crosshair's hit-testing and the tooltip's flip are only
// checkable if they are pure.

test('pickXLabels degrades gracefully on short series', () => {
  assert.deepEqual(pickXLabels(0), []);
  assert.deepEqual(pickXLabels(1), [0]);
  assert.deepEqual(pickXLabels(2), [0, 1]);
  assert.deepEqual(pickXLabels(3), [0, 1, 2]);
  assert.deepEqual(pickXLabels(30), [0, 14, 29]);
});

const PLOT = { x0: 52, x1: 628, y0: 20, y1: 172 };
const SERIES = [{ ts: 1000 }, { ts: 2000 }, { ts: 3000 }, { ts: 4000 }];
const SPAN = 3000;

test('pointerToIndex maps across the plot and rejects outside it', () => {
  assert.equal(pointerToIndex(52, PLOT, SERIES, SPAN), 0);    // left edge
  assert.equal(pointerToIndex(628, PLOT, SERIES, SPAN), 3);   // right edge
  assert.equal(pointerToIndex(340, PLOT, SERIES, SPAN), 1);   // midpoint -> ts 2500, nearer 2000
  assert.equal(pointerToIndex(0, PLOT, SERIES, SPAN), -1);    // well left
  assert.equal(pointerToIndex(900, PLOT, SERIES, SPAN), -1);  // well right
});

test('pointerToIndex forgives a small overshoot at each edge', () => {
  assert.equal(pointerToIndex(46, PLOT, SERIES, SPAN), 0);    // 6px left of x0, within slack
  assert.equal(pointerToIndex(634, PLOT, SERIES, SPAN), 3);   // 6px right of x1
  assert.equal(pointerToIndex(43, PLOT, SERIES, SPAN), -1);   // 9px left, past slack
});

test('pointerToIndex survives degenerate input', () => {
  assert.equal(pointerToIndex(300, PLOT, [], SPAN), -1);
  assert.equal(pointerToIndex(300, PLOT, [{ ts: 5 }], 0), 0);          // single point, zero span
  assert.equal(pointerToIndex(300, { ...PLOT, x1: 52 }, SERIES, SPAN), 0); // zero-width plot
});

test('tooltipBox sits right of the crosshair when there is room', () => {
  const { bx, by, flip } = tooltipBox({ hx: 100, hy: 96, boxW: 132, boxH: 42, plot: PLOT });
  assert.equal(flip, false);
  assert.equal(bx, 112);
  assert.equal(by, 75);
});

test('tooltipBox flips left rather than overflowing the right edge', () => {
  const { bx, flip } = tooltipBox({ hx: 600, hy: 96, boxW: 132, boxH: 42, plot: PLOT });
  assert.equal(flip, true);
  assert.equal(bx, 456);
  assert.ok(bx >= PLOT.x0);
});

test('tooltipBox clamps vertically inside the plot', () => {
  assert.equal(tooltipBox({ hx: 100, hy: 20, boxW: 132, boxH: 42, plot: PLOT }).by, PLOT.y0);
  assert.equal(tooltipBox({ hx: 100, hy: 172, boxW: 132, boxH: 42, plot: PLOT }).by, PLOT.y1 - 42);
});

test('tooltipBox keeps a box wider than the plot on screen', () => {
  const wide = tooltipBox({ hx: 600, hy: 96, boxW: 900, boxH: 42, plot: PLOT });
  assert.equal(wide.bx, PLOT.x0); // clamped, not hanging off the left
});
