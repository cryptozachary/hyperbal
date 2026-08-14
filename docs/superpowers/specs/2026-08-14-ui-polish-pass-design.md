# UI Polish Pass — Design

**Date:** 2026-08-14
**Status:** Approved

## Problem

The dashboard works, but it looks unfinished. It has grown one feature at a time —
core dashboard, agent wallets, builder dexs, trade history, tax export — and each
addition appended a panel and some CSS without anyone re-examining the whole. The
result is a page that reads as a stack of accreted parts rather than a designed
product, against a README that promises a "dark, premium trading-dashboard UI."

Four specific gaps:

1. **The chart is a bare canvas line.** No axes, no gridlines, no dates, no
   interaction. It cannot tell you *when* anything happened or *what* a point is
   worth. It maps a `null` unrealized PnL to `0`, drawing a line through zero as
   if that were an observation.
2. **The tables are unstyled rows.** Proportional numerals mean digits jitter as
   live values update. No hover state, no visual weight anywhere, side rendered
   as colored text.
3. **The cards and header carry no hierarchy.** Four identical cards with no
   trend or delta. The header packs a select, a 280px input, three buttons, and a
   badge into one row that wraps awkwardly — and two of those buttons (Add,
   ✕ Delete) are things you touch rarely.
4. **The states are placeholders.** Loading is the word "Loading…" over a dimmed
   box. Errors are a red box that stays. Wallet deletion uses `window.confirm()`.

## Goals

Refine the visual execution of what already exists, in the existing dark palette,
with no new runtime dependencies.

## Non-goals

- **New analytics.** Win rate, per-coin PnL, drawdown, fee totals, and a
  Performance panel are a separate project with its own spec. Nothing in this
  pass adds a DB query, an API route, or a new data source.
- **A redesign.** The palette, the panel structure, and the information
  architecture stay. This is direction "refine what's there," not a new look.
- **A framework, a bundler, or a chart library.** The frontend stays vanilla. The
  README's "no chart library" claim remains true after this work.
- **Wallet renaming.** `db.js` has a `label` column that nothing writes, and the
  new popover makes its absence obvious. It is still a feature, not polish.
- **Server, `db.js`, and `export.js` changes.** No file outside `public/` and
  `test/` is modified except `README.md`.

---

## Decisions taken

| Question | Decision |
|---|---|
| Visual direction | **Refine the existing palette** — same navy surfaces and shapes, executed properly. Not a terminal look, not a fintech restyle. |
| Chart scope | **Full** — axes, gridlines, area fill, crosshair tooltip, range pills, change-over-range readout. |
| Header layout | **Wallet switcher with a popover** — the list, add field, and per-wallet delete move out of the persistent header. |
| Dependencies | **None added.** Chart is hand-rolled canvas. |
| Frontend structure | **Split `app.js` by concern** into native ES modules. |

### Why the module split is in scope

`public/app.js` is 440 lines doing formatting, account rendering, fills paging,
export, charting, WebSocket handling, wallet CRUD, and bootstrap. This pass adds
roughly 320 lines to it — the chart alone is ~200 — which would leave a single
~760-line file. The split is not opportunistic refactoring; it is what makes the
chart work tractable and independently testable.

### `/api/history` needs no change

The range pills were initially scoped as needing a new query parameter. They do
not. `server.js:47` already reads `?since=` and passes it to
`db.getHistory(address, since)`; the client simply never sends it. Range
selection is pure frontend work against an endpoint that already exists.

---

## Architecture

### Module layout

`public/app.js` splits into `public/js/`, loaded via
`<script type="module" src="js/app.js">`. Native ES modules — no bundler, no
build step, no new dependency.

| Module | Owns | Depends on |
|---|---|---|
| `format.js` | `fmtUsd`, `fmtNum`, `fmtPct`, `fmtTime`, `changeReadout`, `cls`, `short`, `esc` | nothing — pure, no DOM |
| `api.js` | the `fetch` wrapper; one named function per route; the only file that knows route strings | nothing |
| `chart-math.js` | pure geometry: ticks, tick labels, scales, segments, range change | nothing — pure, no DOM |
| `chart.js` | canvas painting: gridlines, area fill, line, crosshair, tooltip, sparse-data notice, sparklines | `format.js`, `chart-math.js` |
| `chart-panel.js` | the chart's own state — history, series, range — plus its toggle and range wiring | `api.js`, `chart.js`, `chart-math.js`, `format.js`, `feedback.js` |
| `account.js` | summary cards and positions table | `format.js`, `chart.js`, `chart-math.js` |
| `fills.js` | trade history table, filter, pager, live-append reload | `format.js`, `api.js`, `feedback.js` |
| `wallets.js` | switcher popover: list, select, add, delete-with-confirm | `api.js`, `format.js`, `feedback.js` |
| `exports.js` | period picker, sync button, download links | `api.js`, `feedback.js` |
| `feedback.js` | toasts, skeletons, confirm dialog, status badge | `format.js` |
| `app.js` | `state`, WebSocket, fallback polling, wiring, bootstrap | all of the above |

