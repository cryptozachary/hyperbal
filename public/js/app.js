import { fmtUsd, fmtNum, fmtTime, cls, short, esc } from './format.js';
import * as api from './api.js';
import { createChart } from './chart.js';

const $ = (id) => document.getElementById(id);

let chart = null;

const state = {
  address: null, ws: null, pollTimer: null, refreshTimer: null, fillsReloadTimer: null,
  series: 'equity', history: [], wsConnected: false, walletMeta: {},
  syncResume: {}, // address -> { fills, funding } cursors from a truncated sync
  fills: { rows: [], total: 0, limit: 50, offset: 0, closesOnly: false },
};

function setStatus(text, kind) { const el = $('status'); el.textContent = text; el.className = 'badge ' + (kind || ''); }
function showError(msg) { const e = $('error'); e.textContent = msg; e.classList.remove('hidden'); }
function clearError() { $('error').classList.add('hidden'); }
function setLoading(on) { $('loading').classList.toggle('hidden', !on); }

function renderAccount(d) {
  clearError();
  $('equity').textContent = fmtUsd(d.equity);
  $('uPnl').textContent = fmtUsd(d.totalUnrealizedPnl); $('uPnl').className = 'card-value ' + cls(d.totalUnrealizedPnl);
  $('rPnl').textContent = fmtUsd(d.realizedPnlCumulative); $('rPnl').className = 'card-value ' + cls(d.realizedPnlCumulative);
  $('rPnlRecent').textContent = d.realizedPnlRecent != null ? `recent window: ${fmtUsd(d.realizedPnlRecent)}` : '';
  $('posCount').textContent = d.openPositionsCount ?? 0;

  const tbody = $('positions').querySelector('tbody');
  tbody.innerHTML = '';
  const positions = d.positions || [];
  $('emptyState').classList.toggle('hidden', positions.length > 0);
  for (const p of positions) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(p.coin ?? '—')}${p.collateral ? ` · ${esc(p.collateral)}` : ''}</td>
      <td class="${p.side === 'LONG' ? 'side-long' : 'side-short'}">${p.side ?? '—'}</td>
      <td>${fmtNum(p.size)}</td>
      <td>${fmtNum(p.entryPrice, 2)}</td>
      <td>${fmtNum(p.markPrice, 2)}</td>
      <td>${fmtNum(p.liquidationPrice, 2)}</td>
      <td>${p.leverage != null ? p.leverage + 'x' : '—'}</td>
      <td>${fmtUsd(p.marginUsed)}</td>
      <td class="${cls(p.unrealizedPnl)}">${fmtUsd(p.unrealizedPnl)}</td>
      <td class="${cls(p.roe)}">${p.roe != null ? p.roe.toFixed(2) + '%' : '—'}</td>`;
    tbody.appendChild(tr);
  }
}

// Pre-migration rows have no dir; fall back to the raw HL side (B = bid/buy, A = ask/sell).
const dirText = (f) => f.dir || (f.side === 'B' ? 'Buy' : f.side === 'A' ? 'Sell' : '—');

function fillRowHtml(f) {
  return `
    <td>${fmtTime(f.ts)}</td>
    <td>${esc(f.coin ?? '—')}</td>
    <td>${esc(dirText(f))}</td>
    <td>${fmtNum(f.sz)}</td>
    <td>${fmtNum(f.px, 2)}</td>
    <td>${fmtUsd(f.fee)}</td>
    <td class="${cls(f.closed_pnl)}">${f.closed_pnl ? fmtUsd(f.closed_pnl) : '—'}</td>`;
}

function renderFills() {
  const f = state.fills;
  const tbody = $('fills').querySelector('tbody');
  tbody.innerHTML = '';
  $('fillsEmpty').classList.toggle('hidden', f.rows.length > 0);
  for (const row of f.rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = fillRowHtml(row);
    tbody.appendChild(tr);
  }
  const first = f.total === 0 ? 0 : f.offset + 1;
  const last = Math.min(f.offset + f.rows.length, f.total);
  $('fillsRange').textContent = f.total === 0 ? '—' : `${first}–${last} of ${f.total}`;
  $('fillsPrev').disabled = f.offset === 0;
  $('fillsNext').disabled = f.offset + f.limit >= f.total;
}

async function loadFills(retried = false) {
  if (!state.address) { state.fills.rows = []; state.fills.total = 0; renderFills(); return; }
  const f = state.fills;
  try {
    const data = await api.getFills(state.address, f);
    // The page can fall off the end of the data (a purge elsewhere, another tab,
    // a server restart). Clamp back to the last real page instead of rendering an
    // empty table under a "401–300 of 300" range.
    if (!retried && !data.fills.length && data.total > 0 && f.offset > 0) {
      f.offset = Math.max(0, (Math.ceil(data.total / f.limit) - 1) * f.limit);
      return loadFills(true);
    }
    f.rows = data.fills;
    f.total = data.total;
    renderFills();
  } catch (err) { showError(err.message); }
}

// Year bounds are computed HERE, in the browser's timezone, and sent as explicit
// epoch ms — so the server never has to guess where the user's year starts.
function yearBounds(year) {
  return { from: new Date(year, 0, 1).getTime(), to: new Date(year + 1, 0, 1).getTime() };
}

function setExportEnabled(on) {
  for (const id of ['exportYear', 'exportDetailedBtn', 'exportKoinlyBtn', 'syncBtn']) $(id).disabled = !on;
}

async function loadExportYears() {
  const sel = $('exportYear');
  sel.innerHTML = '';
  if (!state.address) { setExportEnabled(false); return; }
  setExportEnabled(true);
  try {
    const { minTs, maxTs } = await api.getRange(state.address);
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

function downloadExport(format) {
  if (!state.address) return;
  const sel = $('exportYear').value;
  const params = new URLSearchParams({ format, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
  if (sel && sel !== 'all') {
    const { from, to } = yearBounds(Number(sel));
    params.set('from', String(from));
    params.set('to', String(to));
    params.set('label', sel);
  }
  // Assigning window.location (not fetching) is what turns this into a download.
  window.location = api.exportUrl(state.address, params);
}

async function syncHistory() {
  if (!state.address) return;
  const out = $('syncResult');
  $('syncBtn').disabled = true;
  out.textContent = 'Syncing from Hyperliquid…';
  try {
    // Resume where a previous truncated run stopped. Without carrying these the
    // next run would restart at 0, re-scan what it already has, and stop in the
    // same place — so "run again to continue" would be a lie.
    const resume = state.syncResume[state.address];
    const r = await api.backfill(state.address, resume);
    if (r.skipped) {
      out.textContent = 'Nothing synced — this wallet is not on your saved list.';
      delete state.syncResume[state.address];
    } else {
      // `enriched` counts pre-existing fills that gained a missing field.
      const bits = [
        `${r.fills.inserted} new fills`,
        `${r.fills.enriched} existing fills completed`,
        `${r.funding.inserted} funding entries`,
      ];
      if (r.truncated) {
        state.syncResume[state.address] = { fills: r.fills.nextFrom, funding: r.funding.nextFrom };
      } else {
        delete state.syncResume[state.address];
      }
      out.textContent = `Synced: ${bits.join(', ')}.` +
        (r.truncated ? ' Stopped at the page limit — click again to continue from here.' : '');
    }
    await loadFills();
    await loadExportYears();
  } catch (e) {
    out.textContent = `Sync failed: ${e.message}`;
  } finally {
    $('syncBtn').disabled = false;
  }
}

// New fills arrived. Re-read page 1 from the server rather than splicing them in:
// the upstream userFills sub replays a snapshot on every reconnect, so a client-side
// running total drifts and a blind prepend can push the genuinely-newest rows off
// the page. The DB is the only thing that knows the real count and order.
function scheduleFillsReload() {
  if (state.fillsReloadTimer || state.fills.offset !== 0) return;
  state.fillsReloadTimer = setTimeout(() => { state.fillsReloadTimer = null; loadFills(); }, 300);
}

function renderWalletBadge(address) {
  const meta = state.walletMeta[address];
  const el = $('walletBadge');
  if (meta && meta.viaAgent) {
    el.innerHTML = `Agent wallet <code>${short(meta.viaAgent)}</code> → showing master <code>${short(address)}</code>`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// Clear every panel back to its empty state — used when the last wallet is deleted.
function resetDashboard() {
  state.address = null;
  state.history = [];
  state.fills = { rows: [], total: 0, limit: 50, offset: 0, closesOnly: false };
  clearTimeout(state.fillsReloadTimer); state.fillsReloadTimer = null;
  for (const id of ['equity', 'uPnl', 'rPnl']) { $(id).textContent = '—'; $(id).className = 'card-value'; }
  $('rPnlRecent').textContent = '';
  $('posCount').textContent = '—';
  $('positions').querySelector('tbody').innerHTML = '';
  $('emptyState').classList.remove('hidden');
  $('agentsPanel').innerHTML = '';
  $('walletBadge').classList.add('hidden');
  $('exportYear').innerHTML = '';
  $('syncResult').textContent = '';
  setExportEnabled(false);
  // Keep the filter buttons in sync with the closesOnly reset above.
  $('fillsClosesBtn').classList.remove('active');
  $('fillsAllBtn').classList.add('active');
  renderFills();
  chart.render(state.history, { series: state.series });
  clearError();
  setStatus('Enter a wallet', 'poll');
}

async function loadAgents(address) {
  const panel = $('agentsPanel');
  panel.innerHTML = '';
  try {
    const { agents } = await api.getAgents(address);
    if (!agents.length) { panel.innerHTML = '<div class="agents-empty">No agent wallets connected.</div>'; return; }
    for (const a of agents) {
      const row = document.createElement('div');
      row.className = 'agent-row' + (a.expired ? ' expired' : '');
      const validTxt = a.validUntil != null ? new Date(a.validUntil).toLocaleDateString() : '—';
      const expiredTxt = a.expired ? ' <span class="agent-badge-expired">expired</span>' : '';
      row.innerHTML = `<span class="agent-name">${esc(a.name || 'Agent')}</span>
        <span class="agent-meta">${short(a.address)} · valid until ${validTxt}${expiredTxt}</span>`;
      panel.appendChild(row);
    }
  } catch {
    panel.innerHTML = '<div class="agents-empty">Couldn\'t load connected agents.</div>';
  }
}

async function loadHistory() {
  if (!state.address) return;
  try {
    const { points } = await api.getHistory(state.address);
    state.history = points;
    chart.render(state.history, { series: state.series });
  } catch {}
}

function scheduleRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(() => { state.refreshTimer = null; refresh(false); }, 1500);
}

// ---- WebSocket with fallback polling ----
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => { state.wsConnected = true; setStatus('Live', 'live'); if (state.address) ws.send(JSON.stringify({ type: 'watch', address: state.address })); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    // The hub keeps routing the previously-watched address until our `watch` for the
    // new one lands, so a broadcast can outrun a wallet switch. Ignore anything not
    // for the wallet on screen — and anything at all once it's been deleted.
    if (msg.address && msg.address !== state.address) return;
    if (msg.type === 'refresh') scheduleRefresh();
    else if (msg.type === 'realized') {
      if (!state.address) return; // wallet was just deleted; ignore in-flight fills for it
      $('rPnl').textContent = fmtUsd(msg.realizedPnlCumulative); $('rPnl').className = 'card-value ' + cls(msg.realizedPnlCumulative);
      scheduleFillsReload();
    }
    else if (msg.type === 'error') showError(msg.message);
  };
  // WS down, but the always-on 30s poll keeps data fresh — show "Polling" (not an alarming "down" state) while we reconnect in the background.
  ws.onclose = () => { state.wsConnected = false; setStatus('Polling', 'poll'); setTimeout(connectWs, 3000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => refresh(false), 30000);
}

async function refresh(showLoad = true) {
  if (!state.address) return;
  if (showLoad) setLoading(true);
  try {
    const data = await api.getAccount(state.address);
    renderAccount(data);
    await loadHistory();
    await loadFills();
  } catch (err) { showError(err.message); }
  finally { setLoading(false); }
}

// ---- Wallet management ----
async function loadWallets(selected) {
  const { wallets } = await api.getWallets();
  state.walletMeta = {};
  const sel = $('walletSelect'); sel.innerHTML = '';
  for (const w of wallets) {
    state.walletMeta[w.address] = { label: w.label, viaAgent: w.via_agent };
    const o = document.createElement('option'); o.value = w.address;
    o.textContent = w.label ? `${w.label} (${w.address.slice(0, 6)}…)` : `${w.address.slice(0, 10)}…${w.address.slice(-4)}`;
    sel.appendChild(o);
  }
  if (selected) sel.value = selected;
}

async function selectAddress(address) {
  state.address = address; state.history = [];
  state.fills.offset = 0;
  renderWalletBadge(address);
  await refresh(true);
  await loadAgents(address);
  await loadExportYears();
  if (state.wsConnected) state.ws.send(JSON.stringify({ type: 'watch', address }));
}

async function init() {
  setStatus('Connecting…');
  chart = createChart($('chart'));
  // chart toggle
  document.querySelectorAll('#chartToggle button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#chartToggle button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active'); state.series = b.dataset.series; chart.render(state.history, { series: state.series });
    }));
  // fills filter toggle
  const setFillsFilter = (closesOnly, activeBtn) => {
    document.querySelectorAll('#fillsAllBtn, #fillsClosesBtn').forEach((b) => b.classList.remove('active'));
    activeBtn.classList.add('active');
    state.fills.closesOnly = closesOnly;
    state.fills.offset = 0;
    loadFills();
  };
  $('fillsAllBtn').addEventListener('click', (e) => setFillsFilter(false, e.currentTarget));
  $('fillsClosesBtn').addEventListener('click', (e) => setFillsFilter(true, e.currentTarget));
  $('fillsPrev').addEventListener('click', () => {
    state.fills.offset = Math.max(0, state.fills.offset - state.fills.limit);
    loadFills();
  });
  $('fillsNext').addEventListener('click', () => {
    if (state.fills.offset + state.fills.limit < state.fills.total) {
      state.fills.offset += state.fills.limit;
      loadFills();
    }
  });

  $('exportDetailedBtn').addEventListener('click', () => downloadExport('detailed'));
  $('exportKoinlyBtn').addEventListener('click', () => downloadExport('koinly'));
  $('syncBtn').addEventListener('click', syncHistory);

  $('refreshBtn').addEventListener('click', () => refresh(true));

  $('addBtn').addEventListener('click', async () => {
    const address = $('walletInput').value.trim().toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { showError('Invalid wallet address.'); return; }
    try {
      const { resolved } = await api.addWallet(address);
      $('walletInput').value = '';
      const canonical = resolved?.address || address;
      await loadWallets(canonical);
      await selectAddress(canonical);
    } catch (e) { showError(e.message); }
  });
  $('removeBtn').addEventListener('click', async () => {
    const a = $('walletSelect').value; if (!a) return;
    const meta = state.walletMeta[a];
    const name = meta?.label ? `${meta.label} (${short(a)})` : short(a);
    // Purging is irreversible: realized PnL is cumulative since first observed and
    // Hyperliquid only re-serves a limited recent window.
    if (!confirm(`Delete ${name}?\n\nThis also erases its stored trade history and equity snapshots. This cannot be undone.`)) return;
    try {
      await api.deleteWallet(a);
      await loadWallets();
      const next = $('walletSelect').value;
      if (next) await selectAddress(next);
      else resetDashboard();
    } catch (e) { showError(e.message); }
  });
  $('walletSelect').addEventListener('change', (e) => selectAddress(e.target.value));

  // bootstrap: saved wallets + default (resolve in case DEFAULT_WALLET is an agent address)
  const { defaultWallet } = await api.getConfig();
  let preferred = defaultWallet || undefined;
  if (defaultWallet) {
    try {
      const { resolved } = await api.addWallet(defaultWallet);
      preferred = resolved?.address || defaultWallet;
    } catch {}
  }
  await loadWallets(preferred);
  connectWs();
  startPolling();
  const first = $('walletSelect').value || preferred;
  if (first) await selectAddress(first);
  else setStatus('Enter a wallet', 'poll');
}

init();
