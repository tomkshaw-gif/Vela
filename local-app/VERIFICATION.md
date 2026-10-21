# Local Replay Studio verification

Date: 21 October 2026. Scope: standalone local application on Windows with Node
24.21.0. Upstream base: `596cbbdeba15406cfb72465afd07f8c60c6b1852` (Vela 0.8.5).
Application changes are local on `feat/local-replay-studio`; publication requires
the review approval specified by the repository's agent guide.

## Current visual audit status

Completed runtime and gate snapshot: `65d373920d99edee`. Run on port 5197 and
Develop on 5198 both report ready on this source, without a pending update.
No application changes remain pending from this audit.

The ticket uses the inspected source layout and controls: desktop 16px gutters
(20px below 480px), 34px inputs with 8px radii, 38x20 exit switches, visible disabled
exit fields, instrument tick value and a 56px/radius 12 multiline submit button.
The header uses 48px desktop/32px narrow geometry, 14px/600 symbol typography,
24px replay icon and 38px/32px close targets. Native body padding cannot add an
extra 8px. Positions and working orders remain functional in the lower
**Positions & orders** tab; account/evaluation details are under **Rules & costs**.
Order/DOM mode tabs follow the inspected capability condition and stay absent
when DOM is unavailable. The recovered replay adapter explicitly sets simulated
bid and ask to the last revealed candle close. Chart and ticket prices use that
adapter, with tick-based precision and zero displayed spread; before a price is
available they remain inert. These are not exchange quotes. Quick clicks submit
one simulated market order through the guarded session command queue.

The in-chart header uses source-derived 16px identity, 13px readouts, 18px replay
badge, 34px quote buttons and a content-sized 22px quantity control. Quantity
edits synchronize with the ticket and remain intact during background layout
saves. A measured accessory slot keeps 24px indicator rows below the header;
hidden-eye and collapse actions retain native behavior and surface-aware ink.
The external replay marker does not start or double-filter the native controller.

Real Chromium checks caught the later UI reset shrinking the replay glyph's
8px content box to1px after7px padding. The scoped order selector now wins that
cascade. Both modes measured content-box sizing,8px content width,7px left padding,
15x8 total bounds and the expected non-empty blue SVG fill.

Limit labels use separate side, replay/quantity, type/P&L and cancel regions,
19px bodies with 4px radii, 13px text and independent price-axis tags. Projected
brackets show gross P&L. Main/selected/hovered/moving priority follows the source;
normal overlap packing remains disabled. Successful submission retires its
matching draft and exits while preserving newer edits. The inactive ticket
reactivates on input, focus or mouse/keyboard order-type selection.

Draft visibility belongs to the ticket lifecycle. An active draft remains visible
beside a working order at the same entry, including changed quantity or exits and
a deliberate identical new order. Four regression cases failed with the earlier
price-only suppression and passed after its removal; the focused order-line and
ticket suites passed 52 tests.

Released amendments retain their preview price and moving priority through the
actual command's completion. Identity changes or failures return to canonical
state; no timer guesses when a save finished. Real browser checks deliberately
held a local amendment for 120ms, confirmed no snap-back before acknowledgement,
then cancelled the intended limit next to its TP. Draft Escape/removal sent no
commands; release sent one amendment and chart cancellation sent one cancel.

The final `65d373920d99edee` UI proof passed in both compiled Run and Develop:
numeric simulated quotes, two-way quantity edits, exactly one buy and sell market
submission each, enabled draft exits, measured styles, indicator eyes/fold,
390px overflow checks and sixteen chart cells. Holding a real local place request
while changing quantity3-to4 and TP preserved the newer same-price draft after
acceptance. Cancelling the accepted order left that draft intact. The cursor,
account, fills and trades were unchanged; final working-order count was zero.
All requests stayed local and no JavaScript errors were reported. These scenarios
used only an owned practice session and cached NQM4 bars.

