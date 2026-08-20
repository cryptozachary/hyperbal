import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { normalizeFills } from './hyperliquid.js';

// Manages the single upstream connection to Hyperliquid.
// Emits: 'mids' { mids }, 'fills' { address, rows, recentRealized }, 'status' string.
export function createStream({ wsUrl, WebSocketImpl = WebSocket, wsFactory } = {}) {
  const emitter = new EventEmitter();
  const watchers = new Map();     // address -> count (allMids is global, but unwatch must stay balanced per address)
  const tracked = new Set();      // addresses with persistent userFills
  let ws = null;
  let pingTimer = null;
  let backoff = 1000;

  function activeSubs() {
    const subs = [];
    if (watchers.size > 0) subs.push({ type: 'allMids' });
    for (const addr of tracked) subs.push({ type: 'userFills', user: addr });
    return subs;
  }

  function send(obj) {
    if (ws && ws.readyState === (WebSocketImpl.OPEN ?? 1)) ws.send(JSON.stringify(obj));
  }

  function subscribe(subscription) { send({ method: 'subscribe', subscription }); }
  function unsubscribe(subscription) { send({ method: 'unsubscribe', subscription }); }

  function connect() {
    ws = wsFactory ? wsFactory() : new WebSocketImpl(wsUrl);
    ws.on('open', () => {
      backoff = 1000;
      emitter.emit('status', 'connected');
      for (const s of activeSubs()) subscribe(s);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ method: 'ping' }), 30000);
      pingTimer.unref?.();
    });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.channel === 'allMids') {
        emitter.emit('mids', { mids: msg.data?.mids || {} });
      } else if (msg.channel === 'userFills') {
        const address = (msg.data?.user || '').toLowerCase() || undefined;
        const { rows, recentRealized } = normalizeFills(msg.data?.fills);
        if (rows.length) emitter.emit('fills', { address, rows, recentRealized });
      }
    });
    ws.on('close', () => {
      clearInterval(pingTimer);
      emitter.emit('status', 'disconnected');
      const rt = setTimeout(connect, backoff);
      rt.unref?.();
      backoff = Math.min(backoff * 2, 30000);
    });
    ws.on('error', () => { try { ws.close(); } catch {} });
  }

  return Object.assign(emitter, {
    start() { connect(); },
    // The per-address API is kept because callers depend on it, but the underlying
    // subscription is a single global allMids. webData2 — the per-user feed this
    // used to hold — is rejected outright by the API ("Error parsing JSON into
    // valid websocket request"), so no message ever arrived and every
    // account-driven feature silently degraded to polling. allMids is accepted,
    // needs no user field, and ticks every few seconds with every coin's mark
    // price, which for a perps dashboard is the "something changed" signal.
    watch(address) {
      const n = (watchers.get(address) || 0) + 1;
      watchers.set(address, n);
      if (watchers.size === 1 && n === 1) subscribe({ type: 'allMids' });
    },
    unwatch(address) {
      const n = (watchers.get(address) || 0) - 1;
      if (n <= 0) {
        watchers.delete(address);
        if (watchers.size === 0) unsubscribe({ type: 'allMids' });
      } else watchers.set(address, n);
    },
    track(address) {
      if (!tracked.has(address)) { tracked.add(address); subscribe({ type: 'userFills', user: address }); }
    },
    // Independent of the ref-counted watch/unwatch pair — `tracked` is a plain set.
    untrack(address) {
      if (tracked.delete(address)) unsubscribe({ type: 'userFills', user: address });
    },
  });
}
