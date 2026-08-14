import { fmtUsd, fmtNum, fmtTime, cls, esc } from './format.js';
import * as api from './api.js';
import { skeletonRows, toast, errMsg } from './feedback.js';

const $ = (id) => document.getElementById(id);

const view = { rows: [], total: 0, limit: 50, offset: 0, closesOnly: false };
let address = null;
let reloadTimer = null;

// Pre-migration rows have no dir; fall back to the raw HL side (B = bid/buy, A = ask/sell).
const dirText = (f) => f.dir || (f.side === 'B' ? 'Buy' : f.side === 'A' ? 'Sell' : '—');

// Color by whether the fill actually bought or sold, not by parsing the label text.
// `dir` is HL's human phrasing and it is not safe to pattern-match: "Close Short" is
// a BUY (buying back to close a short) even though the text contains neither "buy"
// nor is that obvious from a quick regex, and HL also emits flip phrasings like
// "Long > Short" that don't fit an Open/Close vocabulary at all. `side` ('B' = bid =
// buy, 'A' = ask = sell) is the authoritative raw flag for every fill regardless of
// how `dir` reads, so it — not the text — decides the chip color.
function dirChip(f) {
  const text = dirText(f);
  const kind = f.side === 'B' ? 'buy' : f.side === 'A' ? 'sell' : 'flat';
  return `<span class="chip chip-${kind}">${esc(text)}</span>`;
}

function rowHtml(f) {
  return `
    <td>${fmtTime(f.ts)}</td>
    <td><span class="coin">${esc(f.coin ?? '—')}</span></td>
    <td>${dirChip(f)}</td>
    <td>${fmtNum(f.sz)}</td>
    <td>${fmtNum(f.px, 2)}</td>
    <td>${fmtUsd(f.fee)}</td>
    <td class="${cls(f.closed_pnl)}">${f.closed_pnl ? fmtUsd(f.closed_pnl) : '—'}</td>`;
}

// The single place that reflects `view` (the committed state) into the DOM — the
// filter buttons' active class included, so a click only moves the highlight once
// its fetch has actually landed and view.closesOnly has been committed to match.
function syncFilterButtons() {
  $('fillsAllBtn').classList.toggle('active', !view.closesOnly);
  $('fillsClosesBtn').classList.toggle('active', view.closesOnly);
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
  syncFilterButtons();
}

// A failed fetch when we had nothing on screen yet (skeleton rows showing) must not
// leave them shimmering forever, but repainting with the unchanged (empty) view.rows
// would falsely assert "No trades recorded" when the truth is "we don't know" —
// so this replaces the skeleton with an explicit unknown-state row instead of
// routing through paint(). A failure with real rows already on screen leaves them
// alone; the toast is the only signal.
function errorRow(tbody) {
  $('fillsEmpty').classList.add('hidden'); // neither a skeleton nor an error row is "empty"
  tbody.innerHTML = '<tr><td colspan="7" class="empty">Couldn\'t load trade history.</td></tr>';
}

// `pending` carries an in-flight offset/closesOnly that hasn't been committed to
// `view` yet. A failing fetch must leave the page exactly as it was — rows, range
// label, and the filter highlight all still describing the last successful load —
// so fillsNext/fillsPrev/the filter buttons pass their candidate values in here
// rather than writing them onto `view` up front. Only a successful fetch commits
// them (see below); a rejected one leaves `view` (and everything paint() reflects)
// untouched, with the toast as the only signal.
export async function load(retried = false, pending = {}) {
  if (!address) { view.rows = []; view.total = 0; paint(); return; }
  const offset = 'offset' in pending ? pending.offset : view.offset;
  const closesOnly = 'closesOnly' in pending ? pending.closesOnly : view.closesOnly;
  const showedSkeleton = view.rows.length === 0;
  if (showedSkeleton) {
    // paint() is the only thing that shows #fillsEmpty, but it's a sibling div that
    // neither skeletonRows() nor errorRow() routes through — left un-hidden from a
    // prior empty state, it would sit underneath the skeleton (or the error row)
    // claiming "No trades recorded" while we don't actually know that yet.
    $('fillsEmpty').classList.add('hidden');
    skeletonRows($('fills').querySelector('tbody'), 7);
  }
  try {
    const data = await api.getFills(address, { limit: view.limit, offset, closesOnly });
    // The page can fall off the end of the data (a purge elsewhere, another tab,
    // a server restart). Clamp back to the last real page instead of rendering an
    // empty table under a "401–300 of 300" range.
    if (!retried && !data.fills.length && data.total > 0 && offset > 0) {
      const clamped = Math.max(0, (Math.ceil(data.total / view.limit) - 1) * view.limit);
      return load(true, { offset: clamped, closesOnly });
    }
    // Commit the candidate offset/closesOnly only now that the fetch that used them
    // has actually succeeded — a failed click must not advance the page or move the
    // filter highlight while the rows underneath stay on the old page.
    view.offset = offset;
    view.closesOnly = closesOnly;
    view.rows = data.fills;
    view.total = data.total;
    paint();
  } catch (err) {
    if (showedSkeleton) errorRow($('fills').querySelector('tbody'));
    toast("Couldn't load trade history: " + errMsg(err), 'error');
  }
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
  // Otherwise the previous wallet's rows stay on screen — undimmed, mislabelled —
  // through the whole round trip, and skeletonRows() (gated on an empty view) never
  // fires because view.rows still looks populated.
  view.rows = [];
  view.total = 0;
}

export function reset() {
  address = null;
  Object.assign(view, { rows: [], total: 0, limit: 50, offset: 0, closesOnly: false });
  clearTimeout(reloadTimer); reloadTimer = null;
  paint(); // also re-syncs the filter buttons from the closesOnly reset above
}

export function mount() {
  const setFilter = (closesOnly) => {
    if (closesOnly === view.closesOnly) return; // already the active filter
    load(false, { offset: 0, closesOnly });
  };
  $('fillsAllBtn').addEventListener('click', () => setFilter(false));
  $('fillsClosesBtn').addEventListener('click', () => setFilter(true));
  $('fillsPrev').addEventListener('click', () => {
    if (view.offset === 0) return;
    load(false, { offset: Math.max(0, view.offset - view.limit) });
  });
  $('fillsNext').addEventListener('click', () => {
    if (view.offset + view.limit < view.total) load(false, { offset: view.offset + view.limit });
  });
}