Actual Windows font inspection confirms Trebuchet MS: headings20px/600/24px,
metric labels14px/400/18px and values16px/500/24px. Dark neutral text is#dbdbdb,
positive#22ab94 and negative#f7525f; computed styles confirm the legacy tone rules
cannot override these values. The main chart retains Vela's renderer with ported
integer candle geometry and axis painting. The results chart uses the actual
static cached chart modules through an integrity-checked private local asset.

Terminal axes use font-scaled padding, measured glyph centering and physical
divider strips. Reserved time-axis height follows the inspected optimal-height,
space-admission and even-rounding rules:28px at font 12,36px at16. Live font and
size changes update coordinates and overlays. The constructor's25px placeholder
was rejected during independent review. Native numeric time-span classification
is not equivalent to the reference's and was not guessed. Saved custom styles
remain intact; only the complete earlier default preset receives font migration.

The earlier `b82e083d5da51996` checkpoint passed real Chromium checks in compiled
Run and Develop at 2000x1154, 1280x800 and
390x844: no page overflow, supported header/panel/template actions, visible editor
Library controls, correct maximized right edge and drawing lock/hide/delete/undo.
Replay advanced exactly five source bars and stayed paused after its controls
closed. Native four/sixteen layouts retained appearances; restoring one chart
remained saved after 1.8seconds and survived reload after both layout sizes.

Both modes passed real lower-dock resizing280-to 430px, reload persistence,
collapse/maximize/restore and retained results-canvas identity through an advance.
Working limit drag preview sent no request; release sent one tick-aligned amendment.
Escape restored the draft and chart cancellation worked. Separate real Run tests
placed both buy and sell marketable limits, confirmed no same-bar fill, verified
the next source-bar opening/cost price remained within the limit, and closed each
position through the lower controls, ending flat with no working orders. These
checks used owned QA sessions and the existing cached NQM4 data, without provider,
model or broker calls. Original trading sessions were not used.

Native nine-group gesture proof and actual Run/Develop wheel/Ctrl anchoring,
body-pan and release tests passed without future bars or account/cursor changes.
Final controlled profiles explicitly selected Cursor, hit-tested after hover
controls appeared, confined180 pointer moves to the exact target plot and verified
its visible range changed. With Data window open and400 target bars, single-chart
handler p95 was 2.1ms and sixteen-chart p953.7ms; both frame p95s were16.8ms with
zero long JavaScript tasks. Maximum frame gaps were116.7ms and166.6ms respectively.
These bounded headless measurements do not certify reference-runtime performance.
The earlier slow sample hit hover cell controls and is not chart-panning evidence;
no speculative product optimization was made from it.

The local simulator now prioritizes touched passive buys by descending limit
price and sells by ascending price, stable at equal prices, exchanging only
same-side limit slots. This fixes a demonstrated insertion-order artifact while
preserving opening execution, limit caps, other trigger slots, brackets and risk
handling. It is a documented local OHLC rule, not recovered reference execution.
41 contract cases and existing engine/risk cases passed 122 focused tests.

T3 snapshot capture repeatedly timed out. Final direct captures used Playwright
Core 1.63.0 in an isolated ignored QA helper with existing Chromium after a borrowed
helper disappeared. This did not change the root package/lockfile or local-request
security. Exact pixel identity remains unconfirmed because active reference
settings, OS/DPI, tick classification and the unavailable study execution are not
fully matched. Mixed-side OHLC chronology is unknown. Orders and active drafts at
exactly the same price can have overlapping chart labels; the working-order list
remains available. Unsupported broker, exchange-quote, cloud/social and adjustment controls are
not represented by enabled placeholders. Local scripting remains supported below.

## Current gates and independent reviews

All six final gates passed on the unchanged `65d373920d99edee` snapshot, with Node
24.21.0/npm 11.19.0. Commands ran sequentially with browser jobs closed and source
workers quiet:

