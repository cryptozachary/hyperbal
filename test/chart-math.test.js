import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  niceStep, niceTicks, tickLabels, computeScales, nearestIndex, segments, rangeChange,
  pickXLabels, pointerToIndex, tooltipBox,
} from '../public/js/chart-math.js';
import { fmtUsd } from '../public/js/format.js';

test('niceStep snaps to 1/2/5 x 10^n', () => {
  assert.equal(niceStep(0.7), 1);
  assert.equal(niceStep(1.3), 2);
  assert.equal(niceStep(3), 5);
  assert.equal(niceStep(7), 10);
  assert.equal(niceStep(230), 500);
  assert.equal(niceStep(0.03), 0.05);
});

test('niceStep snaps exact boundary values to themselves', () => {
  // A strict-< mutation on the f <= 1 / <= 2 / <= 5 chain survives unless the
  // boundaries themselves are checked, since every other test uses interior values.
  assert.equal(niceStep(1), 1);
  assert.equal(niceStep(2), 2);
  assert.equal(niceStep(5), 5);
  assert.equal(niceStep(10), 10);
});

test('niceStep never returns non-positive, which would hang niceTicks', () => {
  for (const v of [0, -3, NaN, Infinity, undefined]) {
    assert.equal(niceStep(v), 1, `niceStep(${v})`);
  }
});

test('niceTicks returns empty for non-finite bounds instead of hanging', () => {
  assert.deepEqual(niceTicks(NaN, 1), []);
  assert.deepEqual(niceTicks(-Infinity, 1), []);
});

test('niceTicks covers ordinary ranges with round values', () => {
  const t = niceTicks(43120, 48950);
  assert.ok(t.length >= 3 && t.length <= 6, `got ${t.length} ticks`);
  assert.ok(t[0] >= 43120 && t[t.length - 1] <= 48950);
  for (const v of t) assert.equal(v % 1000, 0);
});

test('niceTicks handles a range spanning zero', () => {
  const t = niceTicks(-620, 380);
  assert.ok(t.length >= 3 && t.length <= 6, `got ${t.length} ticks`);
  assert.ok(t.includes(0), `expected a zero tick in ${t}`);
});

test('niceTicks handles a flat series without dividing by zero', () => {
  const t = niceTicks(500, 500);
  assert.ok(t.length >= 3 && t.length <= 6, `got ${t.length} ticks`);
  assert.ok(t.every(Number.isFinite));
});

test('niceTicks handles sub-unit ranges', () => {
  const t = niceTicks(0.012, 0.048);
  assert.ok(t.length >= 3 && t.length <= 6, `got ${t.length} ticks`);
  assert.ok(t.every(Number.isFinite));
});

test('niceTicks de-duplicates ticks toPrecision(12) collapses to the same value', () => {
  const t = niceTicks(5384.874180924359, 5384.874180932944);
  assert.equal(new Set(t).size, t.length, `duplicate tick in ${t}`);
});

// ---- tickLabels ----
// Precision is a property of the whole axis, not any single tick, so these all
// feed real niceTicks() output through tickLabels() rather than hand-picking
// tick arrays — the two functions are meant to be used together.

test('tickLabels normalizes a narrow high range to one shared decimal', () => {
  // The live-app bug this fixes: equity ticks near $2,000 rendered as
  // "$1.6k, $1.7k, $1.8k, $1.9k, $2k, $2.1k" — fmtCompact's trailing-.0 trim
  // makes $2k read like a different, coarser precision than its neighbors.
  const t = niceTicks(1600, 2100);
  assert.deepEqual(tickLabels(t), ['$1.6k', '$1.7k', '$1.8k', '$1.9k', '$2.0k', '$2.1k']);
});

test('tickLabels keeps whole-number PnL ticks bare, not $2.00', () => {
  // A second, independent case of the same root cause: fmtCompact's no-unit
  // branch uses 2 decimals below $10 and 0 decimals at/above it, so ticks
  // 0/2/4/6/8/10 mixed "$2.00" beside "$10" within one column.
  const t = niceTicks(0, 10);
  assert.deepEqual(tickLabels(t), ['$0', '$2', '$4', '$6', '$8', '$10']);
});

