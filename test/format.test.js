import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtUsd, fmtNum, fmtPct, fmtAxisTime, fmtTime, cls, short, esc, changeReadout } from '../public/js/format.js';

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

test('changeReadout handles null, positive, negative and a zero-base pct', () => {
  assert.deepEqual(changeReadout(null, '24h'), { text: '— over 24h', cls: '' });
  assert.deepEqual(changeReadout({ abs: 100, pct: 12.34 }, '7d'),
    { text: '▲ $100 · +12.34% over 7d', cls: 'pos' });
  assert.deepEqual(changeReadout({ abs: -50, pct: -5 }, '30d'),
    { text: '▼ $50 · -5.00% over 30d', cls: 'neg' });
  // abs === 0 uses the dot glyph, not an arrow, and carries no sign class — this is
  // the tie-break that a naive `abs >= 0` arrow / three-way class would disagree on.
  assert.deepEqual(changeReadout({ abs: 0, pct: null }, 'all time'),
    { text: '· $0 over all time', cls: '' });
});

test('short and esc', () => {
  assert.equal(short('0x8f2a1111222233334444555566667777888841c7'), '0x8f2a…41c7');
  assert.equal(short(null), '');
  assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc("it's"), 'it&#39;s');
});