| Command | Result | Elapsed |
| --- | --- | --- |
| `npm.cmd run typecheck` | Both TypeScript projects passed |14.589s |
| `npm.cmd run lint` | Passed |63.627s |
| `npm.cmd test -- --maxWorkers=1` |257 files /3,310 tests passed |423.348s |
| `npm.cmd run build` | Library entries and declarations passed |20.864s |
| `npm.cmd run local:build` | Local production build passed |6.593s |
| `git diff --check` | Passed |0.120s |

Before/after manifests matched 740 source files,26 supplemental files and five
private assets. Source aggregate SHA-256:
`F1DBD2F9721070CD8CAECA85A4DD0A3DBBD918909AAB4236368AC36EE53E705A`.
Supplemental aggregate:
`8ED2F3F2D9224F9481E5F1BD0679C4EB04152E9995AAC589A6A6E50F043D7C19`.
Private asset aggregate:
`5F220B809229D0EEB65081E61938B89274184E1AD26C2D728C24843874F83CB3`.
Private results-module hash:
`806C19C55500BF3DF933A474E4E49C1315964C7EAF9FAF414D61EC2E5F6EE020`;
its manifest hash:
`B5D44454EAF0F1E1AAE0722605C26EA59960FE9FF42D90357619C449AE9FB569`.
Branch and HEAD remained `feat/local-replay-studio` and
`596cbbdeba15406cfb72465afd07f8c60c6b1852`. Full logs and manifests are retained
locally. Non-failing jsdom canvas, empty-chunk and configured bundle-size
notices were emitted. This is local verification, not publication acceptance.

The initial four-worker run failed two deterministic checks: a CSS fixture used a
browser URL with Node's file reader, and two fixed accent literals bypassed the
shared palette. Both were corrected without changing their assertions. Eight
test/hook timeouts also occurred; all six related files passed 225 tests in one
serial diagnostic invocation with unchanged timeouts. Scheduling or I/O contention
is plausible, but its original cause is unproven. The final whole-tree run used
one worker and passed without changing assertions or time limits. An intermediate
gate attempt was stopped before tests to incorporate the independent review's
same-price draft finding.

Fresh source-only independent final review returned CLEAR after that finding was
fixed. A fresh source-only review also cleared the later glyph selector fix; both
desktop UI checks and all six gates then passed on its source version. The earlier
`448e81f724eb6f67` snapshot also passed all six gates and 3,310 tests before that
rendered-style finding. Earlier independent review returned CLEAR with 11 files/148
tests passed for
axes, ticket, limit ordering, lower tabs, analytics and persistent results charts.
The final unsupported mode-row removal received source-only confirmation
afterward and is included in the full final gates. Earlier AI, deep-backtesting,
core lifecycle and multi-chart reviews remain separate supporting evidence.

Earlier completed checkpoints remain valid for their own snapshots: `b82e083d5da51996`
passed 254 files/3,265 tests and all six gates;332357651380bb97
passed 252 files/3,201 tests and all six gates; ba20c842001e5c9d passed 243 files/3,097
tests and its composition checks. They do not substitute for the final checks above.


## Earlier functional runtime proof

The real Develop and compiled Run interfaces completed Deep Backtesting using
the existing 2,760 cached NQM4 minute bars. Normal replay used 60 revealed bars
and returned no trades; the selected full cache range produced one closed trade
with 80 simulated net profit. Saving, reloading and exporting preserved the exact
canonical result, including source, inputs, costs, range and provenance. A custom
end date used 2,580 bars. Reset restored the normal revealed-history result, and
loading-stage cancellation retained the previous report. The manual session
cursor, account, orders, fills and trades stayed unchanged. Storage-full recovery
has automated coverage but was not exercised in the real browser.

A real stdio MCP process launched from an unrelated working directory exposed
38 tools. Detached analysis evaluated a hidden five-minute SMA at a historical
scope and returned 18,321.15, matching an independently aggregated calculation.
The operation left the visible chart and manual account unchanged and retained
the cached-data provenance. A separate visible script run completed one closed
trade with -5 simulated net profit; the shared tester and exact-generation result
reader agreed. Temporary proof indicators were removed. No provider, model or
broker calls were used.

