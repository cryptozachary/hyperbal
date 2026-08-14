import * as api from './api.js';
import { short, esc } from './format.js';
import { confirmDialog, toast, errMsg } from './feedback.js';

const $ = (id) => document.getElementById(id);

let meta = {};
let list = [];
let current = null;
let handlers = { onSelect: () => {}, onEmpty: () => {} };

export const metaFor = (address) => meta[address];

// Deterministic per-address color so a wallet is recognisable at a glance.
function hueFor(address) {
  let h = 0;
  for (let i = 2; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) % 360;
  return h;
}

const nameFor = (w) => w.label || `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;

function paintSwitcher() {
  const w = list.find((x) => x.address === current);
  $('walletName').textContent = w ? nameFor(w) : 'No wallet';
  $('walletCount').textContent = list.length ? `${list.length} wallet${list.length > 1 ? 's' : ''}` : '';
  const av = $('walletAvatar');
  av.style.background = w
    ? `linear-gradient(135deg, hsl(${hueFor(w.address)} 70% 60%), hsl(${(hueFor(w.address) + 60) % 360} 70% 50%))`
    : 'var(--surface-2)';
}

// The "via agent" notice lives in #walletBadge inside <main> (untouched by Task 12's
// header rewrite) — setCurrent still owns it, same as it did before this popover existed.
function paintBadge(address) {
  const m = meta[address];
  const el = $('walletBadge');
  if (m && m.viaAgent) {
    el.innerHTML = `Agent wallet <code>${short(m.viaAgent)}</code> → showing master <code>${short(address)}</code>`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function paintList() {
  const host = $('walletList');
  host.innerHTML = '';
  if (!list.length) { host.innerHTML = '<div class="agents-empty">No wallets yet.</div>'; return; }
  for (const w of list) {
    const row = document.createElement('div');
    row.className = 'pop-row';
    const pick = document.createElement('button');
    pick.className = 'pop-item' + (w.address === current ? ' sel' : '');
    pick.dataset.address = w.address;
    // Labels are arbitrary server-stored strings — escape before interpolating into innerHTML.
    pick.innerHTML = `<span>${esc(nameFor(w))}${w.via_agent ? ' <span class="via">via agent</span>' : ''}</span>`;
    pick.addEventListener('click', async () => { close(); await handlers.onSelect(w.address); });
    const del = document.createElement('button');
    del.className = 'pop-del';
    del.setAttribute('aria-label', `Delete ${nameFor(w)}`); // setAttribute, not innerHTML — no escaping needed
    del.textContent = '✕';
    del.addEventListener('click', (e) => { e.stopPropagation(); remove(w); });
    row.append(pick, del);
    host.appendChild(row);
  }
}

async function remove(w) {
  // Close the popover before the confirm dialog opens rather than leaving it open
  // behind the modal. confirmDialog installs its own document-level keydown listener
  // and inerts every <body> child but #modalRoot/#toasts (which includes <header>, so
  // the popover would go inert either way) — leaving our own keydown/pointerdown
  // listeners registered too would mean two document 'keydown' handlers independently
  // reacting to the same Escape press. Closing first removes ours before the dialog's
  // goes on, so there's exactly one handler live at a time.
  close();
  const ok = await confirmDialog({
    title: `Delete ${nameFor(w)}?`,
    // Purging is irreversible: realized PnL is cumulative since first observed and
    // Hyperliquid only re-serves a limited recent window.
    body: 'This also erases its stored trade history and equity snapshots. This cannot be undone.',
  });
  if (!ok) return;
  try {
    await api.deleteWallet(w.address);
    toast(`Deleted ${nameFor(w)}`, 'success');
    const wasCurrent = w.address === current;
    await load(wasCurrent ? undefined : current); // load() repaints switcher + list + badge
    if (!wasCurrent) return; // non-selected: list refreshed, dashboard untouched
    if (list.length) await handlers.onSelect(list[0].address);
    else handlers.onEmpty();
  } catch (e) { toast(errMsg(e), 'error'); }
}

export async function load(selected) {
  const { wallets } = await api.getWallets();
  meta = {};
  list = wallets;
  for (const w of wallets) meta[w.address] = { label: w.label, viaAgent: w.via_agent };
  current = selected && wallets.some((w) => w.address === selected) ? selected : (wallets[0]?.address ?? null);
  paintSwitcher();
  paintList();
  paintBadge(current);
  return wallets;
}

export const selectedValue = () => current;

export function setCurrent(address) {
  current = address;
  paintSwitcher();
  paintList();
  paintBadge(address);
}

function open() {
  $('walletPop').classList.remove('hidden');
  $('walletSwitcher').setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onOutside, true);
  $('walletList').querySelector('.pop-item')?.focus();
}

function close() {
  $('walletPop').classList.add('hidden');
  $('walletSwitcher').setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('pointerdown', onOutside, true);
}

const isOpen = () => !$('walletPop').classList.contains('hidden');

function onKey(e) {
  if (e.key === 'Escape') { close(); $('walletSwitcher').focus(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...$('walletList').querySelectorAll('.pop-item')];
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement);
  const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
  items[next].focus();
}

function onOutside(e) {
  if ($('walletPop').contains(e.target) || $('walletSwitcher').contains(e.target)) return;
  close();
}

export function reset() {
  meta = {};
  list = [];
  current = null;
  close();
  paintSwitcher();
  paintList();
  $('agentsPanel').innerHTML = '';
  $('walletBadge').classList.add('hidden');
}

export function mount(h) {
  handlers = h;
  $('walletSwitcher').addEventListener('click', () => (isOpen() ? close() : open()));
  $('addBtn').addEventListener('click', async () => {
    const address = $('walletInput').value.trim().toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { toast('Invalid wallet address.', 'error'); return; }
    try {
      const { resolved } = await api.addWallet(address);
      $('walletInput').value = '';
      const canonical = resolved?.address || address;
      await load(canonical);
      toast('Wallet added', 'success');
      close();
      await handlers.onSelect(canonical);
    } catch (e) { toast(errMsg(e), 'error'); }
  });
  $('walletInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addBtn').click(); });
}
