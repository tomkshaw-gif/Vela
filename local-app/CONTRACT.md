# Local Replay Studio contracts

This local application is separate from the chart library's published entries.
Use the public Vela chart/workspace interfaces. Preserve attribution. No live
broker integration, hosted service, analytics telemetry or external font requests.

`shared/types.ts` owns the wire vocabulary. Candle times are UTC epoch-ms opens;
the simulation advances through **closed source bars**. Native data granularity
is explicit. Market orders become eligible on the next source bar. No command
may fill retrospectively on a candle already shown. When OHLC cannot establish
which protective exit happened first, use a disclosed conservative stop-first
model. This is simulation, not a reconstruction of the actual tick path.

Passive limits touched within a source bar use same-side price priority: higher
buy prices first, lower sell prices first, and submission order at equal prices.
Only same-side touched limit slots exchange order; stops and opposite-side slots
keep their existing sequence. Orders executable at the open retain their opening
sequence and favorable-gap improvement, with fills bounded by each limit price.
This deterministic local rule does not establish the unknown mixed-side intrabar
path or replace the conservative protective-exit model.

Replay quote displays deliberately use equal bid and ask from the last revealed
source close. They are simulated prices and do not imply exchange quote data or
guaranteed execution. Quick Buy/Sell creates a market order for the selected
quantity through the session command queue; execution still starts on the next
source bar with configured costs. Session identity, generation and revision are
checked again before dispatch and revision is rechecked inside the queue.
Chart draft edits do not create orders. Successful submission retires the matching
draft without discarding a newer edit. Projected bracket P&L is gross price
distance times quantity and point value, not an additional fee calculation.

Partial exits use whole futures contracts. `{type:'close', qty?}` keeps its
next-source-bar eligibility, cancels working orders and caps the executed close
to the surviving position. Omitting `qty` captures the current position quantity.
Percentages are a UI selection aid converted once to explicit integer contracts;
the engine does not store or repeatedly apply percentages.

`OrderDraft` and `Position` may carry `takeProfits: TakeProfitLeg[]`, where each
leg is `{id, price, qty}`. A bracket has at most ten legs with unique owner-local
IDs, tick-aligned prices and positive whole-contract quantities whose sum does
not exceed its quantity. An empty list is valid. `takeProfit` remains the legacy
all-remaining target; a scalar and a leg list cannot coexist, even an empty list.
`amend.takeProfits` replaces the whole list, `null` removes it, and omission
preserves it. Switching target authorities requires explicitly clearing the old
one in the same amendment. Leg IDs survive price/quantity amendments and are
copied to target exit fills and trades as `takeProfitLegId`.

Targets exit only existing inventory. Touched legs execute nearest first, with
list order breaking equal-price ties, and each exit consumes its leg before
reconciling the remainder. Every reduction, including an ordinary opposite-side
fill or manual close, trims excess allocations farthest first; later list entries
are trimmed first at equal prices. Trimming happens on execution, never when a
close is queued. A configured stop protects all actual remaining contracts and
does not reserve a separate additive quantity. Each partial exit remains one
closed `Trade` for accounting and analytics.

Same-side additions preserve existing legs and append explicit new legs. The
merged list must meet the same limits; collisions and scalar/list scale-in
conflicts are rejected at admission. Unbracketed additions retain the bracket.
An ordinary order that purely reduces or flattens current exposure cannot carry
`takeProfits`, including an empty target list. Legacy scalar SL/TP fields remain
accepted on reducing orders and are ignored on the reducing fill; they do not
replace the surviving position's exits. A reversing order's target quantities
must fit only its newly opened residual exposure. These conditions
are checked again at execution; a queued order that no longer fits is rejected
before filling or charging fees. Explicitly amend the position bracket instead
of attaching target legs to a reducing order.

Existing gap/risk and stop-first ordering also applies to target legs. Opening
gap targets precede queued discretionary orders; favorable gaps may improve each
limit-bounded execution. Intrabar stops precede targets on ambiguous bars, and
remaining inventory continues through target, excursion and prop-risk checks.
Triggered entries use their trigger reference, never the earlier source-bar open
as an exit gap. Adding or amending targets never inspects unrevealed OHLC or fills
on an already revealed bar. Weighted cost basis, fee rounding and proportional
risk/MAE/MFE allocation are unchanged.

