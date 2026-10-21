# Local chart MCP

Vela's chart engine already provides programmatic drawing, indicator, viewport
and market controls. This fork exposes those public controls to an external AI
application over a local stdio MCP connection. It does not run a model or use a
model API key. Your AI application's normal sign-in and usage apply.

## Connect

Use Node 24. The repository dependencies must be installed. Configure an MCP
server named `vela-local-chart` in your AI application, with these arguments
resolved to this checkout's absolute paths:

```json
{
  "command": "C:/Users/tomks/AppData/Local/Programs/node-v24.21.0-win-x64/node.exe",
  "args": [
    "--import",
    "file:///C:/Users/tomks/Desktop/CODEX/vela-local/node_modules/tsx/dist/loader.mjs",
    "C:/Users/tomks/Desktop/CODEX/vela-local/local-app/mcp.ts"
  ]
}
```

The loader file URL supports Windows ESM imports and makes launch independent of
the AI application's working directory. From this checkout, `npm run local:mcp` is equivalent for
console use. Protocol output occupies stdout; diagnostic output goes to stderr.

For Codex CLI, register this command with `codex mcp add vela-local-chart --`
followed by the command and arguments above, then start a new Codex session.
Other MCP hosts use their own MCP settings and reload procedure. Adding a
server does not inject it into a conversation that is already running.

Open Run Vela or Develop Vela and a saved session. `vela_workspaces` lists both
modes. Copy the exact window `clientId`, `sessionId`, `generation` and cell `id`
into the next tool's `target`. Keep playback paused. A changed or closed window
requires a new workspace lookup. The optional `VELA_AGENT_PORT` environment
variable selects only 5197 or 5199 instead of discovering both modes.

## Tools

| Tool | Capability |
| --- | --- |
| `vela_workspaces` | Discover live chart windows and their exact targets |
| `vela_read_chart` | Viewport, drawings, settings and formatted plot readout |
| `vela_read_candles` | Up to 1,000 revealed OHLCV candles at a supported resolution |
| `vela_set_timeframe` | Change one named cell through the replay loader |
| `vela_list_drawing_tools` | Native tool types and required anchor counts |
| `vela_add_drawing` / `vela_update_drawing` / `vela_remove_drawing` | Editable native drawings with validated anchors, text and styles |
| `vela_list_indicators` | Supported native studies, schemas, instances and readout |
| `vela_add_indicator` / `vela_update_indicator` / `vela_remove_indicator` | Study settings, properties, visibility and removal |
| `vela_run_script` / `vela_update_script` | Start a Pine compile/run job; update stages a replacement before removing the original |
| `vela_read_script_job` / `vela_cancel_script_job` | Inspect or cancel an explicitly targeted Pine job |
| `vela_read_script_context` | Bounded variables, numeric plot history, account state and strategy trades |
| `vela_read_indicator_context` | Completed numeric native or Pine output history with calculation identity |
| `vela_capture_analysis_scope` / `vela_read_analysis_scope` | Pin a viewport, explicit time range or drawing region to one historical clock |
| `vela_evaluate_analysis` / `vela_read_analysis_job` / `vela_cancel_analysis_job` | Compute unplotted Pine studies across resolutions without changing the chart |
| `vela_read_analysis_request` | Read a question and region prepared in the chart AI panel |
| `vela_read_session` / `vela_read_workspace` | Manual replay account, prop rules, costs and workspace context |
| `vela_list_scripts` / `vela_read_script` | Saved script metadata; source only on explicit request |
| `vela_list_templates` | Saved template metadata without source or arbitrary extensions |
| `vela_list_backtests` / `vela_read_backtest` / `vela_read_current_result` | Explicitly requested historical strategy reports, separate from blind replay |
| `vela_backtest_indicator` / `vela_read_backtest_job` / `vela_cancel_backtest_job` | Run an exact active-chart strategy through the shared tester and cancel only its own job |
| `vela_read_operation` | Reconcile an operation after timeout without repeating an edit |
| `vela_set_viewport` | Pan/zoom a time range or fit revealed history |
| `vela_screenshot` | Bounded image of the actual chart renderer |

Formatted readouts describe the hovered candle or latest loaded candle. Numeric
native series are separately available through `read_indicator_context`; opaque
renderer payloads and unacknowledged asynchronous output remain explicitly
unsupported or stale. Calculation identities must match the requested settings
and data before numeric context is returned. Pine source is
limited to 60,000 characters per AI request. Jobs have a 30-second deadline and
can be cancelled; inspect their saved status before treating a change as complete.
Successful source replacement returns a new indicator ID. Pending, failed and
cancelled replacement scripts are excluded from saved layouts. Script context
includes at most 1,000 plot points and 500 trades per request.

Epoch times use milliseconds. A higher-timeframe candle includes only
source bars already revealed, so the newest bucket may be incomplete.

The AI panel prepares a question for the visible chart or a drawing's bounds and
provides a prompt to copy into your connected AI. It starts no model request.
Scopes expire after five minutes and become stale when the captured chart,
session revision, cursor or timeframe changes. Up to eight scopes and two
detached calculations exist per window. Calculations stop after 30 seconds and
load at most 50,000 warmup bars. All primary and secondary series use the same
historical source-candle clock. The result states coverage, warmup, output names
and exact available dataset provenance. Strategy totals include warmup; regional
plot filtering does not recalculate a regional account.

Detached engines are disposed on completion, failure, cancellation or timeout.
The official worker can transfer selected full history arrays before the host
slices the bounded output; the warmup cap also bounds that intermediate work.

Default manual context includes only revealed session history. Saved backtest
and current-report tools explicitly expose historical library context, which can
include Deep results beyond replay. Keep those separate from blind analysis.
Source requires `includeSource`. Saved results are client-reported snapshots,
with typed validation and provenance, rather than execution-signed attestations.

Every bridge call has an operation ID. If it times out or disconnects, query
`vela_read_operation` with the original target before repeating an edit. Receipts
are retained in memory for five minutes, up to 64; missing receipts mean unknown.
An authenticated heartbeat keeps long saves and timeframe changes registered.

The local connection exposes chart operations only. Databento requests stay in
the backend; its key never enters the MCP context. Model-facing tool output
does not contain the bootstrap token, browser lease token or provider settings.
Chart edits use normal session persistence and report any save conflict.