test('tickLabels handles a range spanning zero without a lone decimal', () => {
  const t = niceTicks(-5, 20);
  assert.deepEqual(tickLabels(t), ['-$5', '$0', '$5', '$10', '$15', '$20']);
});

test('tickLabels is uniform across a small positive range', () => {
  const t = niceTicks(0, 25);
  assert.deepEqual(tickLabels(t), ['$0', '$5', '$10', '$15', '$20', '$25']);
});

test('tickLabels picks one unit and one precision for a wide equity range', () => {
  // 0 decimals would collide (0.5M and 1.0M both round to "1M"), so this must
  // escalate to 1 decimal — and $0 still stays bare, not "$0.0M".
  const t = niceTicks(0, 1.5e6);
  assert.deepEqual(tickLabels(t), ['$0', '$0.5M', '$1.0M', '$1.5M']);
});

test('tickLabels falls back to full precision when even one decimal collides', () => {
  // A ~1% window around $2,000: at 1 decimal every tick rounds to "$2.0k".
  const t = niceTicks(1990, 2010);
  const labels = tickLabels(t);
  assert.deepEqual(labels, t.map(fmtUsd));
  assert.equal(new Set(labels).size, labels.length, `duplicate in ${labels}`);
});

test('tickLabels needs no decimals when scaled ticks are already whole', () => {
  const t = niceTicks(48000, 52000);
  assert.deepEqual(tickLabels(t), ['$48k', '$49k', '$50k', '$51k', '$52k']);
});

test('tickLabels never returns two identical labels', () => {
  const ranges = [[1600, 2100], [0, 10], [-5, 20], [0, 25], [0, 1.5e6], [1990, 2010], [48000, 52000]];
  for (const [min, max] of ranges) {
    const labels = tickLabels(niceTicks(min, max));
    assert.equal(new Set(labels).size, labels.length, `duplicate for [${min}, ${max}]: ${labels}`);
  }
});

test('tickLabels keeps one suffix and one decimal count across a unit-scaled set', () => {
  // Every non-zero label in a unit-scaled column must share the suffix and the
  // decimal count — that's the second bug (the first is the dedup check above).
  const labels = tickLabels(niceTicks(0, 1.5e6)).filter((l) => l !== '$0');
  assert.ok(labels.length > 0);
  for (const l of labels) assert.match(l, /^\$\d+\.\dM$/, `inconsistent precision/suffix: ${l}`);
});

test('tickLabels returns nothing for an empty tick set', () => {
  assert.deepEqual(tickLabels([]), []);
});

const BOX = { width: 600, height: 200, padLeft: 52, padRight: 12, padTop: 20, padBottom: 28 };

test('computeScales maps values into the plot box, right side up', () => {
  const s = computeScales([100, 200], BOX);
  // One-sided bounds at the endpoints are satisfied by any linear map onto [y0, y1]
  // in either orientation, and by a padding inversion that clips real data outside
  // the plot box. Pin the orientation, the exact endpoints, and a real data point
  // strictly inside the pad so an inverted or clipped y-map fails loudly.
  assert.ok(s.y(s.max) < s.y(s.min));                    // orientation: bigger value, higher up
  assert.equal(s.y(s.max), BOX.padTop);                  // exact, not one-sided
  assert.equal(s.y(s.min), BOX.height - BOX.padBottom);
  assert.ok(s.y(200) > BOX.padTop);                      // real data sits strictly inside the pad
  assert.ok(s.y(100) < BOX.height - BOX.padBottom);
  assert.equal(s.min, 95); assert.equal(s.max, 205);     // pins padFrac at 5%
  assert.equal(s.x(0, 2), BOX.padLeft);
  assert.equal(s.x(1, 2), BOX.width - BOX.padRight);
});

