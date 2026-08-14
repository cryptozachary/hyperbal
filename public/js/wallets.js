import * as api from './api.js';
import { short, esc } from './format.js';

const $ = (id) => document.getElementById(id);

let meta = {};
let handlers = { onSelect: () => {}, onEmpty: () => {}, onError: () => {} };

export const metaFor = (address) => meta[address];

export async function load(selected) {
  const { wallets } = await api.getWallets();
  meta = {};
  const sel = $('walletSelect');
  sel.innerHTML = '';
  for (const w of wallets) {
    meta[w.address] = { label: w.label, viaAgent: w.via_agent };
    const o = document.createElement('option');
    o.value = w.address;
    o.textContent = w.label
      ? `${w.label} (${w.address.slice(0, 6)}…)`
      : `${w.address.slice(0, 10)}…${w.address.slice(-4)}`;
    sel.appendChild(o);
  }
  if (selected) sel.value = selected;
  return wallets;
}

export const selectedValue = () => $('walletSelect').value;

export function renderBadge(address) {
  const m = meta[address];
  const el = $('walletBadge');
  if (m && m.viaAgent) {
    el.innerHTML = `Agent wallet <code>${short(m.viaAgent)}</code> → showing master <code>${short(address)}</code>`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

export async function renderAgents(address) {
  const panel = $('agentsPanel');
  panel.innerHTML = '';
  try {
    const { agents } = await api.getAgents(address);
    if (!agents.length) {
      panel.innerHTML = '<div class="agents-empty">No agent wallets connected.</div>';
      return;
    }
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

export function reset() {
  $('agentsPanel').innerHTML = '';
  $('walletBadge').classList.add('hidden');
}

export function mount(h) {
  handlers = h;
  $('addBtn').addEventListener('click', async () => {
    const address = $('walletInput').value.trim().toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { handlers.onError('Invalid wallet address.'); return; }
    try {
      const { resolved } = await api.addWallet(address);
      $('walletInput').value = '';
      const canonical = resolved?.address || address;
      await load(canonical);
      await handlers.onSelect(canonical);
    } catch (e) { handlers.onError(e.message); }
  });
  $('removeBtn').addEventListener('click', async () => {
    const a = selectedValue();
    if (!a) return;
    const m = meta[a];
    const name = m?.label ? `${m.label} (${short(a)})` : short(a);
    // Purging is irreversible: realized PnL is cumulative since first observed and
    // Hyperliquid only re-serves a limited recent window.
    if (!confirm(`Delete ${name}?\n\nThis also erases its stored trade history and equity snapshots. This cannot be undone.`)) return;
    try {
      await api.deleteWallet(a);
      await load();
      const next = selectedValue();
      if (next) await handlers.onSelect(next);
      else handlers.onEmpty();
    } catch (e) { handlers.onError(e.message); }
  });
  $('walletSelect').addEventListener('change', (e) => handlers.onSelect(e.target.value));
}
