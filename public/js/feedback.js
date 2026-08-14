// Toasts, skeletons, the confirm dialog, and the status badge.
//
// Error policy: a failure that leaves the dashboard unusable gets the persistent
// inline #error region; a failure that does not gets a toast. A toast that fades
// is the wrong medium when the page behind it is blank.

import { esc } from './format.js';

const $ = (id) => document.getElementById(id);

// api.js marks a request that never reached the server with `err.offline` — the
// browser's own message for that ("Failed to fetch") isn't something a user can
// act on, so callers displaying an error message should route it through here
// instead of reading `err.message` directly.
export function errMsg(err) {
  return err && err.offline ? 'Network error — check your connection and try again.' : err.message;
}

export function toast(message, kind = 'info') {
  const host = $('toasts');
  // Suppress an exact duplicate that's already showing — otherwise a persistently
  // failing 30s poll would stack an unlabeled toast every cycle, forever.
  const alreadyShowing = Array.from(host.children)
    .some((el) => !el.classList.contains('leaving') && el.textContent === message);
  if (alreadyShowing) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  const remove = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 200); };
  el.addEventListener('click', remove);
  host.appendChild(el);
  setTimeout(remove, 5000);
}

export function setStatus(text, kind) {
  const el = $('status');
  el.className = 'badge ' + (kind || '');
  el.innerHTML = `<span class="status-dot"></span>${text}`;
}

export function setLoading(on) {
  document.body.classList.toggle('is-loading', on);
}

// Placeholder rows so a loading table has the shape of a full one.
export function skeletonRows(tbody, cols, n = 6) {
  tbody.innerHTML = '';
  for (let r = 0; r < n; r++) {
    const tr = document.createElement('tr');
    tr.className = 'skeleton-row';
    tr.innerHTML = Array.from({ length: cols }, () => '<td><span class="shimmer"></span></td>').join('');
    tbody.appendChild(tr);
  }
}

// Only one dialog at a time. A second call while one is open used to overwrite
// the first one's DOM out from under it and leave its promise unresolved forever
// (Task 12's per-row delete button makes this a routine case, not a contrived one)
// — so a second call closes the first cleanly before opening.
let openDialog = null;

export function confirmDialog({ title, body, confirmLabel = 'Delete' }) {
  // Captured before closing any dialog already open: that close() restores focus to
  // whatever triggered IT, and by the time the Promise executor below would read
  // document.activeElement it'd get that fallback instead of this call's real trigger.
  const previouslyFocused = document.activeElement;
  if (openDialog) openDialog(false);
  return new Promise((resolve) => {
    const root = $('modalRoot');
    // #toasts and #modalRoot are both direct children of <body> (see index.html)
    // specifically so they can be excluded here — everything else on the page is
    // made inert while the dialog is open, so a stray click or programmatic focus
    // can't reach it even outside the Tab-key trap below. #toasts stays live too:
    // a toast raised while the dialog is open is the only way an error reaches the
    // user, so it must stay clickable, focusable, and in the accessibility tree.
    const overlays = [root, $('toasts')];
    const inertSiblings = Array.from(document.body.children).filter((el) => !overlays.includes(el));
    for (const el of inertSiblings) el.inert = true;
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
          <h3 id="modalTitle">${esc(title)}</h3>
          <p class="modal-body">${esc(body)}</p>
          <div class="modal-actions">
            <button class="btn" data-act="cancel">Cancel</button>
            <button class="btn btn-danger" data-act="confirm">${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`;
    root.classList.remove('hidden');

    const focusables = root.querySelectorAll('button');
    const first = focusables[0], last = focusables[focusables.length - 1];
    // Focus Cancel, not Delete: buttons activate on keydown, so holding Enter to
    // dismiss a *different* dialog (or simple key-repeat) would otherwise land on
    // and repeatedly click the destructive action of a dialog whose own copy says
    // this cannot be undone.
    first.focus();

    let settled = false;
    const close = (result) => {
      if (settled) return; // one of Escape/backdrop/Cancel/Confirm always fires exactly once
      settled = true;
      openDialog = null;
      document.removeEventListener('keydown', onKey);
      for (const el of inertSiblings) el.inert = false;
      root.classList.add('hidden');
      root.innerHTML = '';
      // The previously-focused element may have been removed from the DOM while the
      // dialog was open (e.g. a re-rendered list) — focusing a detached node is a
      // silent no-op that strands keyboard focus at the top of the document.
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      resolve(result);
    };
    openDialog = close;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
      if (e.key !== 'Tab') return;
      // Trap focus inside the dialog.
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    root.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
    root.querySelector('[data-act="confirm"]').addEventListener('click', () => close(true));
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) close(false);
    });
  });
}
