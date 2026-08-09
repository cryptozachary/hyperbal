import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { normalizeAccount, normalizeFills } from './hyperliquid.js';

// Manages the single upstream connection to Hyperliquid.
// Emits: 'account' { address, account }, 'fills' { address, rows, recentRealized }, 'status' string.
export function createStream({ wsUrl, WebSocketImpl = WebSocket, wsFactory } = {}) {
  const emitter = new EventEmitter();
  const webData2Refs = new Map(); // address -> count
  const tracked = new Set();      // addresses with persistent userFills
  let ws = null;
  let pingTimer = null;
  let backoff = 1000;

  function activeSubs() {
    const subs = [];
    for (const addr of webData2Refs.keys()) subs.push({ type: 'webData2', user: addr });
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
      if (msg.channel === 'webData2') {
        const cs = msg.data?.clearinghouseState;
        const address = (msg.data?.user || '').toLowerCase() || undefined;
        if (cs) emitter.emit('account', { address, account: normalizeAccount(cs) });
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
    watch(address) {
      const n = (webData2Refs.get(address) || 0) + 1;
      webData2Refs.set(address, n);
      if (n === 1) subscribe({ type: 'webData2', user: address });
    },
    unwatch(address) {
      const n = (webData2Refs.get(address) || 0) - 1;
      if (n <= 0) { webData2Refs.delete(address); unsubscribe({ type: 'webData2', user: address }); }
      else webData2Refs.set(address, n);
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
