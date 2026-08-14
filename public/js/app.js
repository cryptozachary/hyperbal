import * as api from './api.js';
import * as account from './account.js';
import * as fills from './fills.js';
import * as exportsPanel from './exports.js';
import * as wallets from './wallets.js';
import { createChart } from './chart.js';

const $ = (id) => document.getElementById(id);

const state = {
  address: null, ws: null, pollTimer: null, refreshTimer: null,
  series: 'equity', history: [], wsConnected: false,
};

let chart = null;

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'badge ' + (kind || '');
}
function showError(msg) { const e = $('error'); e.textContent = msg; e.classList.remove('hidden'); }
function clearError() { $('error').classList.add('hidden'); }
function setLoading(on) { $('loading').classList.toggle('hidden', !on); }

async function loadHistory() {
  if (!state.address) return;
  try {
    const { points } = await api.getHistory(state.address);
    state.history = points;
    chart.render(state.history, { series: state.series });
  } catch {}
}

async function refresh(showLoad = true) {
  if (!state.address) return;
  if (showLoad) setLoading(true);
  try {
    const data = await api.getAccount(state.address);
    clearError();
    account.render(data);
    await loadHistory();
    await fills.load();
  } catch (err) { showError(err.message); }
  finally { setLoading(false); }
}

function scheduleRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(() => { state.refreshTimer = null; refresh(false); }, 1500);
}

// Clear every panel back to its empty state — used when the last wallet is deleted.
function resetDashboard() {
  state.address = null;
  state.history = [];
  account.reset();
  fills.reset();
  exportsPanel.reset();
  wallets.reset();
  chart.render([], { series: state.series });
  clearError();
  setStatus('Enter a wallet', 'poll');
}

async function selectAddress(address) {
  state.address = address;
  state.history = [];
  fills.setAddress(address);
  wallets.renderBadge(address);
  await refresh(true);
  await wallets.renderAgents(address);
  await exportsPanel.setAddress(address);
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
  chart = createChart($('chart'));

  document.querySelectorAll('#chartToggle button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#chartToggle button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.series = b.dataset.series;
      chart.render(state.history, { series: state.series });
    }));

  fills.mount({ onError: showError });
  exportsPanel.mount({ onSynced: () => fills.load() });
  wallets.mount({ onSelect: selectAddress, onEmpty: resetDashboard, onError: showError });
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
