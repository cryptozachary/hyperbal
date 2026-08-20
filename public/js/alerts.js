import { fmtTime, esc } from './format.js';
import * as api from './api.js';
import { toast, errMsg, confirmDialog } from './feedback.js';

const $ = (id) => document.getElementById(id);

let address = null;
let metrics = null;       // the server's whitelist; the dropdowns are built from it
let positions = [];       // current open positions, for the coin dropdown
let rows = [];
// Tri-state, deliberately: null means "the server hasn't told us yet", which is
// the panel's state for the whole first load. A boolean defaulted to false made
// that indistinguishable from a confirmed "not configured", so the panel disabled
// the test button and asserted a reason it had not yet checked.
let emailConfigured = null;
let loadSeq = 0;          // generation guard — same mySeq/want pattern as fills.js

// What to show beside the threshold input. roe is stored x100 and
// liquidationDistancePct is already a percentage, so an unlabelled box leaves the
// user guessing whether to type 15 or 0.15 — and both mistakes look like a broken
// feature rather than a mistyped number.
const UNIT_LABEL = { usd: 'USD', pct: '%', x: '×', count: '' };

// Mirrors describeRule()/formatValue() in alerts.js on the server — a deliberate
// hand copy so a row renders without a second round trip. Keep the two in step;
// the locale difference is intentional (the server pins en-US for email, the
// browser follows the viewer), the number formatting is not.
function describe(a) {
  const meta = metrics?.[a.scope]?.[a.metric];
  const name = meta ? meta.label : a.metric;
  const subject = a.scope === 'position' ? `${a.coin} ${name}` : name;
  return `${subject} ${a.operator} ${formatThreshold(a.threshold, meta?.unit)}`;
}

function formatThreshold(v, unit) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (unit === 'usd') return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (unit === 'pct') return `${v.toFixed(2)}%`;
  if (unit === 'x') return `${v}×`;
  return String(v);
}

function statusText(a) {
  if (!a.enabled) return 'paused';
  const fired = a.last_fired_at ? `last fired ${fmtTime(a.last_fired_at)}` : 'never fired';
  // last_state === null means the metric could not be resolved — usually a rule on
  // a position that is currently closed. Saying "armed" there would overstate it.
  return a.last_state == null ? `waiting for data · ${fired}` : `armed · ${fired}`;
}

// How the mail banner and the test button should read for a given knowledge state.
// Pure and exported so the three cases are pinned by a test rather than by reading
// paint(). While the answer is unknown the button stays live: a click then either
// works or returns the 503 that names the real problem, which beats a dead button
// under a confident, wrong explanation.
export function mailState(configured) {
  if (configured == null) return { disabled: false, warn: false };
  return { disabled: !configured, warn: !configured };
}

function paint() {
  const list = $('alertList');
  list.innerHTML = '';
  $('alertsEmpty').classList.toggle('hidden', rows.length > 0);

  for (const a of rows) {
    const row = document.createElement('div');
    row.className = 'alert-row' + (a.enabled ? '' : ' is-off');
    row.innerHTML = `
      <span class="alert-desc">${esc(describe(a))}</span>
      <span class="alert-meta">${esc(statusText(a))}</span>
      <button class="btn" data-act="toggle">${a.enabled ? 'Pause' : 'Resume'}</button>
      <button class="btn btn-danger" data-act="delete" aria-label="Delete alert">×</button>`;
    row.querySelector('[data-act="toggle"]').addEventListener('click', () => toggle(a));
    row.querySelector('[data-act="delete"]').addEventListener('click', () => remove(a));
    list.appendChild(row);
  }

  const { disabled, warn: showWarn } = mailState(emailConfigured);
  const warn = $('alertEmailWarn');
  warn.classList.toggle('hidden', !showWarn);
  warn.textContent = 'Email is not configured — alerts will be recorded but not sent. Set SMTP_HOST and ALERT_EMAIL_TO in .env.';
  $('alertTestBtn').disabled = disabled;
}

