# Managed local runtime contract

The desktop launcher supports `run` and `develop`. Both use the existing external
application-data directory. Run serves a staged production client/backend on
127.0.0.1:5197; Develop serves Vite on 5198 with a separate backend on 5199.
Vite proxies trusted-origin API requests to 5199. Neither mode downloads market
data during startup or updates.

Backend ServerOptions gains `repositoryDirectory?: string` and
`runtime?: { mode: 'run' | 'develop'; version: string }`. Without runtime, existing
tests/manual entry points keep working. Managed direct entry reads VELA_PORT,
VELA_STATIC_DIRECTORY, VELA_REPOSITORY_DIRECTORY, VELA_RUNTIME_MODE and
VELA_RUNTIME_VERSION from the launcher. Runtime instanceId is random per process.

GET /api/runtime returns { managed, mode, version, instanceId, repositoryId, phase, updateId,
message }, where phase is 'ready' | 'preparing' | 'error'. The same strict Host,
Origin and response policy applies. POST /api/runtime/client uses the existing
X-Local-Token and accepts {clientId, action:'heartbeat'|'ready'|'release',updateId?}.
Shared interfaces live in shared/runtime.ts. repositoryId is SHA256 of the
resolved repository directory, lowercased on Windows, without exposing its path.
Client IDs are UUIDs. Normal leases are bounded (maximum64,20seconds). Prepare
freezes the current participants, including any new registrations during the
handoff. Every participant must acknowledge the same update or explicitly release;
silence cannot permit an update. Readiness also requires a one-second registration
grace. A ready acknowledgement counts as a heartbeat.

Supervisor IPC:
- parent -> backend {type:'runtime:prepare',updateId}
- backend -> parent {type:'runtime:ready',updateId}
- parent -> backend {type:'runtime:cancel',updateId,message?}
- parent -> backend {type:'runtime:shutdown',updateId?}; shutdown with an updateId
  is accepted only after readiness. Initial/manual clean shutdown omits updateId.
- backend -> parent {type:'runtime:stopping',updateId?} confirms shutdown acceptance;
  {type:'runtime:shutdown-refused',updateId} preserves the existing process when a
  new unsaved participant invalidates readiness. Update refusal never forces exit.
- backend -> parent {type:'runtime:listening',port,instanceId,version}

While preparing, mutation routes return503/UPDATE_PENDING except lifecycle calls
and session commands containing only layout/rename/bookmark. All client trading
and chart actions are disabled while saving/reconnecting; a command already
accepted remains durably saved. The client polls runtime each second, pauses,
drains commands, explicitly flushes the current chart snapshot, then acknowledges.
It remembers its selected session in sessionStorage, never credentials. A changed
instanceId first refreshes the write token and saves any remaining dirty chart
snapshot with its original revision before a full reload. Failure to save
does not acknowledge; launcher cancels the attempt after a bounded deadline and
keeps the working backend. Cancellation restores client controls, paused.

Vite automatic full reload/HMR for source changes is suppressed through a local
plugin. The supervisor owns reload timing. Vite's websocket remains available to
its client. Backend restart produces a new instanceId; the browser then reloads.

The supervisor watches bounded relevant source/config paths, debounces bursts,
serializes builds, hashes source to reject stale results, stages new output in
ignored local-app/.runtime/ and switches only successful builds. Run checks local
types before switching; Develop prioritizes fast builds. Failed builds retain the
current backend/UI and log a concise failure. A healthy managed instance of the
same mode can be reused. Unrelated listeners are never stopped or claimed.

Launcher files and generated runtime output must contain no provider credential.
Server calls remain in the backend. Runtime does not pull, merge, commit, publish,
download data, change billing, or install an Electron application.

## Installed desktop updates

The Electron application uses a separate fixed loopback origin on port 5196.
Its updater checks and downloads stable releases in the background. A completed
download never closes the workspace. Installation requires an explicit
**Restart to update** click or the corresponding File menu action; ordinary quit
does not install a waiting update.

The sandboxed main-frame bridge exposes update state, state subscriptions, check
and install requests. Main-process handlers authenticate the window, frame and
application origin. Both menu and renderer installation requests use the same
save acknowledgement and backend-exit barrier before launching the verified
installer. Save or installer failure keeps installation retryable. The Run and
Develop launchers retain their existing source-change handoff behavior.
