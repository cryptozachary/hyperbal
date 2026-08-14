import { fmtUsd, fmtNum, cls, esc } from './format.js';

const $ = (id) => document.getElementById(id);

export function render(d) {
  $('equity').textContent = fmtUsd(d.equity);
  $('uPnl').textContent = fmtUsd(d.totalUnrealizedPnl);
  $('uPnl').className = 'card-value ' + cls(d.totalUnrealizedPnl);
  $('rPnl').textContent = fmtUsd(d.realizedPnlCumulative);
  $('rPnl').className = 'card-value ' + cls(d.realizedPnlCumulative);
  $('rPnlRecent').textContent =
    d.realizedPnlRecent != null ? `recent window: ${fmtUsd(d.realizedPnlRecent)}` : '';
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

// Live realized PnL arrives over the socket without a full account payload.
export function setRealized(value) {
  $('rPnl').textContent = fmtUsd(value);
  $('rPnl').className = 'card-value ' + cls(value);
}

export function reset() {
  for (const id of ['equity', 'uPnl', 'rPnl']) {
    $(id).textContent = '—';
    $(id).className = 'card-value';
  }
  $('rPnlRecent').textContent = '';
  $('posCount').textContent = '—';
  $('positions').querySelector('tbody').innerHTML = '';
  $('emptyState').classList.remove('hidden');
}
