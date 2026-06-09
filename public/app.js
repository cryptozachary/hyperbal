const $ = (id) => document.getElementById(id);
const fmtUsd = (n) => n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtNum = (n, d = 4) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
const cls = (n) => n == null ? '' : n > 0 ? 'pos' : n < 0 ? 'neg' : '';

const state = { address: null, ws: null, pollTimer: null, series: 'equity', history: [], wsConnected: false };

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

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
      <td>${p.coin ?? '—'}</td>
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

// ---- Canvas chart (no library) ----
function drawChart() {
  const c = $('chart'); const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = 220;
  c.width = w * dpr; c.height = h * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const pts = state.history.map((p) => state.series === 'equity' ? p.equity : (p.unrealized_pnl ?? 0))
    .map((v) => v == null ? 0 : v);
  if (pts.length < 2) { ctx.fillStyle = '#8a97b1'; ctx.fillText('Not enough history yet.', 12, 24); return; }
  const min = Math.min(...pts), max = Math.max(...pts), pad = 24;
  const x = (i) => pad + (i / (pts.length - 1)) * (w - pad * 2);
  const y = (v) => max === min ? h / 2 : pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
  // grid baseline
  ctx.strokeStyle = '#222b3d'; ctx.beginPath(); ctx.moveTo(pad, h - pad); ctx.lineTo(w - pad, h - pad); ctx.stroke();
  // line
  ctx.strokeStyle = pts[pts.length - 1] >= pts[0] ? '#1fd09a' : '#ff5d6c';
  ctx.lineWidth = 2; ctx.beginPath();
  pts.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
  ctx.stroke();
  // last value label
  ctx.fillStyle = '#e6ebf5';
  ctx.fillText((state.series === 'equity' ? '$' : '') + pts[pts.length - 1].toFixed(2), w - pad - 60, y(pts[pts.length - 1]) - 6);
}

async function loadHistory() {
  if (!state.address) return;
  try { const { points } = await api(`/api/history/${state.address}`); state.history = points; drawChart(); } catch {}
}

// ---- WebSocket with fallback polling ----
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => { state.wsConnected = true; setStatus('Live', 'live'); stopPolling(); if (state.address) ws.send(JSON.stringify({ type: 'watch', address: state.address })); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'account') renderAccount(msg.data);
    else if (msg.type === 'realized') { $('rPnl').textContent = fmtUsd(msg.realizedPnlCumulative); $('rPnl').className = 'card-value ' + cls(msg.realizedPnlCumulative); }
    else if (msg.type === 'snapshot') { state.history.push(msg.point); drawChart(); }
    else if (msg.type === 'error') showError(msg.message);
  };
  ws.onclose = () => { state.wsConnected = false; setStatus('Reconnecting…', 'down'); startPolling(); setTimeout(connectWs, 3000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function startPolling() {
  if (state.pollTimer) return;
  setStatus('Polling', 'poll');
  state.pollTimer = setInterval(() => refresh(false), 30000);
}
function stopPolling() { clearInterval(state.pollTimer); state.pollTimer = null; }

async function refresh(showLoad = true) {
  if (!state.address) return;
  if (showLoad) setLoading(true);
  try {
    const data = await api(`/api/account/${state.address}`);
    renderAccount(data);
    await loadHistory();
  } catch (err) { showError(err.message); }
  finally { setLoading(false); }
}

// ---- Wallet management ----
async function loadWallets(selected) {
  const { wallets } = await api('/api/wallets');
  const sel = $('walletSelect'); sel.innerHTML = '';
  for (const w of wallets) {
    const o = document.createElement('option'); o.value = w.address;
    o.textContent = w.label ? `${w.label} (${w.address.slice(0, 6)}…)` : `${w.address.slice(0, 10)}…${w.address.slice(-4)}`;
    sel.appendChild(o);
  }
  if (selected) sel.value = selected;
}

async function selectAddress(address) {
  state.address = address; state.history = [];
  await refresh(true);
  if (state.wsConnected) state.ws.send(JSON.stringify({ type: 'watch', address }));
}

async function init() {
  setStatus('Connecting…');
  // chart toggle
  document.querySelectorAll('.toggle button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.toggle button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active'); state.series = b.dataset.series; drawChart();
    }));
  $('refreshBtn').addEventListener('click', () => refresh(true));
  window.addEventListener('resize', drawChart);

  $('addBtn').addEventListener('click', async () => {
    const address = $('walletInput').value.trim().toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { showError('Invalid wallet address.'); return; }
    try { await api('/api/wallets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) });
      $('walletInput').value = ''; await loadWallets(address); await selectAddress(address);
    } catch (e) { showError(e.message); }
  });
  $('removeBtn').addEventListener('click', async () => {
    const a = $('walletSelect').value; if (!a) return;
    await api(`/api/wallets/${a}`, { method: 'DELETE' }); await loadWallets();
    const next = $('walletSelect').value; if (next) selectAddress(next);
  });
  $('walletSelect').addEventListener('change', (e) => selectAddress(e.target.value));

  // bootstrap: saved wallets + default
  const { defaultWallet } = await api('/api/config');
  if (defaultWallet) { try { await api('/api/wallets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: defaultWallet }) }); } catch {} }
  await loadWallets(defaultWallet || undefined);
  connectWs();
  const first = $('walletSelect').value || defaultWallet;
  if (first) await selectAddress(first);
  else setStatus('Enter a wallet', 'poll');
}

init();
