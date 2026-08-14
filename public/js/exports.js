import * as api from './api.js';

const $ = (id) => document.getElementById(id);

let address = null;
let onSynced = () => {};
const syncResume = {}; // address -> { fills, funding } cursors from a truncated sync

// Year bounds are computed HERE, in the browser's timezone, and sent as explicit
// epoch ms — so the server never has to guess where the user's year starts.
function yearBounds(year) {
  return { from: new Date(year, 0, 1).getTime(), to: new Date(year + 1, 0, 1).getTime() };
}

function setEnabled(on) {
  for (const id of ['exportYear', 'exportDetailedBtn', 'exportKoinlyBtn', 'syncBtn']) $(id).disabled = !on;
}

// Synchronous: must land in the same block as the other panels' address
// assignment, or the export buttons stay live pointing at the previous wallet.
export function setAddress(next) {
  address = next;
  $('exportYear').innerHTML = '';
  setEnabled(Boolean(address));
}

// Async: fetches the available years.
export async function loadPeriods() {
  if (!address) return;
  const sel = $('exportYear');
  try {
    const { minTs, maxTs } = await api.getRange(address);
    const opts = [];
    if (minTs != null && maxTs != null) {
      const first = new Date(minTs).getFullYear();
      const last = new Date(maxTs).getFullYear();
      for (let y = last; y >= first; y--) opts.push({ value: String(y), text: String(y) });
    }
    opts.push({ value: 'all', text: 'All time' });
    for (const o of opts) {
      const el = document.createElement('option');
      el.value = o.value; el.textContent = o.text;
      sel.appendChild(el);
    }
  } catch { /* leave the picker empty; the download buttons will report the error */ }
}

function download(format) {
  if (!address) return;
  const sel = $('exportYear').value;
  const params = new URLSearchParams({
    format,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  });
  if (sel && sel !== 'all') {
    const { from, to } = yearBounds(Number(sel));
    params.set('from', String(from));
    params.set('to', String(to));
    params.set('label', sel);
  }
  // Assigning window.location (not fetching) is what turns this into a download.
  window.location = api.exportUrl(address, params);
}

async function sync() {
  if (!address) return;
  const out = $('syncResult');
  $('syncBtn').disabled = true;
  out.textContent = 'Syncing from Hyperliquid…';
  try {
    // Resume where a previous truncated run stopped. Without carrying these the
    // next run would restart at 0, re-scan what it already has, and stop in the
    // same place — so "run again to continue" would be a lie.
    const r = await api.backfill(address, syncResume[address]);
    if (r.skipped) {
      out.textContent = 'Nothing synced — this wallet is not on your saved list.';
      delete syncResume[address];
    } else {
      // `enriched` counts pre-existing fills that gained a missing field.
      const bits = [
        `${r.fills.inserted} new fills`,
        `${r.fills.enriched} existing fills completed`,
        `${r.funding.inserted} funding entries`,
      ];
      if (r.truncated) syncResume[address] = { fills: r.fills.nextFrom, funding: r.funding.nextFrom };
      else delete syncResume[address];
      out.textContent = `Synced: ${bits.join(', ')}.` +
        (r.truncated ? ' Stopped at the page limit — click again to continue from here.' : '');
    }
    await onSynced();
    await loadPeriods();
  } catch (e) {
    out.textContent = `Sync failed: ${e.message}`;
  } finally {
    $('syncBtn').disabled = false;
  }
}

export function reset() {
  address = null;
  $('exportYear').innerHTML = '';
  $('syncResult').textContent = '';
  setEnabled(false);
}

export function mount(handlers) {
  onSynced = handlers.onSynced;
  $('exportDetailedBtn').addEventListener('click', () => download('detailed'));
  $('exportKoinlyBtn').addEventListener('click', () => download('koinly'));
  $('syncBtn').addEventListener('click', sync);
}
