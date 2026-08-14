// Toasts, skeletons, the confirm dialog, and the status badge.
//
// Error policy: a failure that leaves the dashboard unusable gets the persistent
// inline #error region; a failure that does not gets a toast. A toast that fades
// is the wrong medium when the page behind it is blank.

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

export function confirmDialog({ title, body, confirmLabel = 'Delete' }) {
  return new Promise((resolve) => {
    const root = $('modalRoot');
    const previouslyFocused = document.activeElement;
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
          <h3 id="modalTitle">${title}</h3>
          <p class="modal-body">${body}</p>
          <div class="modal-actions">
            <button class="btn" data-act="cancel">Cancel</button>
            <button class="btn btn-danger" data-act="confirm">${confirmLabel}</button>
          </div>
        </div>
      </div>`;
    root.classList.remove('hidden');

    const focusables = root.querySelectorAll('button');
    const first = focusables[0], last = focusables[focusables.length - 1];
    last.focus();

    let settled = false;
    const close = (result) => {
      if (settled) return; // one of Escape/backdrop/Cancel/Confirm always fires exactly once
      settled = true;
      document.removeEventListener('keydown', onKey);
      root.classList.add('hidden');
      root.innerHTML = '';
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(result);
    };
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
