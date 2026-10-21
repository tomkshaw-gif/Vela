# Local scripting and strategy testing

The local app enables the public Vela workspace and the official
`@luxalgo/vela-pinets` 0.2.17 addon with PineTS 0.12.0. Pine v5/v6 indicators and
strategies execute in dedicated workers. The chart library remains separate;
its Apache-2.0 attribution and the addon's AGPL-3.0-only notices are retained.
The application is private and local. No model API or cloud account is required
to write or execute a script.

## Editor and chart

The lower right rail opens Pine Editor or Strategy Tester. Both use a resizable,
maximizable dock. The normal chart remains the default screen. The editor provides
syntax highlighting, completions, folding, search/replace, undo, diagnostics,
Run/Update/Add/Remove, a saved library, favorites, immutable versions, archive and
restore, cloning and text import/export. Ctrl+Enter runs; Ctrl+S saves.

Drafts persist immediately in bounded local browser storage, with a separate draft
for each window that survives reload. Legacy drafts remain recoverable. A storage failure
blocks automatic reload so unsaved code can be saved or exported. Saved scripts
and runs use SQLite outside the repository. Revision conflicts preserve the
editor's draft. Script source, inputs, properties and visibility save with each
chart and restore across session changes. A failed in-place update retains the
previous working script.

## Backtest scope and prices

Run executes over the loaded chart window, up to 5,000 bars. Backtest uses all
cached candles revealed through the chosen replay cursor, up to 250,000 bars.
The results identify the tested dates and candle count. Starting a backtest does
not advance replay, place a manual order or mutate the practice account.

Deep Backtesting uses explicit UTC start/end dates over all compatible cached
partitions of the exact contract and source schema. The start is inclusive and
the end excluded. Enable Deep in the tester, choose dates, then select Update
report. Reset replay returns to revealed-history mode. Deep results are separate
from chart replay and may include candles that replay has not reached. The limit
is 250,000 calculated candles; a larger selection is refused, so use a higher
resolution or shorter range. No download is triggered.
Source candles are selected before aggregation. A first or last intersecting
higher-timeframe bucket can be partial and retains its normal opening timestamp;
that label can precede the selected start without including earlier prices.

The official Pine strategy broker owns automated entries, exits, order timing,
margin and commissions. The separate manual replay simulator owns paper orders
and prop evaluation rules. Results from these two simulators are separate.
NQ uses a 0.25 tick and $20 point value; micros retain their own point value.
Strategy capital, quantity, margins, costs and inputs come from its declarations
and explicit property overrides. The example declares $50,000 capital, one
contract and 10% margins. A fully funded margin requirement can legitimately
prevent an unaffordable futures entry. Those percentages are example simulation
settings, not a broker margin quotation.

Secondary timeframe and cached-contract requests use a server-owned fixed replay
cutoff before aggregation. An already-running script cannot obtain later candles
when another request advances replay. Missing contracts require cached data;
scripts cannot trigger downloads. Fixed intervals must align with source bars.
Days use UTC midnight, weeks Monday and months real UTC calendar boundaries.
Standard and Heikin Ashi security requests retain their ticker semantics. Heikin
Ashi values derive from the complete revealed prefix before display limits apply.
Unsupported session or adjustment modifiers fail explicitly.

## Results and persistence

Report and List of trades provide official account metrics, supported performance
and trade-analysis sections, and explicitly labeled derived closed-trade equity.
The paired exit/entry trade list supports filtering, sorting, pagination, CSV
export and a UTC calendar. Narrow screens retain readable chart labels.
Simulation supports seeded shuffle/resampling, profit/ruin probabilities and
drawdown summaries. It yields between work chunks and supports cancellation.
Its resource limit is 1,000 runs of 5,000 eligible trades with 101 checkpoints.

Save run captures source, script version, symbol, timeframe, dates, dataset
checksum, inputs, properties, engine versions and results. Before replacing a
completed run or acknowledging an app update, the previous result is persisted.
An update cancels an unfinished calculation while preserving source and completed
results. Export always belongs to the result currently displayed.
Revealed runs record exact primary and secondary dataset checksums. Deep runs
record the selected dates, merged primary checksum and secondary provenance.
These records are client-reported, validated snapshots; they are not signed
proofs of execution. Earlier saved runs remain readable without alteration.
Daily, weekly and monthly labels use the same interval parser as the chart.
A failed save preserves the result and export. Retry saving, or export and
explicitly discard the unsaved result before continuing or acknowledging updates.

The library retains up to 250 scripts with 50 immutable versions each, 500 runs,
16 MiB per run and 100 MiB in total. Capacity refusal preserves existing records;
no script version or run is silently evicted. Source editing is capped at 200,000
characters; the AI bridge accepts 60,000 per request. Chart layout snapshots also
have a separate bounded size.

## Runtime limits and feature availability

Eight Pine workers can execute concurrently across a page. Hidden scripts stop
computing. Hard execution deadlines terminate a busy worker and leave the chart
usable. Chart teardown, cancellation and errors release worker resources.
The local adapter uses acknowledged static calculations and coalesces live and
replay updates, so a context read can identify the data that produced it. A
changing forming candle still recomputes. Sustained high-frequency live-stream
performance has not been benchmarked; this app uses cached replay.
The host reuses the official worker transport without downloading an unused
in-process runtime or an additional inline copy of the compiler. Compilation
permission is confined to the same-origin worker, whose network access is denied.
The main page permits no evaluation of source code.

All native chart styles, studies, drawing tools, custom supported timeframes,
up to sixteen layout cells, synchronization, renderer choices and animation
settings remain available. Templates save indicator sets, appearance and layouts.
AI tools can edit source and inspect bounded context through the local MCP.

Two upstream addon limitations remain visible: account snapshots expose final
equity rather than a full historical account-equity curve, and secondary-symbol
`syminfo` may use upstream defaults. The latter emits a warning retained with saved
backtests. Main-instrument futures metadata is supplied explicitly. Derived
closed-trade drawdown is never labeled as full intrabar account drawdown.

The upstream `ticker.renko`, `ticker.kagi`, `ticker.linebreak` and
`ticker.pointfigure` helpers currently return the unmodified symbol. Calling them
emits a visible warning, retained with the run; they do not create synthetic bars.
This limitation is separate from the native chart's supported display styles.

Manual simulation fixes apply to subsequent fills. Existing saved fill ledgers
and earlier recorded metrics are preserved. Use Fresh attempt to evaluate a whole
manual replay with the current execution and prop-risk calculations.

The hosted LuxAlgo application also offers private services and data-dependent
plugins that are not present in the open-source chart repository. Quant hosting,
protected paid studies, cloud sharing and external news/calendar feeds need their
own integrations. True footprint/aggressor delta requires trade-level data that
minute OHLCV does not contain. These are not hidden switches in the local app;
no nonfunctional controls or fabricated order-flow data are supplied.

Official references: [scripting engines](https://docs.luxalgo.com/vela/user/scripting-engines),
[Pine editor](https://docs.luxalgo.com/platform/charts/pine-editor),
[strategies](https://docs.luxalgo.com/platform/charts/strategies).
