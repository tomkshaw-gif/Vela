# Replay Studio

This fork adds a standalone local practice application for Windows. The installed
Electron application serves its private local workspace on `http://127.0.0.1:5196`.
It does not connect to a broker. Orders and
account balances are simulated. The Vela chart library remains attributed to
LuxAlgo; this local application is an independent fork.

## Start

The Windows Desktop has two shortcuts:

- **Run Vela** opens the installed Electron application. It includes Chromium and
  Node.js; normal use needs neither a terminal nor a source checkout.
- **Develop Vela** opens the source development view on `http://127.0.0.1:5198`.

They share saved sessions, candles and encrypted provider settings in
`%LOCALAPPDATA%\VelaReplayStudio`. The Electron profile also lives there, under
`desktop-profile`; chart templates, display preferences and script recovery survive
updates and full restarts. The two modes use separate browser profiles. Installed
Vela saves pending work before closing and stops its own backend. Repeated desktop
launches focus the existing application.

Push reviewed changes to `main` in `tomkshaw-gif/Vela` to release a desktop update.
The desktop workflow runs the type, lint, test and build gates before publishing a
versioned Windows installer, blockmap and `latest.yml`. Installed Vela checks that
fork shortly after startup and every thirty minutes, downloads an available stable
update, pauses replay and saves the complete workspace before installing and
restarting. Save failures preserve the open window. **File → Check for updates**
checks immediately; **Install downloaded update** retries an update that could not
be applied. Feature-branch pushes do not publish desktop updates.

Develop Vela continues using this checkout and fast coordinated reloads. Use Node.js
24 or newer and install its dependencies with `npm ci`. Its launcher remains open
after its browser window closes. Local edits affect Develop; the installed app
changes only when a newer release has been built and published.

For a local installer, run `npm run desktop:dist -- --publish never`. Build outputs
stay in ignored `local-app/electron/releases/`. `VELA_DESKTOP_VERSION` selects a
stable desktop version independently of the chart library version. The CI workflow
generates increasing versions from its run number and attempt. Never reuse a
published version for different code. `npm run desktop:build` stages a desktop
build; `npm run desktop:start` opens it for desktop-specific debugging.

Machine-local appearance extensions remain in the data directory's `appearance/`
folder and are never included in public installers or source commits. To copy an
existing private pack from this checkout without overwriting an installed pack,
run `npm run desktop:appearance`. The backend serves only the two fixed extension
modules, bounds their size and verifies the results module's manifest. A clean
installation uses the native appearance when no private extension is present.

The standalone desktop application includes AGPL-3.0-only scripting addons; their
notices and source references ship alongside the Apache-2.0 library attribution.

## Source launchers

`npm run local:start` retains the source-built Run view on port 5197 for local
comparison. The following source-watcher behavior applies to that view and Develop.

The first launch builds the app. Later unchanged launches reuse a content-checked
compiled build. Source changes trigger a new staged build. Run checks types before
switching; Develop prioritizes fast feedback. Open windows pause and save their
chart setup before the backend restarts, then reopen their selected session with
playback paused. Failed builds retain the running version. An unsaved window can
delay an update; a missed save deadline cancels the switch.

The background launcher watches application, library and configuration files in
this checkout. It does not pull code from GitHub. Changes to the launcher's own
process-management code require restarting that launcher. Generated builds and
launch logs stay in the ignored `local-app/.runtime/` folder. The launch logs are
under `local-app/.runtime/desktop-logs/`.