// Rebuild the metric dropdown for the selected scope, and show the coin dropdown
// only when it is meaningful.
function syncForm() {
  const scope = $('alertScope').value;
  const metricSel = $('alertMetric');
  metricSel.innerHTML = '';
  for (const [name, meta] of Object.entries(metrics?.[scope] || {})) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = meta.label;
    metricSel.appendChild(opt);
  }

  const showUnit = () => {
    const meta = metrics?.[scope]?.[metricSel.value];
    $('alertUnit').textContent = UNIT_LABEL[meta?.unit] ?? '';
  };
  showUnit();
  metricSel.onchange = showUnit;

  const coinSel = $('alertCoin');
  coinSel.classList.toggle('hidden', scope !== 'position');
  if (scope !== 'position') return;

  coinSel.innerHTML = '';
  if (!positions.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No open positions';
    coinSel.appendChild(opt);
    return;
  }
  // Deduped: mergeAccounts concatenates positions across perp dexes without
  // merging by coin, so a coin held on two dexes appears twice. A rule stores only
  // the coin and resolveMetric matches the first, so offering two identical
  // options would let the user pick one that silently watches the other.
  for (const coin of [...new Set(positions.map((p) => p.coin))]) {
    const opt = document.createElement('option');
    opt.value = coin;
    opt.textContent = coin;
    coinSel.appendChild(opt);
  }
}

export async function load() {
  if (!address) { rows = []; paint(); return; }
  const want = address;
  const mySeq = ++loadSeq;
  try {
    const data = await api.getAlerts(want);
    // Stale-response guard: a wallet switch mid-flight must not paint the previous
    // wallet's rules over the new one's.
    if (mySeq !== loadSeq || want !== address) return;
    rows = data.alerts;
    metrics = data.metrics;
    emailConfigured = data.emailConfigured;
    paint();
    syncForm();
  } catch (err) {
    if (mySeq !== loadSeq || want !== address) return;
    toast("Couldn't load alerts: " + errMsg(err), 'error');
  }
}

// Why a click cannot proceed, or null if it can. Pure and exported so every
// blocked case is pinned by a test. A bare `return` here produces a button that
// does nothing at all with no explanation, which is indistinguishable from a
// broken app — this panel shipped exactly that and it cost an afternoon.
export function addBlockedReason({ address, metrics, scope, coin }) {
  if (!address) return 'Select a wallet before adding an alert.';
  if (!metrics) return 'Alerts are still loading — give it a moment and try again.';
  if (scope === 'position' && !coin) return 'This wallet has no open positions to alert on.';
  return null;
}

async function add() {
  const scope = $('alertScope').value;
  const coin = $('alertCoin').value;
  const blocked = addBlockedReason({ address, metrics, scope, coin });
  if (blocked) { toast(blocked, 'error'); return; }

  const btn = $('alertAddBtn');
  btn.disabled = true;
  try {
    await api.createAlert({
      address, scope, coin: scope === 'position' ? coin : null,
      metric: $('alertMetric').value,
      operator: $('alertOperator').value,
      // Sent as a string; the server does the finite check and reports the reason.
      threshold: $('alertThreshold').value,
    });
    $('alertThreshold').value = '';
    await load();
  } catch (err) {
    toast("Couldn't add alert: " + errMsg(err), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function toggle(a) {
  try {
    await api.updateAlert(a.id, { enabled: !a.enabled });
    await load();
  } catch (err) {
    toast("Couldn't update alert: " + errMsg(err), 'error');
  }
}

async function remove(a) {
  const ok = await confirmDialog({
    title: 'Delete this alert?',
    body: describe(a),
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  try {
    await api.deleteAlert(a.id);
    await load();
  } catch (err) {
    toast("Couldn't delete alert: " + errMsg(err), 'error');
  }
}

// Called on every account refresh so the coin dropdown tracks what is actually held.
export function setPositions(next) {
  positions = next || [];
  if (metrics) syncForm();
}

export function setAddress(next) {
  address = next;
  // Otherwise the previous wallet's rules stay on screen, mislabelled, for the
  // whole round trip — same reasoning as fills.setAddress().
  rows = [];
  paint();
}

export function reset() {
  address = null;
  rows = [];
  positions = [];
  paint();
}

export function mount() {
  $('alertScope').addEventListener('change', syncForm);
  $('alertAddBtn').addEventListener('click', add);
  $('alertTestBtn').addEventListener('click', async () => {
    const btn = $('alertTestBtn');
    btn.disabled = true;
    try {
      await api.testAlertEmail();
      toast('Test email sent.', 'info');
    } catch (err) {
      toast("Couldn't send test email: " + errMsg(err), 'error');
    } finally {
      btn.disabled = mailState(emailConfigured).disabled;
    }
  });
}
