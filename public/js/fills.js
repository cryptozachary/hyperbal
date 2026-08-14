import { fmtUsd, fmtNum, fmtTime, cls, esc } from './format.js';
import * as api from './api.js';
import { skeletonRows, errMsg } from './feedback.js';

const $ = (id) => document.getElementById(id);

const view = { rows: [], total: 0, limit: 50, offset: 0, closesOnly: false };
let address = null;
let reloadTimer = null;
let onError = () => {};

// Pre-migration rows have no dir; fall back to the raw HL side (B = bid/buy, A = ask/sell).
const dirText = (f) => f.dir || (f.side === 'B' ? 'Buy' : f.side === 'A' ? 'Sell' : '—');

function rowHtml(f) {
  return `
    <td>${fmtTime(f.ts)}</td>
    <td>${esc(f.coin ?? '—')}</td>
    <td>${esc(dirText(f))}</td>
    <td>${fmtNum(f.sz)}</td>
    <td>${fmtNum(f.px, 2)}</td>
    <td>${fmtUsd(f.fee)}</td>
    <td class="${cls(f.closed_pnl)}">${f.closed_pnl ? fmtUsd(f.closed_pnl) : '—'}</td>`;
}

function paint() {
  const tbody = $('fills').querySelector('tbody');
  tbody.innerHTML = '';
  $('fillsEmpty').classList.toggle('hidden', view.rows.length > 0);
  for (const row of view.rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = rowHtml(row);
    tbody.appendChild(tr);
  }
  const first = view.total === 0 ? 0 : view.offset + 1;
  const last = Math.min(view.offset + view.rows.length, view.total);
  $('fillsRange').textContent = view.total === 0 ? '—' : `${first}–${last} of ${view.total}`;
  $('fillsPrev').disabled = view.offset === 0;
  $('fillsNext').disabled = view.offset + view.limit >= view.total;
}

export async function load(retried = false) {
  if (!address) { view.rows = []; view.total = 0; paint(); return; }
  if (view.rows.length === 0) skeletonRows($('fills').querySelector('tbody'), 7);
  try {
    const data = await api.getFills(address, view);
    // The page can fall off the end of the data (a purge elsewhere, another tab,
    // a server restart). Clamp back to the last real page instead of rendering an
    // empty table under a "401–300 of 300" range.
    if (!retried && !data.fills.length && data.total > 0 && view.offset > 0) {
      view.offset = Math.max(0, (Math.ceil(data.total / view.limit) - 1) * view.limit);
      return load(true);
    }
    view.rows = data.fills;
    view.total = data.total;
    paint();
  } catch (err) { paint(); onError(errMsg(err)); } // repaint over the skeleton rows — a failed fetch must not leave them shimmering forever
}

// New fills arrived. Re-read page 1 from the server rather than splicing them in:
// the upstream userFills sub replays a snapshot on every reconnect, so a client-side
// running total drifts and a blind prepend can push the genuinely-newest rows off
// the page. The DB is the only thing that knows the real count and order.
export function scheduleReload() {
  if (reloadTimer || view.offset !== 0) return;
  reloadTimer = setTimeout(() => { reloadTimer = null; load(); }, 300);
}

export function setAddress(next) {
  address = next;
  view.offset = 0;
}

export function reset() {
  address = null;
  Object.assign(view, { rows: [], total: 0, limit: 50, offset: 0, closesOnly: false });
  clearTimeout(reloadTimer); reloadTimer = null;
  // Keep the filter buttons in sync with the closesOnly reset above.
  $('fillsClosesBtn').classList.remove('active');
  $('fillsAllBtn').classList.add('active');
  paint();
}

export function mount(handlers) {
  onError = handlers.onError;
  const setFilter = (closesOnly, activeBtn) => {
    document.querySelectorAll('#fillsAllBtn, #fillsClosesBtn').forEach((b) => b.classList.remove('active'));
    activeBtn.classList.add('active');
    view.closesOnly = closesOnly;
    view.offset = 0;
    load();
  };
  $('fillsAllBtn').addEventListener('click', (e) => setFilter(false, e.currentTarget));
  $('fillsClosesBtn').addEventListener('click', (e) => setFilter(true, e.currentTarget));
  $('fillsPrev').addEventListener('click', () => {
    view.offset = Math.max(0, view.offset - view.limit);
    load();
  });
  $('fillsNext').addEventListener('click', () => {
    if (view.offset + view.limit < view.total) { view.offset += view.limit; load(); }
  });
}