test('computeScales.x handles a single point (n=1) without dividing by zero', () => {
  const s = computeScales([100, 200], BOX);
  assert.equal(s.x(0, 1), (BOX.padLeft + BOX.width - BOX.padRight) / 2);
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

test('segments treats NaN as a gap the same as null', () => {
  const s = segments([1, NaN, 2]);
  assert.equal(s.length, 2);
});

test('segments emits singleton runs so the chart knows to draw a dot, not a path', () => {
  assert.deepEqual(segments([1, null, 2]).map((g) => g.length), [1, 1]);
});

test('rangeChange needs two finite points', () => {
  assert.equal(rangeChange([5]), null);
  assert.equal(rangeChange([null, null]), null);
  const c = rangeChange([100, 150]);
  assert.equal(c.abs, 50);
  assert.equal(c.pct, 50);
  assert.equal(rangeChange([0, 10]).pct, null); // no percent from a zero base
});

test('rangeChange handles a negative base and values with null padding', () => {
  assert.equal(rangeChange([-200, -100]).pct, 50); // pct uses abs(first), not first
  assert.equal(rangeChange([null, 100, null, 150, null]).abs, 50); // finite values only
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
// Regularly spaced timestamps: index position and time position coincide here, which
// is exactly why this fixture alone can't distinguish an index-based pointerToIndex
// from a (wrong) time-based one. See the irregular-fixture test below for that.
const SERIES = [{ ts: 1000 }, { ts: 2000 }, { ts: 3000 }, { ts: 4000 }];

test('pointerToIndex maps across the plot and rejects outside it', () => {
  assert.equal(pointerToIndex(52, PLOT, SERIES), 0);    // left edge
  assert.equal(pointerToIndex(628, PLOT, SERIES), 3);   // right edge
  assert.equal(pointerToIndex(340, PLOT, SERIES), 1);   // midpoint -> index 1.5, rounds down to 1
  assert.equal(pointerToIndex(0, PLOT, SERIES), -1);    // well left
  assert.equal(pointerToIndex(900, PLOT, SERIES), -1);  // well right
});

test('pointerToIndex forgives a small overshoot at each edge', () => {
  assert.equal(pointerToIndex(46, PLOT, SERIES), 0);    // 6px left of x0, within slack
  assert.equal(pointerToIndex(634, PLOT, SERIES), 3);   // 6px right of x1
  assert.equal(pointerToIndex(43, PLOT, SERIES), -1);   // 9px left, past slack
});

test('pointerToIndex survives degenerate input', () => {
  assert.equal(pointerToIndex(300, PLOT, []), -1);                         // no points
  assert.equal(pointerToIndex(300, PLOT, [{ ts: 5 }]), 0);                 // single point
  assert.equal(pointerToIndex(300, { ...PLOT, x1: 52 }, SERIES), 0);       // zero-width plot
});

test('pointerToIndex inverts the index scale, not the time scale', () => {
  // Four snapshots 90s apart, a three-day gap, four more — the shape real history
  // takes, since snapshots only accrue while the dashboard is open. computeScales.x
  // places point i at x0 + (i / (n - 1)) * (x1 - x0), independent of ts; pointerToIndex
  // must invert that same index-based mapping, not walk back through elapsed time.
  const t0 = 1e12, day = 86400000;
  const irregular = [0, 90e3, 180e3, 270e3, 3 * day, 3 * day + 90e3, 3 * day + 180e3, 3 * day + 270e3]
    .map((d) => ({ ts: t0 + d }));
  const n = irregular.length;
  const xOf = (i) => PLOT.x0 + (i / (n - 1)) * (PLOT.x1 - PLOT.x0);
  // Every drawn vertex must hit-test to itself.
  for (let i = 0; i < n; i++) {
    assert.equal(pointerToIndex(Math.round(xOf(i)), PLOT, irregular), i, `vertex ${i}`);
  }
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

test('tooltipBox flip threshold includes the gap, not just the box width', () => {
  // A mutant that drops `gap` from the flip condition (hx + boxW > x1 instead of
  // hx + gap + boxW > x1) agrees with the correct threshold at hx itself but
  // disagrees one pixel later, where the gap still matters.
  const boxW = 132, boxH = 42, gap = 12;
  const atThreshold = tooltipBox({ hx: PLOT.x1 - gap - boxW, hy: 96, boxW, boxH, plot: PLOT });
  assert.equal(atThreshold.flip, false);
  const pastThreshold = tooltipBox({ hx: PLOT.x1 - gap - boxW + 1, hy: 96, boxW, boxH, plot: PLOT });
  assert.equal(pastThreshold.flip, true);
});
