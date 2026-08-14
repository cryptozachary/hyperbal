import * as api from './api.js';
import { createChart } from './chart.js';
import { rangeChange } from './chart-math.js';
import { fmtUsd, fmtPct } from './format.js';

const $ = (id) => document.getElementById(id);

const RANGE_LABEL = { all: 'all time', 86400000: '24h', 604800000: '7d', 2592000000: '30d' };

let chart = null;
let address = null;
let series = 'equity';
let history = [];
let range = 'all';
let seq = 0; // generation guard — see exports.js's identical pattern

function renderChange() {
  const el = $('chartChange');
  if (!el) return;
  const values = history.map((p) => (series === 'equity' ? p.equity : p.unrealized_pnl));
  const c = rangeChange(values);
  const label = RANGE_LABEL[range];
  if (!c) { el.textContent = `— over ${label}`; el.className = 'chart-change'; return; }
  const arrow = c.abs >= 0 ? '▲' : '▼';
  const pct = c.pct == null ? '' : ` · ${fmtPct(c.pct)}`;
  el.textContent = `${arrow} ${fmtUsd(Math.abs(c.abs))}${pct} over ${label}`;
  el.className = 'chart-change ' + (c.abs > 0 ? 'pos' : c.abs < 0 ? 'neg' : '');
}

function paint() {
  chart.render(history, { series });
  renderChange();
}

export function setAddress(next) { address = next; history = []; }

export async function load() {
  if (!address) return;
  const want = address;
  const mySeq = ++seq;
  const since = range === 'all' ? 0 : Date.now() - Number(range);
  try {
    const { points } = await api.getHistory(want, since);
    // Stale-response guard: a superseded request (older pill click, or a wallet
    // switch that landed after this one started) must not repaint over a newer
    // result — mirrors exports.js's seq/want pattern.
    if (mySeq !== seq || want !== address) return;
    history = points;
    paint();
  } catch {}
}

export function reset() { address = null; history = []; paint(); }

export function mount() {
  chart = createChart($('chart'));
  document.querySelectorAll('#chartToggle button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#chartToggle button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      series = b.dataset.series;
      paint();
    }));
  document.querySelectorAll('#chartRange button').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.range === range) return;
      document.querySelectorAll('#chartRange button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      range = b.dataset.range;
      load(); // chart only — the cards and tables are unaffected by range
    }));
}