The chart AI connection uses an external AI host. It provides chart, drawing,
indicator, saved-session, source-library and backtest tools, rather than an
embedded model conversation. Detached calculations are bounded and use disposable
browser workers. Plot/trade results are bounded before returning to the AI host;
the runtime may still transfer intermediate arrays within the configured source
and warmup limits. Legacy scripting engines without computation identities remain
readable but unverified. Native asynchronous/opaque indicator output is not
reported as verified numeric history.

Independent final reviews cleared the AI integration and Deep Backtesting paths.
The core scripting lifecycle review also cleared synchronous execution failures,
cancellation and stale responses. Stored result provenance is reported by the
local client, not a signed execution attestation. Daily, weekly and monthly bucket boundaries use
UTC calendar rules rather than exchange-session rules.

## Earlier scripting checkpoint

Earlier source version: `2c5c18071728271d`. On that unchanged source, the full suite
passed: 226 files and 2,808 tests. Typecheck, lint, the library build including
declarations, the local application build and diff checks passed. Dependency audit
reported zero vulnerabilities. The isolated Pine compiler worker is 933.62 kB;
the application loads the editor, script host and result viewer on demand.

The compiled Run browser executed Pine against 2,192 revealed NQM4 candles from
the existing 8–9 April 2024 cache. A saved strategy version produced one closed
trade with -27 net P&L, 2 commission and 49,973 account equity. Saving its source,
running the full revealed-history backtest, saving the result and reopening that
result after reload were exercised through the real UI. A separate Develop QA
session executed another strategy and its full-history backtest: one closed
trade, 33 net P&L, 2 commission and 50,033 account equity. Neither altered the
manual practice account or downloaded data.

The actual browser selected a sixteen-cell layout, saved a workspace template,
returned to one cell and applied the template to recover the sixteen-cell grid.
Indicator and appearance templates retain their distinct native controls. The
editor and tester occupy a resizable lower dock, opened from the lower right
rail. The local asset pack now contains 101 validated glyphs, including the
editor, tester and template controls. The desktop header occupies 42 pixels
including its separator; drawing and panel rails remain 52 and 45 pixels.

A real stdio MCP process launched from an unrelated directory advertised 19
tools. Fifteen actual calls exercised discovery, candles, native indicator
listing and all six script tools. An indicator returned the revealed close
18,387.75; successful staged replacement returned 18,388.75 and persisted its
exact source. Cancelling a heavy replacement retained the working indicator.
Temporary proof indicators were removed, the layout was saved and the dedicated
QA window closed normally. This scripting proof used Develop; earlier native
drawing, indicator, timeframe and screenshot proofs covered both modes.

Keyboard proof focused the result-notes disclosure, used Right Arrow and Space,
and left replay paused at cursor 2,191 while toggling the disclosure normally.
Separate-window editor drafts, source naming, delayed script updates during
handoff, saved-result replacement, bracket-risk cancellation and cutoff-safe
Heikin Ashi requests also have focused regressions and actual-worker probes.
All proof actions used dedicated QA sessions and cached data, with no provider,
model or broker requests. Upstream runtime limitations are documented in
[SCRIPTING.md](SCRIPTING.md).

## Earlier runtime evidence

Appearance/replay/AI follow-up: 98 validated machine-local SVG assets are loaded
before native toolbar construction: 62 drawing glyphs and 36 utility/control
glyphs. Desktop rendering has a 38-pixel header, 52-pixel drawing rail, 45-pixel
panel rail and a 48-pixel replay row plus its border. Native panel actions remain
functional. Opening Trade placed its 300-pixel panel immediately beside the rail
and resized the chart without overlap. The palette uses the installed reference's
dark surfaces; native Light/custom colors retain their own settings.

