# Local Edge Stats source package

This private package exposes a dependency closure
of the official MIT-licensed `@luxalgo/edge-stats` core 0.1.0 at commit
`a48259887962d0f67a27d2b0815e2df9a52efca5` from
<https://github.com/LuxAlgo/edge-stats>.

The 29 TypeScript files under `src/`, 42 JSON files under `presets/`, six calendar
JSON files under `data/`, `LICENSE` and `DATA_LICENSE` are byte-for-byte upstream
copies. `provenance.json` records the exact upstream URLs, byte sizes and SHA-256
hashes. The repository's package is not published on npm, so the application uses
this local `file:` package rather than an unrelated substitute.

The source-hash check runs offline. To refresh it, fetch each recorded URL at the
exact commit and compare its bytes before replacing a source or hash. Do not run
a formatter over `src/`; formatting changes would break the upstream checksum.
The local `.gitattributes` preserves those bytes across Windows checkouts.

`index.ts` is a local wrapper over existing upstream public exports. It preserves
their implementation and signatures. Adapters, network sync, live board/sinks
and trade ingestion remain excluded. No `dukascopy-node` or `fflate` dependency is
needed by this closure.
Do not import internal source files from application code.

The public local subpath `@luxalgo/edge-stats/registry` exposes the unchanged
registry catalog without importing the Store or DuckDB. Use it for the server's
catalog response; importing the main entry also exposes the native Store API.

Native-free subpaths expose the unchanged `presets` composer/schema,
`query-tools` parser/compiler, `session-bars` inspection helper, `export` CSV and
Parquet helpers, `events` schema/local ingestion, and `live/types` and
`live/replay`. They accept an explicit Store when needed; importing them does not
load DuckDB. Export helpers write files only when called. Replay helpers read
local alerts. `live/board.ts` is excluded because its runtime imports pull in
network sync and external sinks; there is no upstream `computeLiveBoard` API.

`preset-catalog` statically imports all 42 original JSON presets, so a bundled
server needs no loose catalog files or runtime path discovery. The official
catalog's 121 variants count each preset once, each enum parameter value once,
and each enumerated default grouping value once. It is a structural count, not
121 standalone reports. Nine original presets have no Library references; no
citations are fabricated for them.

`calendar-data` statically imports the four original event compilations and the
CME/NYSE holiday profiles. Calendar data from Edge Stats by LuxAlgo
(github.com/LuxAlgo/edge-stats), unchanged at the pinned commit, is licensed under
CC BY 4.0: <https://creativecommons.org/licenses/by/4.0/>. `DATA_LICENSE` preserves
the original notice; `packaging.mjs` includes it in desktop legal notices. These
reference datasets are not automatically applied to queries. The application
must validate coverage and never treat absent event dates as known negatives.
CME's profile covers equity-index schedules, not every CME product: it must not
be silently applied to metals, energy or agriculture. A missing holiday calendar
remains schedule-only mode and must be disclosed by the application.

`packaging.mjs` is application-owned build support, not upstream engine code. It
copies the explicitly allowlisted Windows x64 DuckDB runtime closure beside the
server and worker bundles. Native files stay outside Electron's asar archive.
`native-runtime.json` enumerates each copied file, including package metadata and
licenses. The Linux-only `detect-libc` branch is not used by the pinned Windows
loader; no other native platform package or general `node_modules` tree is copied.
Dependencies are pinned; update provenance and native packaging verification
together when changing a version. The Node tests verify source hashes, module
closure, native resolution in an isolated runtime and Electron utility-process
loading when the local Electron binary is present.