For console use, run `npm run local:start` or `npm run local:dev`; closing that
terminal stops its launcher. The root command files provide the same two modes.
An unrelated listener on a required port is preserved and reported as an error.
To recreate the two Desktop shortcuts, run
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File local-app/install-shortcuts.ps1`.

## Sessions and simulation

The app opens directly into Vela's chart workspace, with dark controls and a light
monochrome plot. Saved custom appearances stay intact; **Templates → Apply light
monochrome** applies the new preset explicitly. Native drawing tools, indicators,
chart settings and supported favorite timeframes remain available. The toolbar's
**Trade** button opens
the optional order ticket; **Sessions & results** opens the separate
management page for saved attempts, results and data settings. Returning to
management pauses playback. Replay/trading keyboard shortcuts apply only on the
chart page.

The right rail includes a cached-session watchlist, alerts, object tree and data
window; Pine Editor and Strategy Tester remain at the lower right. The watchlist
opens an existing replay session and does not expose unrevealed quotes. The
header shows the current session layout and its actual local save state.
New grid panes receive the default appearance after native style inheritance;
linked custom panes and restored drawings keep their settings.
Candles use device-pixel-aligned body, wick and border geometry across both native
renderers. The light preset uses 12-pixel axis text. Only the unchanged earlier
light preset receives the typography migration; custom appearances remain intact.

Chart navigation uses immediate wheel steps of up to ten percent, anchored to
the right edge. Hold Ctrl on Windows or Command on macOS to zoom toward the
cursor's candle. Horizontal trackpad movement pans through history; Shift plus
wheel provides horizontal navigation on Windows. Drag the time or price axis to
adjust its scale. Double-click the time axis to reset horizontal spacing and its
configured right margin; the manual price scale stays intact. Double-click the
price axis to restore autoscaling. Desktop dragging stops on release.

The shared bottom panel contains **Replay Trading**, **Pine Editor** and
**Strategy Tester**. Drag its top divider to resize it; the normal height is
remembered. Collapse it to its tab row or maximize it with the header controls.
The focused divider supports arrow keys, Shift for larger changes, Home to
collapse, End to use the available height and Enter to toggle collapse. Normal
resizing leaves space for the chart. Replay Trading uses the session's actual
statistics and a local canvas chart when the optional chart asset is installed.

The Trade panel selects a side before the **Market**, **Limit** or **Stop** tab.
It shows the instrument's tick value, visible disabled exit-price fields and
switches for take profit and stop loss. The lower **Replay Trading → Positions &
orders** tab retains position actions and the working-order list. **Rules & costs**
contains the practice-account or evaluation details.
Limit and stop prices start from the latest revealed source price and use the
instrument's tick size. Enable take profit or stop loss to add protective exits.
One submission button describes the selected side, quantity and order type.
Replay bid and ask both use the last revealed candle's close, following the
replay adapter. These are simulated prices, not live exchange quotes. Quick
**Sell** and **Buy** submit a simulated market order using the displayed quantity;
the next source bar determines execution with the session's configured costs.
The chart header uses the compact symbol, interval, exchange and OHLC readout,
with the replay badge and quote controls below. Its contract quantity stays in
sync with the ticket. Before a source price is available, quotes display `...` and cannot submit
orders. Indicator rows retain working visibility eyes and the collapse chevron;
their position follows the measured header height when a chart is resized.
Marketable limits are allowed; the simulation applies limit caps, gap-price
improvement and execution from the next eligible source bar. Passive intrabar
buy limits use descending price priority and sells use ascending price priority;
equal prices retain submission order. This local rule preserves other trigger
slots and does not reconstruct a mixed-side tick path. Source OHLC bars
do not reveal the actual intrabar path.
Working limit and stop orders and existing position exits appear as separate
chart lines with quantity, type or projected gross P&L, cancel controls and axis
price tags. Enabled draft exits appear before submission. A successful ticket
submission retires that draft; edits made while saving remain intact. Draft exit
close controls disable that exit; working exit controls remove only that bracket.
Drag a label to preview a tick-aligned price and release to commit
one amendment. Escape or a cancelled gesture restores its previous price. The
working order's close control cancels it. **Pick entry price on chart** and the
draft preview adjust the ticket without submitting an order.
The **Positions & orders** tab provides separate controls for working orders
whose chart labels coincide with another order or active draft.

The chart uses a compact header, grouped drawing rail and right panel rail.
**Replay** opens the playback strip below the chart: **Play/Pause**, **Stop**,
**Step**, **Fast**, speed and replay interval. Closing the strip pauses playback;
the open/closed preference is remembered. Keyboard playback exposes the strip.
The interval processes one, five or ten complete source bars per step, displayed
in the source's real seconds or minutes. **Advance 10 source bars** is in the
navigation menu beside **Go to**. Stop retains the current candle; Fast toggles
10x playback.
Speed changes retain one playback loop, including during a pending bar request.
Optional appearance assets remain outside Git in `local-app/.local-ui/`; installs
without that private pack use Vela's own icons.

New sessions use a calendar date and time in UTC, London or New York. Changing
the zone preserves the selected instant. The server chooses the first cached
source candle at or after that time; requests outside the cached span fail.
No provider download is needed to choose a time within an existing dataset.

**Go to** offers an exact date/time plus **London 08:00**, **New York 09:30** and
**Next day**. The city shortcuts use the next weekday occurrence in that city's
zone, including daylight-saving changes. Next day preserves the current local
time in the selected zone. These are time conventions, not exchange holiday
calendars; missing candles land at the next available candle. Jumps process all
intervening candles in batches of at most 5,000, including orders, costs and prop
rules. **Stop** or Space pauses between batches and retains processed progress.
Earlier dates require a separate session.

The drawing favourites bar docks in the bottom bar and starts with Trend Line,
Horizontal Line and Rectangle. Star or unstar tools in Vela's drawing menus to
customize it. It tracks
the active chart and retains your choices across sessions and reloads on the
same app address. Run and Develop have separate browser preferences. Removing
all stars hides the bar until a tool is starred again.
Drag its six-dot handle to move it within the chart. Arrow keys move the focused
handle, with Shift for larger steps. Its position survives reloads and adjusts
when the chart is resized.
Press Home or Enter on the handle to dock it again. The star at the bottom of the
drawing rail shows or hides the bar. Lock, hide and delete controls act on the
active chart and support undo; Trash's options menu also retains Eraser mode.

Vela's open-source package supplies the chart workspace and headless replay
interfaces, but no ready-made replay toolbar or manual order ticket. This app
adds those controls through Vela's public extension interfaces and keeps one
server-owned simulation cursor. All native layouts are available, including
custom grids of up to sixteen charts. Saved synchronization settings are retained.
Custom intervals must be whole multiples of the source resolution. Weeks start
on Monday and monthly bars follow actual UTC calendar months.

Create a named practice or challenge session from a cached dataset. Configure
contract size, commission per contract per side, spread and adverse slippage.
Save/resume retains the cursor, account, positions, orders, fills, trades,
bookmarks and chart layout/drawings. A new attempt preserves the previous one.
Export a session backup to retain its candles and account together.

Orders become eligible on the next source bar. Prices use the selected futures
contract's tick size and point value. OHLC candles do not establish the actual
intrabar price path. The simulator uses conservative stop-first handling when
both protective exits are reached in a candle. Source granularity is displayed;
one-second candles improve detail but are still not an exchange trade tape.

Challenge presets are generic examples, not verified rules for any named firm.
Review daily loss, drawdown type and lock, profit target, reset timezone/hour,
minimum trading days, maximum contracts and consistency settings before each
attempt. Rule violations stop the attempt. Seeking backward creates a new attempt
rather than changing previously recorded trades.

Daily loss measures current equity against that reset day's starting cash balance.
End-of-day trailing drawdown uses the closing cash balance. Intraday trailing
drawdown includes unrealized equity. Costs can take a liquidation beyond a loss
boundary. Monte Carlo resamples closed net trades; it does not replay intrabar
drawdown or certify a challenge pass.

## Databento

The Data settings accept your existing Databento key. It is encrypted with
Windows current-user DPAPI in your local application-data directory. The backend
does not return the key to the browser or include it in a session backup. The
application binds to loopback, rejects other origins and requires a local token
for state changes. Do not expose it through a tunnel or reverse proxy.

Select an exact raw contract, UTC start/end range and `ohlcv-1m` or `ohlcv-1s`.
Review the provider's estimate, then download explicitly. The local policy
accepts only an exact zero-dollar quote and re-quotes the identical scope before
download. Positive or invalid estimates stop the download. There is no automatic
download at startup. A quote is an estimate, not an independently verified bill;
the provider does not expose an atomic request billing cap. Existing account or
exchange-subscription fees are separate. This app does not change subscriptions.

The local cache is independent of session state. It retains complete validated
candles with a content checksum and reuses them across attempts. Import CSV or
Databento JSONL to work without another provider download. Demo data is synthetic
and labeled as such. No data, settings, credentials or account files belong in Git.

The configured local installation already contains the previously acquired NQM4
one-minute bars for 8–9 April 2024. They were imported from the existing cache;
setup did not download them again. Your encrypted key remains outside the checkout.

## Local capacity

Each dataset holds at most 250,000 source bars. The candle cache retains at most
four datasets and 250,000 bars in total; other datasets remain in SQLite. Each
rendered chart receives at most 5,000 revealed bars, with up to sixteen chart cells.
Standalone Pine backtests can use all revealed history, up to 250,000 bars.
An advance processes at most 5,000 source bars per request. Longer Go-to jumps
use cancellable batches. Session backups have a 64 MiB restore limit.

The local store permits 200 datasets, five million stored bars and 1,000 sessions.
An attempt retains at most 20,000 orders, 40,000 fills and 20,000 completed trades.
Large saved ledgers take longer to validate; the measured limits are recorded in
the verification report. These are local measurements, not a latency guarantee.

## AI chart connection

The **AI connection** panel prepares a question for the visible chart or a drawing
region and provides a prompt to copy into your connected AI. It gives your AI
application typed tools for revealed candles, screenshots, timeframes, native
numeric history, Pine context, drawings, sessions and the strategy tester.
The AI application handles model sign-in and usage. This
chart bridge makes no model API calls and adds no model key to Vela.

See [MCP setup and capabilities](local-app/MCP.md). Both desktop modes can be
discovered through the same MCP connection. Keep replay paused for AI requests.
The bridge pins each request to one browser window, session generation and cell;
it rejects expired or replaced targets. Chart changes use the existing session
save path. AI tools can run, update and cancel Pine jobs and inspect bounded
script context, plot history and strategy trades. Detached calculations inspect
unplotted indicators across timeframes without altering the chart. Numeric reads
identify their completed settings and data; pending or stale calculations are
explicit. Long jobs return an ID for status and cancellation. Global saved
results require explicit reads and remain separate from blind replay analysis.

## Pine, strategies and templates

Open **Pine Editor** from the lower right rail. Run an indicator or strategy on the
chart; edit it with Update, or use Backtest for the full revealed history. The
editor includes saved scripts, version history, search, import/export and draft
recovery. **Strategy Tester** contains performance, trade analysis, trade logs,
a calendar and cancellable seeded simulations. Save a run to reopen its original
source, inputs, data checksum and engine versions.

Deep Backtesting selects a separate cached UTC date range without advancing the
replay cursor. Source candles start at or after From and close by the exclusive
To boundary. An intersecting higher-timeframe candle keeps its standard opening
label, which can precede From; it contains no prices from earlier source candles.
The trailing higher-timeframe candle can also be partial. The calculated limit
is 250,000 candles; choose a higher resolution or shorter range if exceeded.

If a run cannot be saved, its report and export remain available. Retry Save run,
or export the result and explicitly select Discard unsaved result to continue.
Automatic updates remain blocked while that result needs preservation.

**Templates** saves indicator sets, chart appearance and workspace layouts.
Applying a layout keeps the active replay contract and valid source resolutions.
Native chart styles, drawing tools, studies, settings, synchronization and layout
options remain available. The editor and results stay collapsed until opened.

See [scripting and backtesting](local-app/SCRIPTING.md) for history scope, pricing,
resource limits, storage and upstream runtime limitations.

## Verification and upstream

The fork starts from upstream `596cbbdeba15406cfb72465afd07f8c60c6b1852`
(Vela 0.8.5). Application source lives in `local-app/`; the library's public
interfaces supply the charts. Root package scripts, test/lint configuration,
README, changelog and ignore patterns are modified for this local fork. Dependency
patches resolve the advisories present in the upstream lockfile.

Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and
`npm run local:build`. The [implementation verification report](local-app/VERIFICATION.md) records actual
executed tests and browser scenarios; source inspection alone is not runtime proof.