### Interfaces

`app.js` never reaches into a panel's DOM; a panel never reads global state, and
**no panel imports `app.js`** — behavior arrives as injected handlers
(`onSelect`, `onEmpty`, `onSynced`). No panel accepts an `onError`; panels report
their own failures directly via `feedback.js`'s `toast()`. That last rule is what keeps the
import graph a DAG; `app.js` ends in a bare `init()` call, so a cycle back into
it would fail at module-evaluation time rather than degrade gracefully.

Panels are mounted as `mount(handlers)` with no root element. A scoped root is
not available: the panel `<section>`s in `index.html` carry no IDs, and
`wallets.js` spans two disjoint regions of the document — the switcher in the
header and the agents panel in `<main>` — so no single root can contain it.

Method names follow one convention, and the distinction between the first two is
load-bearing rather than stylistic:

| Name | Contract |
|---|---|
| `paint()` | private, synchronous, DOM writes only |
| `load()` | async — fetches, then paints |
| `setX()` | synchronous assignment, **never fetches** |
| `render(data)` | synchronous, paints from an argument |
| `mount(handlers)` | one-time wiring |
| `reset()` | synchronous teardown to the empty state |

Two rules follow from that table, and both are load-bearing:

**`setX()` must stay synchronous**, because every panel's address is assigned in one
block at the top of `selectAddress`. A setter that also fetches can only be
awaited in the position its fetch belongs, which leaves that panel holding a
stale address for the duration — and the export panel holding a stale address
means the download button emits the previous wallet's CSV while the rest of the
dashboard shows the new one.

**Every `setX(address)` must be followed by its panel's loader** before the next
await boundary settles. The loaders clear their own DOM before fetching, and they
carry a generation guard so a superseded response cannot repaint. That is only
safe because a setter is always paired with a loader: an unpaired `setAddress`
leaves the panel cleared, never refilled, and still enabled — for the export
panel that means a year-scoped download silently degrading to all-time.

`chart.js` is the strictest boundary:

```js
createChart(canvasEl) -> { render(points, { series }), destroy() }
// points: [{ ts, equity, unrealized_pnl, realized_pnl_cum }] — the snapshot row as stored
// series: 'equity' | 'pnl'   (the main chart's toggle)
```

The range pills are **not** an option on `render`. Selecting a range re-fetches a
shorter `points` array via `?since=`; the chart plots whatever it is handed and
derives its x-axis label format from that array's own `ts` span. Nothing about
the chart needs to know which pill produced the data.

The main chart plots `equity` or `unrealized_pnl`; card sparklines additionally
read `realized_pnl_cum`, which is why `render` takes the whole snapshot row
rather than a pre-projected series.

It knows nothing about wallets, the API, or the socket. Its pure geometry helpers
(`niceTicks`, `computeScales`) are exported for testing.

### Data flow

Unchanged: REST load on wallet select → WebSocket `refresh` / `realized` messages
→ 30s fallback poll. One new call path — clicking a range pill re-fetches
`/api/history/:address?since=<ms>` and re-renders the chart only.

### Behavior preserved verbatim

These have non-obvious reasons documented in comments. They move to their new
files unchanged, comments included:

- The fills-page clamp (`app.js:97`) — a page can fall off the end of the data
  after a purge, a second tab, or a restart.
- The stale-broadcast guard (`app.js:303`) — the hub keeps routing the previously
  watched address until the new `watch` lands.
- "Re-read page 1 rather than splice" (`app.js:192`) — the upstream `userFills`
  sub replays a snapshot on every reconnect.
- Client-side year bounds for export (`app.js:107`) — the browser computes them so
  the server never guesses the user's timezone.

---

## Visual system

### Tokens

`styles.css` gains a token layer; everything else references it.

- **Color:** existing palette, plus the intermediate values currently hardcoded
  (`#121624`, `#1a2131`, `#10151f` → `--surface-1/2/3`), `--line-soft` for
  interior row borders, and `--pos-a12` / `--neg-a12` for chip backgrounds.
- **Space:** `--sp-1`…`--sp-6` (4/8/12/16/24/32). Today nine different padding
  values do the work of five.