`Session.executionVersion?: 2` is set on first use of the target-list contract and
retained after targets are removed or filled. Legacy-only sessions omit it.
`validateExecutionVersion(input: unknown): 1 | 2` in `engine/validation.ts` rejects
unknown markers and requires marker `2` whenever an order/position has a
`takeProfits` field (including an empty list) or a fill/trade has
`takeProfitLegId`. Stored-session validation preserves and validates these fields;
an unmarked legacy session cannot silently carry newer execution data.

## Pure engine exports (`engine/index.ts`)

- `createSession(config: SessionConfig, instrument: Instrument, id?: string): Session`
- `applyCommand(session: Session, bars: Bar[], command: Command): Session`
- `analytics(session: Session): Analytics`
- `monteCarlo(session: Session, options?: {runs?: number; tradesPerRun?: number; seed?: number}): MonteCarlo`
- `validateSessionConfig(config: unknown, barCount?: number): SessionConfig`

The engine owns execution, fees, positions, intrabar conservative risk checks,
prop accounting including reset-zone trading days, and its bounded equity curve.
No data IO. Default rules are generic editable examples, not named firms' rules.
Prop violations stop the attempt, cancel orders and flatten conservatively.
All sessions/commands validate finite numbers and limits. No backward seek.
Starting over creates a separate attempt and preserves the original.

## Local backend (`server/`)

Bind only 127.0.0.1:5197 by default. Reject untrusted Host/Origin. All writes need
`X-Local-Token` from bootstrap. No CORS. SQLite lives in the current user's local
application-data directory, outside Git. Persist every successful command with
optimistic revision checks. Credentials use Windows current-user DPAPI and are
never returned in API results. Import and export never contain credentials.

- `GET /api/bootstrap` => Bootstrap
- `GET /api/datasets` => DatasetMeta[]
- `POST /api/datasets/demo` => DatasetMeta (deterministic, visibly synthetic)
- `POST /api/datasets/import` `{name?,symbol,schema,format:'csv'|'jsonl',text}` => DatasetMeta
- `POST /api/provider/settings` `{apiKey}` => `{configured:true}`
- `POST /api/provider/quote` ProviderRequest => ProviderQuote; positive or invalid
  costs never create a downloadable quote. Strict total budget is zero.
- `POST /api/provider/download` `{quoteId}` => DatasetMeta. Re-quote exact scope,
  require zero again, bound response bytes/bars/deadline, commit complete data only.
- `GET /api/sessions` => SessionSummary[]
- `POST /api/sessions` SessionCreateConfig => SessionView. Accept either the
  existing `startIndex` or absolute epoch-ms `startTime`, never both. Resolve a
  time to the first cached source candle at/after it; reject outside actual span.
- `GET /api/sessions/:id` => SessionView
- `GET /api/sessions/:id/navigation?time=<epoch-ms>` => SessionNavigation:
  current/target source indices and timestamps only. Require a forward target.
  This indexed lookup never returns future prices or changes replay state.
- `POST /api/sessions/:id/command` `{expectedRevision,command}` => SessionView;
  revision mismatch => 409. Advance capped at 5,000 bars per request.
- `POST /api/sessions/:id/clone` `{name?,restart?:boolean,startIndex?:number}` => SessionView
- `GET /api/sessions/:id/chart?timeframe=1m&limit=5000&after=<epoch-ms>` => ChartView.
  Only bars revealed through the saved cursor. Aggregate using revealed source
  bars, including an honestly partial current higher-timeframe bucket. With
  `after`, return that bucket and new ones for incremental chart updates.
- `GET /api/sessions/:id/analytics` => Analytics
- `GET /api/sessions/:id/series?timeframe=1&cursor=<index>` => cached script
  candles and futures symbol metadata, capped at 250,000 bars. Alternatively pin
  `cutoff=<source timestamp>`. Reject future cursors/cutoffs before aggregation.
  Optional exact `symbol` resolves another cached contract at that same clock;
  it never downloads missing data. Range bounds select aggregated bucket opens.
- `GET/POST /api/scripts`, `GET /api/scripts/:id`, version/history and
  archive/restore/clone routes maintain local documents with revision checks.
- `GET/POST /api/backtests`, `GET /api/backtests/:id` save immutable run snapshots.
  Completed runs can be saved during the update handoff, before the client ACK.
- `POST /api/sessions/:id/monte-carlo` `{runs?,tradesPerRun?,seed?}` => MonteCarlo
- `GET /api/sessions/:id/export` => `{version:1,session,dataset,bars}`
- `POST /api/sessions/import` backup => SessionView; validate and generate new IDs.

