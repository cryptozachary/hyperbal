import * as api from './api.js';
import { createChart } from './chart.js';
import { rangeChange } from './chart-math.js';
import { changeReadout } from './format.js';
import { toast, errMsg } from './feedback.js';

const $ = (id) => document.getElementById(id);

const RANGE_LABEL = { all: 'all time', 86400000: '24h', 604800000: '7d', 2592000000: '30d' };

let chart = null;
let address = null;
let series = 'equity';
let history = [];
let range = 'all';        // the pill currently highlighted (may be optimistic)
let paintedRange = 'all'; // the range whose data is actually in `history` — the
                           // revert target if a range-changing fetch fails
let seq = 0; // generation guard — see exports.js's identical pattern

function renderChange() {
  const el = $('chartChange');
  if (!el) return;
  const values = history.map((p) => (series === 'equity' ? p.equity : p.unrealized_pnl));
  const r = changeReadout(rangeChange(values), RANGE_LABEL[range]);
  el.textContent = r.text;
  el.className = ('chart-change ' + r.cls).trim();
}

function paint() {
  chart.render(history, { series });
  renderChange();
}

function highlightRange(r) {
  document.querySelectorAll('#chartRange button').forEach((x) => x.classList.toggle('on', x.dataset.range === r));
}

export function setAddress(next) { address = next; history = []; }

export async function load() {
  if (!address) return;
  const want = address;
  const wantRange = range;
  const mySeq = ++seq;
  const since = wantRange === 'all' ? 0 : Date.now() - Number(wantRange);
  try {
    const { points } = await api.getHistory(want, since);
    // Stale-response guard: a superseded request (older pill click, or a wallet
    // switch that landed after this one started) must not repaint over a newer
    // result — mirrors exports.js's seq/want pattern.
    if (mySeq !== seq || want !== address) return;
    history = points;
    paintedRange = wantRange;
    paint();
  } catch (err) {
    // Same guard on the failure path: a rejection for a superseded request must
    // not toast over a newer success, nor revert a pill the user has since
    // changed again.
    if (mySeq !== seq || want !== address) return;
    toast('Could not load chart history: ' + errMsg(err), 'error');
    // Without this, a failed fetch leaves the pill highlighting a range whose data
    // was never painted — pill, chart and readout would all disagree.
    if (range !== paintedRange) { range = paintedRange; highlightRange(range); }
  }
}

export function reset() {
  address = null; history = [];
  range = 'all'; paintedRange = 'all';
  highlightRange('all');
  paint();
}

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
      range = b.dataset.range;
      highlightRange(range); // optimistic — reverted by load() if the fetch fails
      load(); // chart only — the cards and tables are unaffected by range
    }));
}
