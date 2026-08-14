import * as api from './api.js';
import { toast, errMsg } from './feedback.js';

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

let periodsSeq = 0;

// Async: fetches the available years. Clears the picker itself rather than relying
// on setAddress having just run — sync() calls this on its own, and appending to a
// populated picker duplicates every option.
export async function loadPeriods() {
  if (!address) return;
  const seq = ++periodsSeq;
  const want = address;
  const sel = $('exportYear');
  sel.innerHTML = '';
  try {
    const { minTs, maxTs } = await api.getRange(want);
    // Two rapid wallet switches can leave an older request resolving last; whoever
    // started most recently owns the picker.
    if (seq !== periodsSeq || want !== address) return;
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
    // A previous failed getRange may have disabled these — a successful refill
    // re-enables them rather than leaving a stale year-scoped export silently
    // degraded to all-time.
    $('exportDetailedBtn').disabled = false;
    $('exportKoinlyBtn').disabled = false;
  } catch (e) {
    if (seq !== periodsSeq || want !== address) return;
    // Leaving the picker empty used to also leave the download buttons enabled, so
    // a year-scoped export silently degraded to all-time. This doesn't leave the
    // dashboard unusable, so it's a toast, not the inline #error region — but the
    // buttons stay disabled until a later loadPeriods() succeeds.
    $('exportDetailedBtn').disabled = true;
    $('exportKoinlyBtn').disabled = true;
    toast('Could not load export periods: ' + errMsg(e), 'error');
  }
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
  // A failure now toasts instead of overwriting this line — save what was here
  // (e.g. a still-valid truncated-sync note) so a failed attempt can restore it
  // instead of leaving "Syncing…" stuck on screen.
  const prevText = out.textContent;
  out.textContent = 'Syncing from Hyperliquid…';
  // Defect fix: loadPeriods() below refills the picker and the browser resets the
  // selection to the first option — capture what was selected so we can restore it.
  const prevYear = $('exportYear').value;
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
      if (r.truncated) {
        syncResume[address] = { fills: r.fills.nextFrom, funding: r.funding.nextFrom };
        // Actionable and only explained here — this must not fade like a toast.
        out.textContent = `Synced: ${bits.join(', ')}. Stopped at the page limit — click again to continue from here.`;
      } else {
        delete syncResume[address];
        out.textContent = '';
        toast(`Synced: ${bits.join(', ')}.`, 'success');
      }
    }
    await onSynced();
    await loadPeriods();
    // Restore the previously selected period if the refilled picker still has it.
    const sel = $('exportYear');
    if (prevYear && [...sel.options].some((o) => o.value === prevYear)) sel.value = prevYear;
  } catch (e) {
    out.textContent = prevText;
    toast('Sync failed: ' + errMsg(e), 'error');
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
