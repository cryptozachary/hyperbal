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
    if (w.address === current) pick.setAttribute('aria-current', 'true');
    // Labels are arbitrary server-stored strings — escape before interpolating into innerHTML.
    pick.innerHTML = `<span class="pop-item-name">${esc(nameFor(w))}</span>${w.via_agent ? ' <span class="via">via agent</span>' : ''}`;
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
  // goes on, so there's exactly one handler live at a time. It also moves focus to the
  // switcher (see close()'s focus-return), which is what confirmDialog captures as
  // `previouslyFocused` — a node that's never re-rendered, so focus restores cleanly
  // on both Cancel and Confirm instead of landing on a row that paintList() may have
  // just replaced.
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
    if (!wasCurrent) { open(); return; } // non-selected: dashboard untouched, reopen so the list reflects the delete
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

function open() {
  $('walletPop').classList.remove('hidden');
  $('walletSwitcher').setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onOutside, true);
  $('walletList').querySelector('.pop-item')?.focus();
}

// Tears down the popover's open state without touching focus — used when focus is
// already deliberately moving elsewhere (Tab-out via onPopFocusOut) so stealing it
// back to the switcher would fight the user's own navigation.
function hide() {
  $('walletPop').classList.add('hidden');
  $('walletSwitcher').setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('pointerdown', onOutside, true);
}

// Every other close path (Escape, outside click, selecting a row, adding a wallet,
// starting a delete) leaves focus stranded on <body> once the popover it was on
// disappears — capture whether focus was inside (the popover or the trigger itself)
// before hiding, and only then return it to the switcher.
function close() {
  const hadFocusInside = $('walletPop').contains(document.activeElement) || document.activeElement === $('walletSwitcher');
  hide();
  if (hadFocusInside) $('walletSwitcher').focus();
}

const isOpen = () => !$('walletPop').classList.contains('hidden');

function onKey(e) {
  if (e.key === 'Escape') { close(); return; }
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

// Tabbing out of the popover (forward past the last row, or Shift+Tab back out past
// the switcher) should close it — leaving it open with aria-expanded="true" while
// focus and the visible page have both moved on lies to assistive tech. focusout (not
// blur) is used because it bubbles to #walletPop; relatedTarget is checked rather than
// document.activeElement because by focusout time activeElement is already the *new*
// target, not the one focus is leaving.
function onPopFocusOut(e) {
  if (!isOpen()) return;
  const to = e.relatedTarget;
  // relatedTarget is null for a window blur, and also when paintList() replaces the
  // still-focused row out from under the user (e.g. after a delete) — neither is the
  // user tabbing away, so neither should close the popover.
  if (to === null) return;
  // Shift+Tab from the first row lands back on the switcher; that's still "inside".
  if ($('walletPop').contains(to) || to === $('walletSwitcher')) return;
  hide(); // deliberate Tab-out: don't steal focus back with close()'s focus-return
}

export function reset() {
  meta = {};
  list = [];
  current = null;
  hide();
  paintSwitcher();
  paintList();
  $('walletInput').value = '';
  $('agentsPanel').innerHTML = '';
  $('walletBadge').classList.add('hidden');
}

export function mount(h) {
  handlers = h;
  $('walletSwitcher').addEventListener('click', () => (isOpen() ? close() : open()));
  $('walletPop').addEventListener('focusout', onPopFocusOut);
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