- **Radius:** `--r-sm` 8, `--r-md` 10, `--r-lg` 14, `--r-pill` 999.
- **Type:** `--fs-xs` 10 … `--fs-xl` 21. A custom property cannot hold a
  property name, so there is no `--num` token — `styles.css:38` applies
  `font-variant-numeric: tabular-nums` directly to every numeric cell and card
  value, which is correct as is.
- **Motion:** `--dur-fast` 120ms, `--dur` 180ms, one shared easing — all disabled
  under `prefers-reduced-motion`.
- **Breakpoints:** two, deliberately. **760px** (the existing one) governs the
  card grid and table scrolling; **640px** governs the popover becoming a bottom
  sheet, since the switcher stays usable in a wrapped header longer than the
  tables stay readable.

### Summary cards

Label (10px uppercase muted) → value (21px, 700, tabular, tight tracking) →
delta → 20px sparkline. Equity, Unrealized, and Realized each get a sparkline
from the history series. Open Positions gets a long/short split (`2 long · 1
short`) instead.

**Card deltas are fixed at 24h regardless of the chart's range pill.** Tying them
to the chart range would mean changing the chart silently changes what the cards
claim. If fewer than two snapshots exist in that 24h window, the delta renders
`—`, not a fabricated `0.00%`.

### Tables

Tabular numerals throughout; hover row highlight (no zebra); side as a filled
chip rather than colored text; coin cell gets weight with the dex collateral as a
muted suffix. Header row sticky on scroll. Below 760px the table scrolls
horizontally inside its panel with the first column pinned, rather than the page
scrolling sideways.

Trade History's Direction column becomes a chip too, colored by buy/sell, using
the existing `dir` field with the same raw-`side` fallback that is there now
(pre-migration rows have no `dir`).

### Header and popover

The switcher shows a deterministic gradient avatar (hue derived from the
address), the label or short address, and the wallet count. The popover holds the
wallet list with a per-row `✕`, the `via agent` tag where relevant, a divider,
and the add field.

- Closes on Escape, outside click, and on selection.
- `aria-expanded` on the trigger, roving focus within the list.
- Below 640px it becomes a full-width bottom sheet.

Per-wallet delete replaces today's "delete whatever is selected in the dropdown"
and inherits the existing warning copy.

**Refresh stays in the header** alongside the switcher and the status badge —
those three are what you look at constantly, and they are the only controls the
header keeps.

The status badge gains a pulse dot with three states (Live / Polling / Down). The
pulse is one of the animations `prefers-reduced-motion` disables.

---

## Chart

### Size

The canvas grows from today's hardcoded 220px to **280px** on desktop and 200px
below 760px, since axis labels and the x-axis date row now consume vertical space
the plot used to have. Height stops being duplicated between the `height`
attribute in the markup and the `h` constant in the draw function — `chart.js`
reads the element's CSS box, and DPR scaling works as it does today.

### Scales

Y ticks from a nice-number algorithm (1/2/5 × 10ⁿ) targeting 7 gridlines — a
lower target such as 5 undershoots more often than intuition suggests, since
`niceStep` always rounds up to the next 1/2/5 (see the comment on `niceTicks` in
`chart-math.js`) — range padded 5% so the line never touches the frame. A flat series (min === max)
centers the line in a ±1% band rather than dividing by zero — today's `y()`
already special-cases this and the behavior carries over.

X labels adapt to the span: `HH:mm` at 24h, `MMM d` at 7d/30d, `MMM yyyy` once
the span exceeds a year.

### Null handling

Today `drawChart` maps a null `unrealized_pnl` to `0`, drawing a line through
zero as though it were an observation. Nulls become **gaps** in the line.

### Interaction

Pointer events (so touch drag works). Dashed vertical crosshair, marker dot on the
line, and a tooltip showing exact value and timestamp. The tooltip flips to the
left of the crosshair when it would overflow the right edge. `pointerleave` clears
it. The last value stays pinned as a pill at the right edge.

**Hit-testing inverts the index scale, not time.** `pointerToIndex` maps the
pointer's x back through the same index-based mapping `computeScales.x` uses to
place each point. An earlier draft searched for the nearest snapshot *by
timestamp*, which is only equivalent when snapshots are evenly spaced in time —
and they never are, since they accrue in dense bursts while the dashboard is open
and not at all between sessions. Measured on a realistic series (four snapshots
90s apart, a three-day gap, four more), that version returned the wrong point for
**71% of pixels**: hovering a visible vertex described a point three positions
away.

### Range

