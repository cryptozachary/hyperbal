import * as api from './api.js';
import { createChart } from './chart.js';

const $ = (id) => document.getElementById(id);

let chart = null;
let address = null;
let series = 'equity';
let history = [];

function paint() { chart.render(history, { series }); }

export function setAddress(next) { address = next; history = []; }

export async function load() {
  if (!address) return;
  try {
    const { points } = await api.getHistory(address);
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
}
