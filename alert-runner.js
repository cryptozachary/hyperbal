import { evaluateRules, describeRule, formatValue, METRICS } from './alerts.js';
import { assembleAccount } from './account.js';

// Builds the plain-text alert email. Kept module-level and pure so the runner body
// stays about scheduling rather than string assembly.
function buildEmail({ rule, value }, payload, ts, opts) {
  const meta = METRICS[rule.scope]?.[rule.metric];
  const desc = describeRule(rule);
  const subject = `[Hyperbal] ${desc} (now ${formatValue(value, meta?.unit)})`;

  const lines = [
    `Rule: ${desc}`,
    `Observed: ${formatValue(value, meta?.unit)}`,
    `Wallet: ${rule.address}`,
    `Time: ${new Date(ts).toISOString()}`,
    '',
  ];

  if (rule.scope === 'position') {
    const pos = (payload.positions || []).find((p) => p.coin === rule.coin);
    if (pos) {
      lines.push(
        `${pos.coin} ${pos.side} size ${pos.size} · entry ${formatValue(pos.entryPrice, 'usd')}`
        + ` · mark ${formatValue(pos.markPrice, 'usd')} · liq ${formatValue(pos.liquidationPrice, 'usd')}`
        + ` · uPnL ${formatValue(pos.unrealizedPnl, 'usd')}`,
      );
    }
  } else {
    lines.push(
      `Equity: ${formatValue(payload.equity, 'usd')}`
      + ` · unrealized PnL: ${formatValue(payload.totalUnrealizedPnl, 'usd')}`
      + ` · open positions: ${payload.openPositionsCount}`,
    );
  }

  lines.push('', opts.dashboardUrl);
  return { subject, text: lines.join('\n') };
}

// The only stateful piece of the alerts feature: it owns the debounce timers, the
// backstop interval, and the read -> evaluate -> send -> persist cycle.
//
// `now` and `assemble` are injectable so the tests control time and never touch
// the network.
export function createAlertRunner({ db, stream, notifier, opts = {}, now = Date.now, assemble = assembleAccount }) {
  const timers = new Map();   // address -> pending debounce timer
  const watched = new Set();  // addresses we hold a stream.watch reference for
  let pollTimer = null;
  let onAccount = null;

  // stream.watch/unwatch are ref-counted upstream, so calling watch twice for the
  // same address would leave a reference no unwatch ever balances. One rule or ten
  // for a wallet is still exactly one subscription held by the runner.
  function ensureWatched(address) {
    if (watched.has(address)) return;
    watched.add(address);
    stream?.watch(address);
  }

  const inFlight = new Map(); // address -> in-progress evaluation

  // The read -> await assembleAccount -> write cycle is not atomic, so two
  // overlapping passes would both read last_state = 0 and both send. A stream tick
  // landing during a backstop sweep makes that routine rather than theoretical.
  // Callers join the pass already running instead of starting a second one.
  function evaluateAddress(address) {
    const running = inFlight.get(address);
    if (running) return running;
    const pass = runEvaluation(address).finally(() => inFlight.delete(address));
    inFlight.set(address, pass);
    return pass;
  }

  async function runEvaluation(address) {
    const rules = db.listEnabledAlerts(address);
    if (!rules.length) return;

    let payload;
    try {
      // webData2 carries main-dex state only, so the stream is a trigger and this
      // is the source: the same aggregated payload the dashboard renders, which is
      // the number the user was looking at when they set the threshold.
      payload = await assemble(address, db, opts);
    } catch (err) {
      // Hyperliquid unreachable. Log and return — this must never kill the
      // interval or break the debounce chain, and no rule state may move on the
      // strength of data we don't have.
      console.warn(`[alerts] skipping ${address}: ${err.message}`);
      return;
    }

    const ts = now();
    for (const decision of evaluateRules(rules, payload, ts, opts.alertCooldownMs)) {
      const prevState = decision.rule.last_state ?? null;
      if (!decision.fire) {
        // Skip the write when nothing changed — the common case on every tick.
        // Each no-op UPDATE is a WAL write and one more chance to overwrite a
        // concurrent re-arm.
        if (decision.nextState !== prevState) {
          db.saveAlertResult(decision.rule.id, { prevState, lastState: decision.nextState });
        }
        continue;
      }
      try {
        const result = await notifier.send(buildEmail(decision, payload, ts, opts));
        db.saveAlertResult(decision.rule.id, {
          prevState,
          lastState: 1,
          attemptAt: ts,
          // Only a real send advances last_fired_at. With mail unconfigured the
          // rule still advances (so the log doesn't repeat every tick) but the UI
          // must not claim an email that never left the machine.
          firedAt: result?.sent ? ts : null,
        });
      } catch (err) {
        // Advance only the retry throttle. last_state is deliberately left
        // untouched: the rule must retry, and a concurrent re-arm must survive.
        console.warn(`[alerts] send failed for rule ${decision.rule.id}: ${err.message}`);
        db.saveAlertAttempt(decision.rule.id, ts);
      }
    }
  }

  // Collapse a burst of stream ticks into one evaluation per address.
  function schedule(address) {
    if (timers.has(address)) return;
    const t = setTimeout(() => {
      timers.delete(address);
      evaluateAddress(address).catch((err) => console.warn(`[alerts] ${address}: ${err.message}`));
    }, opts.alertDebounceMs);
    t.unref?.();
    timers.set(address, t);
  }

  let sweeping = false;

  async function sweep() {
    // Sequential by design — one assembleAccount per wallet — so a slow upstream
    // can make a sweep outlast its own interval. Without this guard those sweeps
    // stack, each one adding REST load to the API that is already the reason it is
    // slow.
    if (sweeping) return;
    sweeping = true;
    try {
      for (const address of db.alertAddresses()) await evaluateAddress(address);
    } finally {
      sweeping = false;
    }
  }

  return {
    db, // exposed for tests; the runner itself always goes through the methods above
    evaluateAddress,
    sweep,
    watch: ensureWatched,

    start() {
      // A persistent webData2 subscription per alerting wallet is what makes alerts
      // fire with no browser open — the same thing stream.track() already does for
      // fills. Ref-counting means a browser watching the same wallet composes with
      // this reference rather than cancelling it.
      for (const address of db.alertAddresses()) ensureWatched(address);

      onAccount = ({ address }) => { if (address) schedule(address); };
      stream?.on('account', onAccount);

      // Backstop: the stream can stall without closing, and an alert that silently
      // stops working is worse than one that never existed.
      pollTimer = setInterval(() => {
        sweep().catch((err) => console.warn(`[alerts] sweep: ${err.message}`));
      }, opts.alertPollIntervalMs);
      pollTimer.unref?.();
    },

    stop() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      clearInterval(pollTimer);
      pollTimer = null;
      if (onAccount) stream?.off('account', onAccount);
      onAccount = null;
      // Release every reference start() took, so a stop/start pair doesn't leave
      // the upstream subscription ref-count permanently inflated.
      for (const address of watched) stream?.unwatch(address);
      watched.clear();
    },

    // Called when a wallet is deleted, so the runner releases its subscription.
    unwatch(address) {
      if (!watched.delete(address)) return;
      stream?.unwatch(address);
    },
  };
}