Pills for 24h / 7d / 30d / All, re-fetching `?since=<ms>`. **Default is All**, so
first load behaves exactly as it does today; the selection is remembered in
memory for the session. Beside the title, a change-over-range readout: absolute
and percent from the first to the last point in range, colored by sign.

### Sparse-data honesty

Snapshots are throttled to one per `SNAPSHOT_MIN_INTERVAL_MS` (60s default) *and*
only accrue while a saved wallet is being viewed, so short ranges are often
genuinely thin.

- **Under 2 points in range:** no line. "Only 1 snapshot in this range —
  snapshots accrue while the dashboard is open."
- **2–4 points:** draw the line, with a muted `4 snapshots` note so a
  three-segment zigzag is not mistaken for a trend.

Card sparklines reuse `chart.js`'s scale helpers rather than reimplementing them.

**The sparklines need their own paint entry point, and their own fetch.**
`account.render(data)` takes the account payload, but sparklines read snapshot
rows, which arrive from a different request that completes *after* the cards are
painted — and on a wallet switch the history array is explicitly emptied first, so
at `render` time there is nothing to draw from. `account.js` therefore exports a
second, separate `renderSparks(points)`.

It must **not** be fed from `chart-panel.js`'s history. That array is
range-scoped: it shrinks when a range pill is clicked, and `load()` re-runs on
every pill click. Reusing it would break two guarantees at once — the chart's
"selecting a range redraws only the chart", and the cards' "deltas are fixed at
24h regardless of the pill". A 24h delta computed by filtering a 7d array happens
to be correct today only because 24h is the shortest pill; adding a 1h pill would
silently under-report it with no error anywhere.

So `app.js` issues its own `getHistory(address, now - 24h)` once per refresh and
hands the result to `renderSparks`. Panels do not import each other; `app.js` is
the only module that wires them together.

---

## States and feedback

**Skeletons replace the overlay.** The dimmed box with "Loading…" is removed;
cards, chart, and table rows render shimmer placeholders in their real shapes.
Shimmer is static under `prefers-reduced-motion`.

**Toasts** — bottom-right stack, 5s auto-dismiss, manually dismissible. Used for
completed sync results, wallet added/removed, and transient errors.

**A truncated sync is not a toast.** When `/api/backfill` returns `truncated`,
today's inline text tells you to click again to continue, and the client holds
resume cursors in `state.syncResume` that only that message explains. That line
stays in the Export panel and persists until the next sync — it is actionable, so
it must not fade. A *completed* sync gets the toast.

**Error policy**, stated once so it is not decided per-case:

> A failure that leaves the dashboard unusable gets the persistent inline error
> region. A failure that does not gets a toast.

A toast that fades is the wrong medium when the page behind it is blank.

**Custom confirm dialog** replaces `window.confirm()` for wallet deletion.
Focus-trapped, Escape cancels, explicit Delete button, carrying today's exact
warning about purging fills, funding, and equity snapshots. It names the wallet
but quotes **no counts** — the popover can delete a wallet other than the one
loaded, and showing a number belonging to a different wallet is worse than
showing none.

**Empty states** get an icon, a one-line explanation, and an action where one
exists. Trade History's empty state offers **Sync full history** inline rather
than only saying "No trades recorded yet."

Chart rendering is wrapped so a draw failure degrades to a note instead of taking
down the page.

---

## Verification

### Automated

`npm test` must stay green. No server, `db.js`, or `export.js` changes are in
scope, so no existing test should need to move.

New `node:test` files — the first frontend tests in the repo. These targets are
pure functions, so none need a DOM or a canvas:

- **`test/format.test.js`** — currency formatting, negatives, nulls, and
  `changeReadout`'s sign/arrow tie-breaks.
- **`test/chart-math.test.js`** — `niceTicks` across zero-spanning, flat, and
  sub-unit ranges; `tickLabels`' precision/collision handling; `computeScales`
  when `min === max`; the crosshair's pointer-to-index and tooltip-placement
  geometry.
- **`test/api.test.js`** — the `fetch` wrapper's error classification
  (`offline` vs. an HTTP status) and its route construction per endpoint.

### Manual

Rendering is verified against a checklist:

- Live WebSocket updates still land in the cards and in Trade History.
- Fills paging and the closes-only filter behave, including the page clamp.
- Deleting the last wallet resets every panel.
- Both CSV downloads still fire, and the period picker still populates.
- Agent-wallet badge and Connected Agent Wallets panel still render.
- Layout holds at 1440 / 768 / 375px.
- `prefers-reduced-motion` disables shimmer, pulse, and transitions.

## Documentation

`README.md`'s Features section gains the chart interaction and the header change.
Its "no chart library" claim stays true. The Project structure block is updated
for `public/js/`.
