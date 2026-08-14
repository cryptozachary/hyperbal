import * as api from './api.js';
import * as account from './account.js';
import * as fills from './fills.js';
import * as exportsPanel from './exports.js';
import * as wallets from './wallets.js';
import * as chartPanel from './chart-panel.js';
import { setStatus, setLoading, errMsg } from './feedback.js';

const $ = (id) => document.getElementById(id);

const state = {
  address: null, ws: null, pollTimer: null, refreshTimer: null, wsConnected: false,
};

function showError(msg) { const e = $('error'); e.textContent = msg; e.classList.remove('hidden'); }
function clearError() { $('error').classList.add('hidden'); }

// The card sparklines/deltas need their own fixed 24h window — the chart panel's
// `history` is range-scoped and reloads on every pill click, so wiring the cards
// to it would make their "always 24h" guarantee depend on whatever range the
// chart happens to be showing. Failures here are swallowed rather than routed to
// showError: a stale sparkline is a minor cosmetic gap, not a reason to blank the
// whole page the way a failed account fetch is.
let sparksSeq = 0; // generation guard — same mySeq/want pattern as chart-panel.js and exports.js
async function loadSparks() {
  if (!state.address) return;
  const want = state.address;
  const mySeq = ++sparksSeq;
  try {
    const { points } = await api.getHistory(state.address, Date.now() - 86400000);
    // Stale-response guard: an overlapping refresh (poll racing the refresh
    // button) or a wallet switch mid-flight must not paint over a newer result.
    if (mySeq !== sparksSeq || want !== state.address) return;
    account.renderSparks(points);
  } catch {}
}

async function refresh(showLoad = true) {
  if (!state.address) return;
  if (showLoad) setLoading(true);
  try {
    const data = await api.getAccount(state.address);
    clearError();
    account.render(data);
    await chartPanel.load();
    await loadSparks();
    await fills.load();
  } catch (err) { showError(errMsg(err)); } // failing here leaves the page empty — inline region, not a toast
  finally { setLoading(false); }
}

function scheduleRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(() => { state.refreshTimer = null; refresh(false); }, 1500);
}

// Clear every panel back to its empty state — used when the last wallet is deleted.
function resetDashboard() {
  state.address = null;
  account.reset();
  fills.reset();
  exportsPanel.reset();
  wallets.reset();
  chartPanel.reset();
  clearError();
  setStatus('Enter a wallet', 'poll');
}

async function selectAddress(address) {
  // Wipe the previous wallet's deltas/sparklines synchronously, before any async
  // work starts: render(d) below repaints the card values as soon as getAccount
  // resolves, but renderSparks() only arrives after a second, independent fetch
  // that can lag well behind (or fail and never arrive at all, via loadSparks's
  // own swallowed catch) — see clearTrends()'s comment in account.js.
  account.clearTrends();
  state.address = address;
  fills.setAddress(address);
  exportsPanel.setAddress(address);   // synchronous, in step with the others
  wallets.setCurrent(address);
  chartPanel.setAddress(address);
  await refresh(true);
  await wallets.renderAgents(address);
  await exportsPanel.loadPeriods();   // same position as before, ordering preserved
  if (state.wsConnected) state.ws.send(JSON.stringify({ type: 'watch', address }));
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    state.wsConnected = true;
    setStatus('Live', 'live');
    if (state.address) ws.send(JSON.stringify({ type: 'watch', address: state.address }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    // The hub keeps routing the previously-watched address until our `watch` for the
    // new one lands, so a broadcast can outrun a wallet switch. Ignore anything not
    // for the wallet on screen — and anything at all once it's been deleted.
    if (msg.address && msg.address !== state.address) return;
    if (msg.type === 'refresh') scheduleRefresh();
    else if (msg.type === 'realized') {
      if (!state.address) return; // wallet was just deleted; ignore in-flight fills for it
      account.setRealized(msg.realizedPnlCumulative);
      fills.scheduleReload();
    } else if (msg.type === 'error') showError(msg.message);
  };
  // WS down, but the always-on 30s poll keeps data fresh — show "Polling" (not an
  // alarming "down" state) while we reconnect in the background.
  ws.onclose = () => { state.wsConnected = false; setStatus('Polling', 'poll'); setTimeout(connectWs, 3000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => refresh(false), 30000);
}

async function init() {
  setStatus('Connecting…');
  chartPanel.mount();

  fills.mount();
  exportsPanel.mount({ onSynced: () => fills.load() });
  wallets.mount({ onSelect: selectAddress, onEmpty: resetDashboard });
  $('refreshBtn').addEventListener('click', () => refresh(true));

  // bootstrap: saved wallets + default (resolve in case DEFAULT_WALLET is an agent address)
  const { defaultWallet } = await api.getConfig();
  let preferred = defaultWallet || undefined;
  if (defaultWallet) {
    try {
      const { resolved } = await api.addWallet(defaultWallet);
      preferred = resolved?.address || defaultWallet;
    } catch {}
  }
  await wallets.load(preferred);
  connectWs();
  startPolling();
  const first = wallets.selectedValue() || preferred;
  if (first) await selectAddress(first);
  else setStatus('Enter a wallet', 'poll');
}

init();
