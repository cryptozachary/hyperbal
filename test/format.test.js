import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtUsd, fmtNum, fmtPct, fmtCompact, fmtAxisTime, fmtTime, cls, short, esc } from '../public/js/format.js';

test('fmtUsd handles sign, nulls and rounding', () => {
  assert.equal(fmtUsd(null), '—');
  assert.equal(fmtUsd(0), '$0');
  assert.equal(fmtUsd(1234.567), '$1,234.57');
  assert.equal(fmtUsd(-612.44), '-$612.44');
});

test('fmtNum respects precision and nulls', () => {
  assert.equal(fmtNum(null), '—');
  assert.equal(fmtNum(0.425), '0.425');
  assert.equal(fmtNum(96412.004, 2), '96,412');
});

test('fmtPct always carries a sign', () => {
  assert.equal(fmtPct(null), '—');
  assert.equal(fmtPct(12.444), '+12.44%');
  assert.equal(fmtPct(-3.6), '-3.60%');
  assert.equal(fmtPct(0), '+0.00%');
  assert.equal(fmtPct(NaN), '—');
});

test('fmtCompact abbreviates for axis labels', () => {
  assert.equal(fmtCompact(0), '$0');
  assert.equal(fmtCompact(612.44), '$612');
  assert.equal(fmtCompact(5.5), '$5.50');
  assert.equal(fmtCompact(49000), '$49k');
  assert.equal(fmtCompact(1500), '$1.5k');
  assert.equal(fmtCompact(1234567), '$1.2M');
  assert.equal(fmtCompact(-49000), '-$49k');
  assert.equal(fmtCompact(null), '—');
  assert.equal(fmtCompact(999.4), '$999');
  assert.equal(fmtCompact(999.5), '$1k');
  assert.equal(fmtCompact(999499), '$999k');
  assert.equal(fmtCompact(999500), '$1M');
  assert.equal(fmtCompact(999499999), '$999M');
  assert.equal(fmtCompact(999500000), '$1B');
});

// Locale-independent: assert the shape of the branch, not the exact string.
test('fmtAxisTime switches format with span', () => {
  const ts = Date.UTC(2026, 7, 6, 14, 20);
  assert.match(fmtAxisTime(ts, 24 * 3600e3), /\d[:.]\d/);          // time of day
  const monthDay = fmtAxisTime(ts, 30 * 86400e3);
  assert.doesNotMatch(monthDay, /\d[:.]\d\d/);  // not a time
  assert.doesNotMatch(monthDay, /2026/);        // and not the year branch either
  assert.match(fmtAxisTime(ts, 800 * 86400e3), /2026/);             // month + year

  assert.equal(fmtAxisTime(null, 24 * 3600e3), '—');
  assert.equal(fmtAxisTime(ts, undefined), '—');

  assert.match(fmtAxisTime(ts, 36 * 3600e3), /\d[:.]\d/);            // 36h exactly -> still time
  assert.doesNotMatch(fmtAxisTime(ts, 36 * 3600e3 + 1), /\d[:.]\d\d/); // just over -> date
  assert.doesNotMatch(fmtAxisTime(ts, 400 * 86400e3), /2026/);       // 400d exactly -> month/day
  assert.match(fmtAxisTime(ts, 400 * 86400e3 + 1), /2026/);          // just over -> month/year
});

test('fmtTime handles null', () => {
  assert.equal(fmtTime(null), '—');
});

test('cls classifies sign', () => {
  assert.equal(cls(null), '');
  assert.equal(cls(0), '');
  assert.equal(cls(1), 'pos');
  assert.equal(cls(-1), 'neg');
});

test('short and esc', () => {
  assert.equal(short('0x8f2a1111222233334444555566667777888841c7'), '0x8f2a…41c7');
  assert.equal(short(null), '');
  assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc("it's"), 'it&#39;s');
});