The real browser moved the focused favourites grip two pixels with Right Arrow
without changing replay time. Its normalized position survived reload. A
390-pixel viewport had no document overflow and kept Play/Stop/Step/Fast visible.
Play, Fast and Stop advanced the proof session once and stopped with the 10x
selection retained. The actual production shell has unique IDs, one shared
dialog and separate management forms/results. The calendar dialog opened with
UTC/London/New York controls; the native AI connection panel opened normally.

The chart MCP was registered in the local Codex configuration. A real stdio
process launched from an unrelated working directory initialized successfully,
advertised fourteen tools, read the open chart and returned an actual renderer
image. The Windows ESM loader uses a file URL. This proof passed against both
Develop and compiled Run. Tool calls added, updated and removed a native drawing
and SMA, changed between one- and five-minute charts, read revealed candles and
returned bounded images. Temporary proof drawings/studies were removed.
Independent chart-AI and UI reviews are CLEAR after the corrections.

Calendar/navigation/favourites follow-up: the real Develop Vela browser created
a named NQM4 session at 2024-04-08 06:30 UTC (07:30 London), resolving start index
390. London jumped to 07:00 UTC, New York to 13:30 UTC, and Next day to
2024-04-09 13:30 UTC. A deliberately held navigation request left Stop reachable;
stopping before release kept the cursor at 2024-04-08 13:30 UTC. No provider call
ran for these operations. DST/invalid dates and jumps through pending fills,
protective exits, prop pass/failure and multiple 5,000-bar batches also have
focused tests against the actual engine.

The browser activated Trend Line from the floating favourites bar and observed
its selected state. Adding Ray through Vela's native star menu added it to the
bar immediately, survived a reload and could be removed through the same menu.
Independent reviewers cleared both the navigation and favourites changes.
An out-of-cache shortcut leaves the cursor unchanged and displays its error
inside the open dialog. The favourites bar also remains within a 390-pixel
viewport without document overflow.

The earlier save-handoff delay cleared. Run and Develop now both report ready on
source version `b8c4d5e5749ccff3`. The actual compiled Run browser loaded candles,
the revised native chrome, movable favourites and the labelled replay controls.
No process or pending chart snapshot was forcibly discarded.

Compiled startup was verified separately from build exit status: the initial
side-effect-only lazy import was removed by the package's tree-shaking rules.
Startup is now an explicitly exported function invoked from the bootstrap. The
rebuilt application includes its full main chunk and visibly renders in Run.

The installed Run Vela and Develop Vela Desktop shortcuts launched their managed
local modes on ports 5197 and 5198. Readback confirmed both shortcut targets,
working directory, hidden PowerShell launcher and Node 24 selection. The modes
share local SQLite/DPAPI storage and their backend listeners bind to 127.0.0.1.
The development proxy has an actual HTTP regression proving that `/api.ts`
remains a frontend module while `/api/runtime` reaches the backend.

The revised chart route uses native toolbars with the local appearance. Real-browser
checks exercised separate session navigation, the native Trade panel, next-bar
market execution, the native five-minute selector, adding SMA, and the native
four-chart picker. Selecting eight charts returned to four with an explanation.
One transport and unique form IDs remained after cell and session changes. The
chart route had no document overflow at a 390-pixel viewport. The management page
ignored replay/trading shortcut keys without changing its session cursor/orders.

A live update check held a pending chart-layout save in the Run browser, then
changed a watched source file. The old backend stayed in `preparing` with the
same instance until that save was released. The browser then reloaded
automatically into a new instance with the same session, cursor 51, open
simulated position, balance, five-minute resolution and newly added SMA. Playback
was paused. Develop independently reloaded and retained its selected session and
cursor. Independent code review cleared the update protocol and native UI.

The real collaborative browser loaded native Vela charts from 2,760 cached NQM4
one-minute candles for 8–9 April 2024. A submitted market order stayed working
until the next source bar. A later close recorded $395 gross profit, $5 total
commission and $390 net profit using the configured example costs. These are
simulated results. Browser reload and a backend restart retained the cursor,
balance, completed trade, four-chart layout, timeframes and native SMA indicator.