Errors: `{error: string, code?: string}`. No errors or logs may echo a provider
credential. Exact raw futures contracts only (NQ/MNQ/ES/MES), no silent roll or
micro substitution. Supported schemas: ohlcv-1m and ohlcv-1s. Quote/data calls are
server-side, fixed official host, no startup fetch. Cache data immutably by scope
and content checksum. Enforce request/body/history/memory bounds.

## UI (`client/`)

Vanilla TypeScript + Vela native workspace/chart. Root boot index.html. Standard
full-screen native chart, compact replay strip, optional native Trade panel and
floating favourites. Sessions/results/data settings live on a separate route.
Calendar starts and forward jumps use UTC/London/New York conversion. Long jumps
call ordinary advance commands in batches of at most 5,000; no cursor teleport.
All simulated orders say simulated. Data source/resolution/fill model are visible.
Server owns cursor/account truth. One playback request at a time, cancellation
generation on switching sessions. Keyboard shortcuts ignore inputs/dialogs.
Save/resume includes chart drawings/layout. No future chart bars or fills.
Pine source/settings/visibility also round-trip through per-cell extension state.
Pending AI replacement scripts remain transient until successful completion.
No provider key in storage, DOM attributes, logs or application state snapshots.

## Local chart AI connection

`shared/chart-agent.ts` owns the chart tool vocabulary. The stdio MCP entry is
`mcp.ts`, using the official MCP SDK. It discovers installed desktop port 5196 and
source ports 5197 and 5199, and routes each explicit browser identity to its original backend.

- `GET /api/assistant/clients` lists live window/session/generation/cell metadata.
- `POST /api/assistant/exchange` registers a browser lease, takes one queued tool
  task and acknowledges its completion. The lease token stays private.
- `POST /api/assistant/call` queues one typed chart operation and awaits a bounded
  browser result. No automatic mutation retries or alternative target selection.

The existing local token, Host/Origin checks, credential redaction, body limits
and runtime update barrier apply. Leases expire after eight seconds; an active
browser operation renews its authenticated lease without dispatching another
task. A request expires after ten seconds. At most sixteen clients and eight
pending requests exist, with one pending request per client. Registration,
completion and up to 64 operation receipts are retained in memory. Receipts
expire after five minutes. An unknown outcome never proves a mutation failed.

The browser checks session generation, explicit cell identity, task deadline and
runtime state at execution, including after queued timeframe work. Candle reads
use the existing revealed-only chart route and compare source cursor timestamps
to catch advancement in another window. Never expose the session export route
through MCP; its full backup includes unrevealed source candles.

Registered native studies and isolated Pine scripts are supported. Native numeric
history carries calculation identity; opaque renderer output is not converted
into invented numeric series. Pine source is never evaluated in the UI thread.
Pending or stale identities return no numeric result. Screenshot
output uses the actual renderer capture, including supported rasterized legends
and overlays; arbitrary app DOM and crosshair are excluded. Images are bounded
to 1280 by 800 and 1.5 MiB. Other tool results are bounded to 256 KiB.

Drawing/indicator/timeframe/view changes save through existing optimistic chart
persistence. If saving fails after an edit, the tool explicitly reports that the
chart changed and saving failed. No model account, model API key, broker action,
provider download, shell execution or dataset export is exposed.

Detached analysis scopes pin an exact target, dataset checksum, session revision,
cursor and timeframe. A historical source clock is resolved through the normal
revealed-only series route. Its source candle is wholly observed at open plus
source duration. Secondary candles must close within that availability boundary
before aggregation. Region bounds filter returned points, while calculations
use explicitly reported warmup. Detached scopes cannot call Deep history.

Deep history is a separately requested cached date range. Trusted SQL work runs
off the backend event loop; untrusted Pine remains in isolated browser workers.
Primary ranges, duplicate conflicts, capacity and secondary scope lifetime fail
explicitly. Starting Deep never advances or writes the manual replay ledger.
The tester's UI and AI entry points share exact-handle settings, ownership,
cancellation, result-generation and persistence checks.

App-context reads project known bounded fields. Default manual session context
contains revealed history only. Global saved backtest details require an explicit
ID, and source requires an explicit flag. Client-reported results are validated
and retain provenance; they do not become trusted execution attestations.