The browser also exercised CSV import, one-second rendering, a protective
challenge failure, disabled trading after failure, cloning, a fresh attempt,
session download and file-picker restoration, a bookmark, forward Go-to, a
persisted trendline and 500-run Monte Carlo. Minute-source sessions disable
second-resolution selections. A synthetic one-second adverse candle breached
the configured daily loss, flattened the position with costs and failed the
attempt. Synthetic fixtures are labeled separately from provider data.

A deliberately delayed five-minute response followed by a fifteen-minute
selection retained fifteen minutes in both the visible selector and saved state.
Bare digit typing in the chart no longer opens an unsupported native picker.
The browser recorded no application console errors or external resource requests.
Desktop and 390-pixel layouts had no document-level horizontal overflow.

Twenty-four single/four-chart layout switches retained stable DOM counts and,
after warm-up, stable global listener counts. A separate regression checks one
or four live cell subscriptions and zero after destruction. Displayed candles,
timeline marks and trade-table rows have explicit bounds.

## Persistence and security

Temporary SQLite/HTTP integration tests restore a 250,000-bar backup and compare
every candle, checksum, cursor and account. They exercise process recreation,
revision conflicts, partial higher-timeframe candles and recovery when an
incremental answer cannot contain a complete 5,000-bar advance.

The server listens only on `127.0.0.1`, validates Host and Origin, requires a local
write token, enforces same-origin browser policy and restricts static paths. Tests
cover request bounds, traversal, static access, redaction, DPAPI storage,
immutable datasets and provider quote scope. The browser receives only the key's
configured status. Actual credential migration used a bounded read-only local
configuration query and current-user DPAPI; no credential or provider data belongs
in source or backups.

One real metadata-only Databento quote for the cached exact NQM4 date range
returned HTTP 200 and estimated cost $0. No provider download ran during this
application setup. The provider offers no atomic billing cap; estimates do not
prove a final zero invoice or the subscription's billing terms. Downloads require
a separate user action and an immediate zero-dollar re-quote for the same scope.

## Execution review and measured limits

Independent financial review reproduced and cleared two corrected defects:
pre-entry candle opens no longer create fictitious intrabar bracket gaps, and
automatic target liquidation checks loss rules after costs. Six symmetric
reproduction cases and the 32-test engine suite passed on Node 24.

A seeded stress run reconciled stored state after 3,111 bar advances and 2,179
trading actions. Processing 250,000 synthetic source bars in 5,000-bar chunks took
869 ms flat and 1,016 ms with a position; the largest measured ordinary chunk took
31 ms. An 8,000-trade ledger with 16,000 orders and fills took 283 ms for a command.
Deep validation and serialization remain synchronous and can briefly delay the
local backend for a large ledger. These measurements do not establish sustained
latency or memory guarantees for every machine.

OHLC simulation cannot reconstruct exchange ticks, queue priority or liquidity.
The conservative adverse-path model and editable generic challenge presets are
not certification of a named prop firm's rules. Monte Carlo resamples closed
trades and does not model intrabar rule breaches.

## Earlier application gate checkpoint

At this earlier checkpoint, the following gates passed on Node 24.21.0:

| Check | Result |
| --- | --- |
| Typecheck | Pass |
| Lint | Pass |
| Full tests | 209 files, 2,543 tests passed |
| Library package | ESM, CJS and declarations pass |
| Local production build | 520 modules pass; application startup verified in Run |
| Dependency audit | Zero known vulnerabilities |
| Whitespace check | Pass |

The test environment emits 505 upstream jsdom canvas notices; no tests fail.
Real browser rendering is covered separately above. Both output directories
contain no Databento hostname, credential environment variable name or encrypted
credential filename. Independent financial and security/reliability reviews are
CLEAR after the corrections. The latter separately executed 17 focused client
and seconds-resolution regressions. The launcher was started and its child
server was verified listening only on loopback at port 5197.
