import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analytics, applyCommand, createSession, monteCarlo, validateSessionConfig, validateStoredSession } from '../engine/index';
import type { Command, DatasetMeta, Session, SessionView } from '../shared/types';
import type { BacktestSnapshot, SaveScriptInput } from '../shared/scripts';
import { INSTRUMENTS } from '../shared/types';
import { parseTimeframe, timeframeSupported } from '../shared/timeframes';
import { checksum, demoBars, instrumentFor, interval, MAX_DATA_BYTES, parseImport, validateBars } from './data';
import { AppError, requireObject, text } from './errors';
import { DatabentoProvider } from './provider';
import type { FetchFunction } from './provider';
import { loadDatabentoKey, saveDatabentoKey } from './secrets';
import { ReplayStore } from './store';
import { RuntimeCoordinator, validateRuntime } from './runtime';
import type { ManagedRuntimeOptions } from '../shared/runtime';
import { ChartAgentBroker } from './chart-agent';
import { cachedSeries, cachedSymbolInfo } from './cached-series';
import { parseCachedTicker, transformCachedBars } from './series-ticker';
import { SCRIPT_LIBRARY_LIMITS, ScriptLibrary } from './scripts';
import { DeepHistoryService, validateDeepHistory } from './deep-history';
import { appearanceModule } from './appearance';
import { validateExecutionVersion } from '../engine/validation';
import { MarketStatsController } from './stats-api';
import { createMarketStatsService, createNodeMarketStatsJobFactory } from './market-stats';
import { MarketStatsError } from './market-stats';
import { buildPreset, getStatsPresetCatalog } from './stats-presets';
import { createStatsArtifactService, artifactOperation } from './market-stats/artifacts';
import { createNodeStatsArtifactJobFactory } from './market-stats/node-job';
import { eventCalendars } from '@luxalgo/edge-stats/calendar-data';
import { createHistoryController } from './history';
import type { HistoryController } from './history-types';

export { ReplayStore, saveDatabentoKey };
const HERE = dirname(fileURLToPath(import.meta.url));
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const PINE_WORKER_CSP = "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'; object-src 'none'; base-uri 'none'";
export interface ServerOptions { dataDirectory?: string; staticDirectory?: string; repositoryDirectory?: string; port?: number; fetch?: FetchFunction; apiKey?: string; runtime?: ManagedRuntimeOptions }
export function defaultDataDirectory(): string {
    const base = process.env.LOCALAPPDATA ?? (process.platform === 'win32' ? undefined : join(process.env.HOME ?? '', '.local', 'share'));
    if (!base) throw new AppError(500, 'The local application-data directory is unavailable.');
    return process.env.VELA_DATA_DIR ?? join(base, 'VelaReplayStudio');
}
function assertSafeContent(input: unknown, credential?: string, depth = 0, budget = { nodes: 0 }): void {
    if (++budget.nodes > 2_000_000 || depth > 32) throw new AppError(400, 'Saved content is too complex.');
    if (typeof input === 'number' && !Number.isFinite(input)) throw new AppError(400, 'Numbers must be finite.');
    if (typeof input === 'string' && credential && input.includes(credential)) throw new AppError(400, 'Saved content must not contain a provider credential.');
    if (input && typeof input === 'object') {
        for (const [key, value] of Object.entries(input)) {
            if (/^(?:api[_-]?key|authorization|password|secret|token|credentials?)$/i.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') throw new AppError(400, 'Saved content contains a disallowed field.');
            assertSafeContent(value, credential, depth + 1, budget);
        }
    }
}
async function body(request: IncomingMessage, max: number): Promise<unknown> {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new AppError(415, 'Use application/json.');
    const declared = request.headers['content-length'];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > max)) throw new AppError(413, 'Request body is too large.');
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += buffer.length;
        if (length > max) throw new AppError(413, 'Request body is too large.');
        chunks.push(buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); } catch { throw new AppError(400, 'Invalid JSON.'); }
}
function integer(input: unknown, min: number, max: number, label: string): number {
    const value = typeof input === 'string' && /^\d+$/.test(input) ? Number(input) : input;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new AppError(400, `Invalid ${label}.`);
    return value;
}
function cloneState(original: Session, datasetId: string, name?: string): Session {
    const session = structuredClone(original); const ids = new Map<string, string>();
    const newId = (old: string) => { if (!ids.has(old)) ids.set(old, randomUUID()); return ids.get(old)!; };
    session.id = randomUUID(); session.config.datasetId = datasetId;
    if (name !== undefined) session.config.name = text(name, 'session name');
    for (const order of session.orders) order.id = newId(order.id);
    for (const fill of session.fills) { fill.id = newId(fill.id); fill.orderId = newId(fill.orderId); }
    for (const trade of session.trades) trade.id = newId(trade.id);
    for (const mark of session.bookmarks) mark.id = newId(mark.id);
    session.revision = 0; session.createdAt = session.updatedAt = new Date().toISOString(); return session;
}
export async function createReplayServer(options: ServerOptions = {}) {
    const dataDirectory = resolve(options.dataDirectory ?? defaultDataDirectory());
    const repository = resolve(options.repositoryDirectory ?? resolve(HERE, '..', '..')); const inRepo = relative(repository, dataDirectory);
    // Dataset and credential state must never enter the checkout or its backups.
    if (inRepo === '' || (!inRepo.startsWith(`..${sep}`) && inRepo !== '..' && !isAbsolute(inRepo))) throw new AppError(500, 'Choose a data directory outside the repository.');
    if (options.runtime) validateRuntime(options.runtime);
    const store = new ReplayStore(dataDirectory);
    const scripts = new ScriptLibrary(store.db);
    const deepHistory = new DeepHistoryService(store);
    const sourceEntry = fileURLToPath(import.meta.url).endsWith('.ts');
    let statsJobFactory: ReturnType<typeof createNodeMarketStatsJobFactory> | undefined;
    let artifactJobFactory: ReturnType<typeof createNodeStatsArtifactJobFactory> | undefined;
    const artifactService = createStatsArtifactService((input, operation) => (artifactJobFactory ??= createNodeStatsArtifactJobFactory({
        workerUrl: new URL(sourceEntry ? './market-stats/worker.ts' : './market-stats-worker.mjs', import.meta.url),
        scratchDirectory: join(dataDirectory, 'market-stats-jobs'), execArgv: sourceEntry ? ['--import', import.meta.resolve('tsx')] : [],
    }))(input, operation));
    const marketStats = new MarketStatsController(store, createMarketStatsService({ startJob: input => (statsJobFactory ??= createNodeMarketStatsJobFactory({
        workerUrl: new URL(sourceEntry ? './market-stats/worker.ts' : './market-stats-worker.mjs', import.meta.url),
        scratchDirectory: join(dataDirectory, 'market-stats-jobs'),
        execArgv: sourceEntry ? ['--import', import.meta.resolve('tsx')] : [],
    }))(input) }), artifactService);
    let apiKey: string | undefined;
    try { apiKey = options.apiKey ?? await loadDatabentoKey(dataDirectory); } catch (error) { store.close(); throw error; }
    let history: HistoryController | undefined;
    let historyImportActive = false;
    const token = randomBytes(32).toString('hex');
    const chartAgent = new ChartAgentBroker();
    const provider = new DatabentoProvider(store, () => apiKey, options.fetch);
    const staticDirectory = resolve(options.staticDirectory ?? join(HERE, '..', 'dist'));
    const view = (session: Session): SessionView => ({ session, dataset: store.dataset(session.config.datasetId) });
    let inFlight = 0; let activeWrites = 0; let closing = false; let closePromise: Promise<void> | undefined;
    const runtime = new RuntimeCoordinator(options.runtime, repository, undefined, Date.now, () => activeWrites === 0);
    const requests = new Set<Promise<void>>();
    const server = createServer((request, response) => {
        const task = handle(request, response).catch(error => {
            if (response.headersSent) { response.end(); return; }
            const known = error instanceof AppError;
            send(response, known ? error.status : 400, { error: known ? error.message : 'Unable to process this request. Check the supplied values.', ...(known ? { code: error.code } : {}) });
        }).finally(() => { requests.delete(task); });
        requests.add(task);
    });
    server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 50;
    function send(response: ServerResponse, status: number, value: unknown): void {
        sendSerialized(response, status, JSON.stringify(value));
    }
    function sendSerialized(response: ServerResponse, status: number, serialized: string): void {
        let output = serialized;
        if (apiKey && output.includes(apiKey)) { output = JSON.stringify({ error: 'Response blocked because it contains a credential.' }); status = 500; }
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(output);
    }
    async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        response.setHeader('Content-Security-Policy', CSP); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); response.setHeader('X-Frame-Options', 'DENY');
        const address = server.address(); const port = address && typeof address === 'object' ? address.port : options.port ?? 5197;
        const host = `127.0.0.1:${port}`;
        if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'Untrusted local request.', 'LOCAL_ONLY');
        if (++inFlight > 16) { inFlight--; throw new AppError(429, 'Too many concurrent requests.'); }
        let writing = false;
        try {
            const raw = request.url ?? '/';
            if (!raw.startsWith('/') || /[\\\u0000-\u0020]/.test(raw) || /%(?:2e|2f|5c|00)/i.test(raw) || raw.split('?')[0]!.split('/').some(part => part === '.' || part === '..')) throw new AppError(400, 'Invalid request path.');
            const url = new URL(raw, `http://${host}`); const path = url.pathname; const method = request.method;
            if (!['GET', 'POST'].includes(method ?? '')) throw new AppError(405, 'Method not allowed.');
            if (method === 'POST') {
                const supplied = request.headers['x-local-token'];
                if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new AppError(403, 'Missing local write token.', 'CSRF');
                if (closing) throw new AppError(503, 'The local application is restarting.', 'UPDATE_PENDING');
                if (historyImportActive && path !== '/api/runtime/client' && !/^\/api\/history\/history-[a-f0-9]{24}\/cancel$/.test(path)) throw new AppError(409, 'History import is finishing. Other changes can resume after it completes or is cancelled.', 'HISTORY_IMPORT_ACTIVE');
                if (path !== '/api/runtime/client') {
                    if (runtime.preparing && path !== '/api/backtests' && !/^\/api\/deep-history\/[a-f0-9-]{36}\/release$/.test(path) && !/^\/api\/sessions\/[a-f0-9-]{36}\/command$/.test(path)) throw new AppError(503, 'The application is preparing an update. Try again after it reconnects.', 'UPDATE_PENDING');
                    activeWrites++; writing = true;
                }
            }
            if (method === 'GET' && path === '/api/runtime') { send(response, 200, runtime.status()); return; }
            if (method === 'POST' && path === '/api/runtime/client') { send(response, 200, runtime.client(await body(request, 1024))); return; }
            if (method === 'GET' && path === '/api/assistant/clients') { send(response, 200, chartAgent.list()); return; }
            if (method === 'POST' && path === '/api/assistant/exchange') {
                const input = await body(request, 2_000_000); assertSafeContent(input, apiKey);
                send(response, 200, chartAgent.exchange(input)); return;
            }
            if (method === 'POST' && path === '/api/assistant/call') {
                const input = await body(request, 70_000); assertSafeContent(input, apiKey);
                send(response, 200, await chartAgent.call(input)); return;
            }
            if (method === 'GET' && path === '/api/bootstrap') { send(response, 200, { token, datasets: store.listDatasets(), sessions: store.sessions(), provider: { configured: !!apiKey }, instruments: INSTRUMENTS, dataDirectory }); return; }
            if (method === 'GET' && path === '/api/datasets') { send(response, 200, store.listDatasets()); return; }
            if (method === 'GET' && path === '/api/sessions') { send(response, 200, store.sessions()); return; }
            const historyMatch = /^\/api\/history(?:\/(history-[a-f0-9]{24})(?:\/(run|cancel|import))?)?$/.exec(path);
            if (historyMatch) {
                if ([...url.searchParams.keys()].length) throw new AppError(400, 'History operations do not accept URL parameters.');
                history ??= createHistoryController({ stagingDirectory: join(dataDirectory, 'history-staging'), key: () => apiKey, fetch: options.fetch });
                const id = historyMatch[1]; const operation = historyMatch[2];
                if (method === 'GET' && !operation) { send(response, 200, id ? history.status(id) : history.list()); return; }
                if (method !== 'POST') throw new AppError(405, 'Method not allowed.');
                const input = requireObject(await body(request, 4096)); assertSafeContent(input, apiKey);
                if (!id) { send(response, 201, history.plan(input)); return; }
                if (!operation) throw new AppError(405, 'Method not allowed.');
                if (operation === 'import') {
                    if (Object.keys(input).length !== 1 || !['NQ.v.0', 'GC.v.0'].includes(String(input.symbol))) throw new AppError(400, 'Choose one supported staged continuous contract.');
                    if (activeWrites > 1) throw new AppError(409, 'Wait for other local changes before importing history.', 'HISTORY_IMPORT_ACTIVE');
                } else if (Object.keys(input).length) throw new AppError(400, 'History run and cancel take an empty object.');
                if (operation === 'cancel') { history.cancel(id); send(response, 200, { cancelled: true }); return; }
                const controller = new AbortController();
                const abort = () => controller.abort(); const disconnect = () => { if (!response.writableEnded) controller.abort(); };
                request.once('aborted', abort); response.once('close', disconnect);
                try {
                    if (operation === 'import') historyImportActive = true;
                    const result = operation === 'run' ? await history.run(id, { signal: controller.signal })
                        : await history.importDataset(store, id, input.symbol as 'NQ.v.0' | 'GC.v.0', { signal: controller.signal });
                    if (!response.destroyed) send(response, 200, result);
                } finally {
                    if (operation === 'import') historyImportActive = false;
                    request.off('aborted', abort); response.off('close', disconnect);
                }
                return;
            }
            if (method === 'GET' && path === '/api/market-stats') { send(response, 200, marketStats.catalog()); return; }
            if (path === '/api/market-stats/presets' || path === '/api/market-stats/preset') {
                if (method === 'GET' && path.endsWith('/presets')) {
                    if ([...url.searchParams.keys()].some(key => key !== 'events') || url.searchParams.getAll('events').length > 1 || url.searchParams.has('events') && url.searchParams.get('events') !== 'bundled') throw new AppError(400, 'Invalid statistics event calendar.');
                    send(response, 200, getStatsPresetCatalog(url.searchParams.has('events') ? { events: eventCalendars } : {})); return;
                }
                if ([...url.searchParams.keys()].length) throw new AppError(400, 'Statistics templates do not accept URL parameters.');
                if (method !== 'POST' || !path.endsWith('/preset')) throw new AppError(405, 'Method not allowed.');
                const input = requireObject(await body(request, 4096)); assertSafeContent(input, apiKey);
                const { eventCalendar, ...preset } = input;
                if (eventCalendar !== undefined && eventCalendar !== 'bundled') throw new AppError(400, 'Invalid statistics event calendar.');
                try { send(response, 200, buildPreset(preset, eventCalendar === 'bundled' ? { events: eventCalendars } : {})); }
                catch (error) { if (error instanceof MarketStatsError) throw new AppError(400, error.message, error.code); throw error; }
                return;
            }
            if (method === 'POST' && ['/api/market-stats/query', '/api/market-stats/session', '/api/market-stats/export'].includes(path)) {
                if ([...url.searchParams.keys()].length) throw new AppError(400, 'Statistics queries do not accept URL parameters.');
                const input = await body(request, 200_000); assertSafeContent(input, apiKey);
                const controller = new AbortController();
                const abort = () => controller.abort();
                const disconnect = () => { if (!response.writableEnded) controller.abort(); };
                request.once('aborted', abort); response.once('close', disconnect);
                try {
                    let result: unknown;
                    if (path.endsWith('/query')) result = await marketStats.run(input, controller.signal);
                    else {
                        const item = requireObject(input);
                        const allowed = path.endsWith('/session') ? ['request', 'sessionId', 'contextBars'] : ['request', 'format'];
                        if (Object.keys(item).some(key => !allowed.includes(key))) throw new AppError(400, 'Unknown statistics artifact parameter.');
                        const operation = path.endsWith('/session') ? { kind: 'session', sessionId: item.sessionId, contextBars: item.contextBars ?? 30 }
                            : { kind: 'export', format: item.format };
                        try { result = await marketStats.artifact(item.request, artifactOperation(operation), controller.signal); }
                        catch (error) { if (error instanceof MarketStatsError) throw new AppError(400, error.message, error.code); throw error; }
                    }
                    if (!response.destroyed) send(response, 200, result);
                } finally { request.off('aborted', abort); response.off('close', disconnect); }
                return;
            }
            const deepMatch = /^\/api\/deep-history(?:\/([a-f0-9-]{36})\/(series|release))?$/.exec(path);
            if (method === 'POST' && deepMatch) {
                if ([...url.searchParams.keys()].length) throw new AppError(400, 'Deep history operations do not accept query parameters.');
                const input = requireObject(await body(request, 4096)); assertSafeContent(input, apiKey);
                if (deepMatch[2] === 'release') {
                    if (Object.keys(input).length) throw new AppError(400, 'Deep history release takes an empty object.');
                    deepHistory.release(deepMatch[1]!); send(response, 200, { released: true }); return;
                }
                const controller = new AbortController();
                const abort = () => controller.abort();
                const disconnect = () => { if (!response.writableEnded) controller.abort(); };
                request.once('aborted', abort); response.once('close', disconnect);
                try {
                    const serialized = deepMatch[2] === 'series' ? await deepHistory.series(deepMatch[1]!, input, controller.signal) : await deepHistory.load(input, controller.signal);
                    if (!response.destroyed) sendSerialized(response, 200, serialized);
                } finally { request.off('aborted', abort); response.off('close', disconnect); }
                return;
            }
            if (path === '/api/scripts') {
                if (method === 'GET') {
                    if ([...url.searchParams.keys()].some(key => key !== 'includeArchived') || url.searchParams.getAll('includeArchived').length > 1 || (url.searchParams.has('includeArchived') && !['true', 'false'].includes(url.searchParams.get('includeArchived')!))) throw new AppError(400, 'Invalid script library filter.');
                    send(response, 200, scripts.list({ includeArchived: url.searchParams.get('includeArchived') === 'true' })); return;
                }
                if ([...url.searchParams.keys()].length) throw new AppError(400, 'Script saves do not accept query parameters.');
                const input = await body(request, 2 * 1024 * 1024); assertSafeContent(input, apiKey);
                send(response, 200, scripts.save(input as SaveScriptInput)); return;
            }
            const scriptMatch = /^\/api\/scripts\/([a-f0-9-]{36})(?:\/(versions|archive|restore|clone)(?:\/([1-9][0-9]*))?)?$/.exec(path);
            if (scriptMatch) {
                const scriptId = scriptMatch[1]!; const action = scriptMatch[2]; const savedVersion = scriptMatch[3];
                if ([...url.searchParams.keys()].length) throw new AppError(400, 'This script operation does not accept query parameters.');
                if (method === 'GET' && !action) { send(response, 200, scripts.get(scriptId)); return; }
                if (method === 'GET' && action === 'versions') { send(response, 200, savedVersion === undefined ? scripts.versions(scriptId) : scripts.version(scriptId, integer(savedVersion, 1, 50, 'script version'))); return; }
                if (method === 'POST' && savedVersion === undefined && ['archive', 'restore', 'clone'].includes(action ?? '')) {
                    const input = requireObject(await body(request, 4096)); assertSafeContent(input, apiKey);
                    if (action === 'clone') {
                        if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'name')) throw new AppError(400, 'Supply only the cloned script name.');
                        send(response, 200, scripts.clone(scriptId, text(input.name, 'script name'))); return;
                    }
                    if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'expectedRevision')) throw new AppError(400, 'Supply only the expected script revision.');
                    const expected = integer(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expected revision');
                    send(response, 200, action === 'archive' ? scripts.archive(scriptId, expected) : scripts.restore(scriptId, expected)); return;
                }
            }
            if (path === '/api/backtests') {
                if (method === 'GET') {
                    if ([...url.searchParams.keys()].some(key => key !== 'strategyId') || url.searchParams.getAll('strategyId').length > 1) throw new AppError(400, 'Invalid saved strategy result filter.');
                    send(response, 200, scripts.listRuns(url.searchParams.get('strategyId') ?? undefined)); return;
                }
                if ([...url.searchParams.keys()].length) throw new AppError(400, 'Saved strategy results do not accept query parameters.');
                const input = requireObject(await body(request, SCRIPT_LIBRARY_LIMITS.runBytes + 4096)); assertSafeContent(input, apiKey);
                if (Object.keys(input).some(key => !['name', 'snapshot'].includes(key)) || !Object.hasOwn(input, 'name') || !Object.hasOwn(input, 'snapshot')) throw new AppError(400, 'Supply the strategy result name and snapshot.');
                const snapshot = requireObject(input.snapshot) as unknown as BacktestSnapshot;
                const dataset = store.dataset(text(snapshot.datasetId, 'dataset id', 80));
                if (snapshot.datasetChecksum !== dataset.checksum || snapshot.symbol !== dataset.symbol) throw new AppError(400, 'Strategy data metadata does not match the cached dataset.');
                if (!timeframeSupported(snapshot.timeframe, dataset.schema)) throw new AppError(400, 'Strategy timeframe is not supported by the cached source data.');
                if (snapshot.history !== undefined) validateDeepHistory(snapshot.history, dataset, store.listDatasets());
                send(response, 200, scripts.saveRun(snapshot, text(input.name, 'strategy result name'))); return;
            }
            const backtestMatch = /^\/api\/backtests\/([a-f0-9-]{36})$/.exec(path);
            if (method === 'GET' && backtestMatch) {
                if ([...url.searchParams.keys()].length) throw new AppError(400, 'Saved strategy results do not accept query parameters.');
                send(response, 200, scripts.getRun(backtestMatch[1]!)); return;
            }
            if (method === 'POST' && path === '/api/provider/settings') {
                const input = requireObject(await body(request, 1024));
                if (typeof input.apiKey !== 'string' || Object.keys(input).length !== 1) throw new AppError(400, 'Supply only a provider key.');
                await saveDatabentoKey(dataDirectory, input.apiKey); apiKey = input.apiKey; send(response, 200, { configured: true }); return;
            }
            if (method === 'POST' && path === '/api/provider/quote') { send(response, 200, await provider.quote(await body(request, 4096))); return; }
            if (method === 'POST' && path === '/api/provider/download') {
                const input = requireObject(await body(request, 1024));
                if (Object.keys(input).length !== 1) throw new AppError(400, 'Supply only the quote ID.');
                send(response, 200, await provider.download(input.quoteId)); return;
            }
            if (method === 'POST' && path === '/api/datasets/demo') {
                await body(request, 1024);
                send(response, 200, store.addDataset({ name: 'Synthetic demo - deterministic', symbol: 'NQH4', schema: 'ohlcv-1m', source: 'demo', bars: demoBars() })); return;
            }
            if (method === 'POST' && path === '/api/datasets/import') {
                const input = requireObject(await body(request, MAX_DATA_BYTES + 1024 * 1024));
                assertSafeContent({ name: input.name, symbol: input.symbol, schema: input.schema, format: input.format }, apiKey);
                if (typeof input.text === 'string' && apiKey && input.text.includes(apiKey)) throw new AppError(400, 'Import must not contain a provider credential.');
                const imported = parseImport(input); send(response, 200, store.addDataset({ ...imported, source: 'csv' })); return;
            }
            if (method === 'POST' && path === '/api/sessions/import') {
                const input = requireObject(await body(request, 64 * 1024 * 1024));
                if ((input.version !== 1 && input.version !== 2) || Object.keys(input).some(key => !['version', 'session', 'dataset', 'bars'].includes(key))) throw new AppError(400, 'Unsupported session backup.');
                if (validateExecutionVersion(input.session) !== input.version) throw new AppError(400, 'Session backup version does not match its execution data.');
                const rawMeta = requireObject(input.dataset);
                if (rawMeta.continuous !== undefined) throw new AppError(400, 'Continuous-history sessions require their verified staged source; legacy backups cannot restore contract identity.', 'HISTORY_BACKUP_UNSUPPORTED');
                const symbol = text(rawMeta.symbol, 'symbol', 16); const inst = instrumentFor(symbol); interval(rawMeta.schema);
                assertSafeContent(rawMeta, apiKey);
                if (!['databento', 'csv', 'demo'].includes(String(rawMeta.source))) throw new AppError(400, 'Invalid dataset source.');
                const schema = rawMeta.schema as DatasetMeta['schema']; const bars = validateBars(input.bars, schema, symbol);
                if (rawMeta.checksum !== checksum(bars) || rawMeta.barCount !== bars.length) throw new AppError(400, 'Backup dataset checksum or bar count does not match.');
                assertSafeContent(input.session, apiKey);
                const validated = validateStoredSession(input.session, bars, inst);
                const dataset = store.addDataset({ name: text(rawMeta.name, 'dataset name'), symbol, schema, source: rawMeta.source as DatasetMeta['source'], bars });
                send(response, 200, view(store.createSession(cloneState(validated, dataset.id)))); return;
            }
            if (method === 'POST' && path === '/api/sessions') {
                const input = await body(request, 32_768); assertSafeContent(input, apiKey);
                const rawConfig = requireObject(input); const dataset = store.dataset(text(rawConfig.datasetId, 'dataset ID', 80));
                let resolvedConfig = rawConfig;
                if (Object.hasOwn(rawConfig, 'startTime')) {
                    if (Object.hasOwn(rawConfig, 'startIndex')) throw new AppError(400, 'Supply either a replay start date and time or a start index, not both.');
                    const { startTime, ...remaining } = rawConfig;
                    resolvedConfig = { ...remaining, startIndex: store.resolveTime(dataset.id, startTime).index };
                }
                if (Object.hasOwn(rawConfig, 'endTime')) {
                    if (Object.hasOwn(rawConfig, 'endIndex')) throw new AppError(400, 'Supply either a replay end date and time or an end index, not both.');
                    const { endTime, ...remaining } = resolvedConfig;
                    resolvedConfig = { ...remaining, endIndex: store.resolveEndTime(dataset.id, endTime) };
                }
                const config = validateSessionConfig(resolvedConfig, dataset.barCount); send(response, 200, view(store.createSession(createSession(config, dataset.instrument)))); return;
            }
            const match = /^\/api\/sessions\/([a-f0-9-]{36})(?:\/(command|clone|chart|series|analytics|monte-carlo|export|navigation))?$/.exec(path);
            if (match) {
                const session = store.session(match[1]!); const action = match[2];
                if (method === 'GET' && !action) { send(response, 200, view(session)); return; }
                if (method === 'GET' && action === 'navigation') {
                    if (url.searchParams.getAll('time').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'time')) throw new AppError(400, 'Supply only one replay target time.');
                    const time = integer(url.searchParams.get('time'), 0, 8_640_000_000_000_000, 'target time');
                    send(response, 200, store.navigation(session, time)); return;
                }
                if (method === 'GET' && action === 'analytics') { send(response, 200, analytics(session)); return; }
                if (method === 'POST' && action === 'monte-carlo') { const input = requireObject(await body(request, 4096)); assertSafeContent(input, apiKey); send(response, 200, monteCarlo(session, input)); return; }
                if (method === 'GET' && action === 'export') {
                    const dataset = store.dataset(session.config.datasetId);
                    if (dataset.barCount > 250_000 || dataset.continuous) throw new AppError(413, 'Legacy session backups support up to 250,000 exact-contract bars. Your continuous history remains saved locally with its verified source manifests.', 'HISTORY_EXPORT_TOO_LARGE');
                    response.setHeader('Content-Disposition', 'attachment; filename="replay-session.json"'); send(response, 200, { version: validateExecutionVersion(session), session, dataset, bars: store.readBars(session.config.datasetId) }); return;
                }
                if (method === 'GET' && (action === 'chart' || action === 'series')) {
                    const dataset = store.dataset(session.config.datasetId);
                    const endIndex = session.config.endIndex ?? dataset.barCount;
                    let maximumCursor = integer(session.cursor, -1, endIndex - 1, 'saved source cursor');
                    const rawSnapshot = url.searchParams.get('snapshot');
                    if (rawSnapshot !== null) {
                        if (rawSnapshot.length > 1024 || url.searchParams.getAll('snapshot').length !== 1) throw new AppError(400, 'Invalid replay snapshot.');
                        const snapshot = requireObject(JSON.parse(rawSnapshot));
                        if (Object.keys(snapshot).length !== 4 || Object.keys(snapshot).some(key => !['cursor', 'revision', 'datasetId', 'checksum'].includes(key))) throw new AppError(400, 'Invalid replay snapshot.');
                        const cursor = integer(snapshot.cursor, -1, endIndex - 1, 'snapshot cursor');
                        const revision = integer(snapshot.revision, 0, Number.MAX_SAFE_INTEGER, 'snapshot revision');
                        if (snapshot.datasetId !== dataset.id || snapshot.checksum !== dataset.checksum || revision > session.revision
                            || revision === session.revision && cursor !== session.cursor) throw new AppError(409, 'Replay snapshot changed. Reload the session before continuing.', 'SNAPSHOT_CONFLICT');
                        if (cursor > maximumCursor) throw new AppError(400, 'Replay snapshot cannot advance beyond the saved replay cursor.');
                        // Older financial views may still read their immutable source prefix.
                        maximumCursor = cursor;
                    }
                    if (action === 'chart') {
                        const allowed = ['timeframe', 'limit', 'after', 'snapshot'];
                        if ([...url.searchParams.keys()].some(key => !allowed.includes(key)) || allowed.some(key => url.searchParams.getAll(key).length > 1)) throw new AppError(400, 'Invalid chart query.');
                        const timeframe = url.searchParams.get('timeframe') ?? '1m'; const period = parseTimeframe(timeframe);
                        if (!period || !timeframeSupported(timeframe, dataset.schema)) throw new AppError(400, 'Timeframe cannot be finer than the source data.');
                        const limit = integer(url.searchParams.get('limit') ?? '5000', 1, 5000, 'chart limit');
                        const rawAfter = url.searchParams.get('after'); const after = rawAfter === null ? undefined : integer(rawAfter, 0, 8_640_000_000_000_000, 'chart cursor');
                        send(response, 200, store.chart(dataset.id, maximumCursor, timeframe, period, limit, after)); return;
                    }
                    const allowed = ['timeframe', 'cursor', 'cutoff', 'from', 'to', 'limit', 'symbol', 'snapshot'];
                    if ([...url.searchParams.keys()].some(key => !allowed.includes(key)) || allowed.some(key => url.searchParams.getAll(key).length > 1) || url.searchParams.has('cursor') === url.searchParams.has('cutoff')) throw new AppError(400, 'Supply either one pinned replay cursor or a source cutoff, and supported series options.');
                    const timeframe = url.searchParams.get('timeframe') ?? '1'; const period = parseTimeframe(timeframe);
                    const requestedSymbol = url.searchParams.get('symbol') ?? dataset.symbol;
                    const ticker = parseCachedTicker(requestedSymbol);
                    const primary = ticker.symbol === dataset.symbol;
                    if (!period) throw new AppError(400, 'Invalid script timeframe.');
                    const rawCursor = url.searchParams.get('cursor');
                    const cursor = url.searchParams.has('cutoff') ? store.pinnedCursor(dataset.id, maximumCursor, integer(url.searchParams.get('cutoff'), 0, 8_640_000_000_000_000, 'source cutoff')) : rawCursor === '-1' ? -1 : integer(rawCursor, 0, dataset.barCount - 1, 'source cursor');
                    if (cursor > maximumCursor) throw new AppError(400, 'Script data cannot advance beyond the replay snapshot cursor.');
                    const limit = integer(url.searchParams.get('limit') ?? '250000', 1, 250000, 'series limit');
                    const from = url.searchParams.has('from') ? integer(url.searchParams.get('from'), 0, 8_640_000_000_000_000, 'series start') : undefined;
                    const to = url.searchParams.has('to') ? integer(url.searchParams.get('to'), 0, 8_640_000_000_000_000, 'series end') : undefined;
                    if (from !== undefined && to !== undefined && from > to) throw new AppError(400, 'Invalid series date bounds.');
                    if (!primary || !timeframeSupported(timeframe, dataset.schema)) {
                        const current = store.db.prepare('SELECT time FROM bars WHERE dataset_id=? AND idx=?').get(dataset.id, cursor) as { time: number } | undefined;
                        if (!current) throw new AppError(400, 'Reveal a source candle before requesting another cached contract.');
                        send(response, 200, cachedSeries(store, { symbol: requestedSymbol, timeframe, cutoff: current.time, sourceIntervalMs: dataset.intervalMs, from, to, limit })); return;
                    }
                    const bounded = from !== undefined || to !== undefined;
                    const chart = store.chart(dataset.id, cursor, timeframe, period, bounded || ticker.modifier ? 250000 : limit, ticker.modifier ? undefined : from);
                    const derived = transformCachedBars(chart.bars, ticker.modifier);
                    const window = derived.filter(bar => (from === undefined || bar.time >= from) && (to === undefined || bar.time <= to));
                    const bars = from === undefined ? window.slice(-limit) : window.slice(0, limit);
                    send(response, 200, { ...chart, bars, hasMore: chart.hasMore || window.length > limit, symbolInfo: cachedSymbolInfo(dataset),
                        datasetId: dataset.id, checksum: dataset.checksum, sourceDatasets: [{ id: dataset.id, checksum: dataset.checksum }] }); return;
                }
                if (method === 'POST' && action === 'clone') {
                    const input = requireObject(await body(request, 4096)); assertSafeContent(input, apiKey);
                    if (input.restart !== undefined && typeof input.restart !== 'boolean') throw new AppError(400, 'Invalid restart option.');
                    const dataset = store.dataset(session.config.datasetId);
                    let next: Session;
                    if (input.restart === true) {
                        const config = { ...session.config, name: input.name === undefined ? `${session.config.name} restart` : text(input.name, 'name'), startIndex: input.startIndex === undefined ? session.config.startIndex : integer(input.startIndex, 0, dataset.barCount - 1, 'start index') };
                        next = createSession(validateSessionConfig(config, dataset.barCount), dataset.instrument);
                    } else {
                        if (input.startIndex !== undefined) throw new AppError(400, 'Start index is only valid when restarting.');
                        next = cloneState(session, dataset.id, input.name === undefined ? `${session.config.name} copy` : text(input.name, 'name'));
                    }
                    send(response, 200, view(store.createSession(next))); return;
                }
                if (method === 'POST' && action === 'command') {
                    const input = requireObject(await body(request, 262_144)); assertSafeContent(input, apiKey);
                    const expected = integer(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expected revision');
                    if (expected !== session.revision) throw new AppError(409, 'Session changed. Reload it before continuing.', 'REVISION_CONFLICT');
                    const command = requireObject(input.command) as unknown as Command;
                    if (runtime.preparing && !['layout', 'rename', 'bookmark'].includes(command.type)) throw new AppError(503, 'The application is preparing an update. Try again after it reconnects.', 'UPDATE_PENDING');
                    const dataset = store.dataset(session.config.datasetId);
                    if (command.type === 'advance') integer(command.count, 1, 5000, 'advance count');
                    if (command.type === 'advanceTo') {
                        const target = integer(command.time, 0, 8_640_000_000_000_000, 'target time');
                        const config = validateSessionConfig(session.config, dataset.barCount);
                        const endIndex = config.endIndex ?? dataset.barCount;
                        integer(session.cursor, config.startIndex - 1, endIndex - 1, 'cursor');
                        const last = store.db.prepare('SELECT idx FROM bars WHERE dataset_id=? AND idx<? AND time<=? ORDER BY time DESC LIMIT 1').get(dataset.id, endIndex, target) as { idx: number } | undefined;
                        if (last && last.idx - session.cursor > 5000) throw new AppError(400, 'Advance is limited to 5,000 source bars per request.');
                    }
                    const bars = store.commandBars(dataset.id, session.cursor);
                    const next = applyCommand(session, bars, command);
                    send(response, 200, view(store.saveSession(next, expected))); return;
                }
            }
            if (path.startsWith('/api/')) throw new AppError(404, 'Endpoint not found.', 'NOT_FOUND');
            if (method !== 'GET') throw new AppError(405, 'Method not allowed.');
            if (path === '/local-appearance/drawing-icons.js' || path === '/local-appearance/results-chart.mjs') {
                const content = await appearanceModule(dataDirectory, path.endsWith('drawing-icons.js') ? 'drawing-icons' : 'results-chart');
                response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(content); return;
            }
            const filename = path === '/' || path === '/index.html' ? 'index.html' : path === '/local-pine-worker.js' ? 'local-pine-worker.js' : /^\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css|svg|png|woff2)$/.test(path) ? path.slice(1) : undefined;
            if (!filename) throw new AppError(404, 'File not found.', 'NOT_FOUND');
            let content: Buffer;
            try {
                const file = await realpath(join(staticDirectory, filename)); const root = await realpath(staticDirectory);
                if (!file.startsWith(root + sep)) throw new Error('outside');
                content = await readFile(file);
            } catch { throw new AppError(404, 'Build the local application before opening it.', 'NOT_FOUND'); }
            const mime: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2' };
            if (filename === 'local-pine-worker.js') response.setHeader('Content-Security-Policy', PINE_WORKER_CSP);
            response.writeHead(200, { 'Content-Type': mime[filename.split('.').at(-1)!] ?? 'application/octet-stream', 'Cache-Control': filename === 'index.html' || filename === 'local-pine-worker.js' ? 'no-store' : 'public, max-age=31536000, immutable' }); response.end(content);
        } finally { inFlight--; if (writing) { activeWrites--; runtime.activityChanged(); } }
    }
    return {
        server, store, scripts, dataDirectory, runtime,
        async listen(): Promise<string> {
            await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(options.port ?? 5197, '127.0.0.1', () => { server.off('error', reject); resolveListen(); }); });
            const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback address');
            return `http://127.0.0.1:${address.port}`;
        },
        close(): Promise<void> {
            if (!closePromise) closePromise = (async () => {
                closing = true; runtime.close(); chartAgent.close(); const deepStopped = deepHistory.close(); const statsStopped = marketStats.dispose(); const historyStopped = history?.dispose() ?? Promise.resolve();
                const stopped = server.listening ? new Promise<void>((resolveClose, reject) => { server.close(error => error ? reject(error) : resolveClose()); }) : Promise.resolve();
                await Promise.allSettled([...requests]);
                await stopped; await deepStopped; await statsStopped; await historyStopped; store.close();
            })();
            return closePromise;
        },
    };
}
// Keep imports inert for tests, key migration and dataset migration tools.
export async function startServer(options: ServerOptions = {}): Promise<Awaited<ReturnType<typeof createReplayServer>>> {
    const app = await createReplayServer(options); const url = await app.listen();
    console.log(`Local Replay Studio: ${url}`); return app;
}
export async function serverOptionsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<ServerOptions> {
    const options: ServerOptions = {};
    if (environment.VELA_PORT !== undefined) {
        if (!['5197', '5199'].includes(environment.VELA_PORT)) throw new AppError(500, 'Invalid local runtime port.');
        options.port = Number(environment.VELA_PORT);
    }
    const mode = environment.VELA_RUNTIME_MODE; const version = environment.VELA_RUNTIME_VERSION;
    if (mode !== undefined || version !== undefined) {
        options.runtime = validateRuntime({ mode, version } as ManagedRuntimeOptions);
        if (!environment.VELA_REPOSITORY_DIRECTORY || !environment.VELA_STATIC_DIRECTORY) throw new AppError(500, 'Managed runtime paths are required.');
        if ((mode === 'run' && options.port !== 5197) || (mode === 'develop' && options.port !== 5199)) throw new AppError(500, 'The runtime mode does not match its local port.');
    }
    for (const [name, key] of [['VELA_REPOSITORY_DIRECTORY', 'repositoryDirectory'], ['VELA_STATIC_DIRECTORY', 'staticDirectory']] as const) {
        const value = environment[name];
        if (value === undefined) continue;
        if (!value || !isAbsolute(value) || /[\u0000-\u001f]/.test(value)) throw new AppError(500, 'Invalid local runtime path.');
        try {
            const path = await realpath(value);
            if (!(await stat(path)).isDirectory()) throw new Error('not directory');
            if (key === 'repositoryDirectory' && !(await stat(join(path, 'package.json'))).isFile()) throw new Error('not repository');
            options[key] = path;
        } catch { throw new AppError(500, 'The local runtime directory is unavailable.'); }
    }
    return options;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    void serverOptionsFromEnvironment().then(async options => {
        if (options.runtime && (!process.send || !process.connected)) throw new AppError(500, 'Managed runtime requires its desktop supervisor.');
        const app = await startServer(options);
        const notify = (message: object) => {
            if (process.connected) {
                try { process.send?.(message, () => {}); } catch { /* The working backend survives a disconnected supervisor. */ }
            }
        };
        let shuttingDown = false;
        const shutdown = (updateId?: unknown) => {
            if (shuttingDown) return;
            if (!app.runtime.beginShutdown(updateId)) {
                notify({ type: 'runtime:shutdown-refused', ...(typeof updateId === 'string' && /^[a-f0-9-]{36}$/i.test(updateId) ? { updateId } : {}) });
                return;
            }
            shuttingDown = true;
            notify({ type: 'runtime:stopping', ...(updateId === undefined ? {} : { updateId }) });
            void app.close().then(() => process.exit(0)).catch(() => { process.exitCode = 1; process.disconnect?.(); });
        };
        process.once('SIGINT', () => shutdown()); process.once('SIGTERM', () => shutdown());
        if (options.runtime && process.send && process.connected) {
            app.runtime.onReady(notify);
            process.on('message', message => {
                if (!message || typeof message !== 'object' || Array.isArray(message)) return;
                const input = message as Record<string, unknown>;
                if (input.type === 'runtime:prepare') app.runtime.prepare(input.updateId);
                else if (input.type === 'runtime:cancel') app.runtime.cancel(input.updateId);
                else if (input.type === 'runtime:shutdown') shutdown(input.updateId);
            });
            const address = app.server.address();
            notify({ type: 'runtime:listening', port: address && typeof address === 'object' ? address.port : options.port, instanceId: app.runtime.instanceId, version: options.runtime.version, repositoryId: app.runtime.repositoryId });
        }
    }).catch(() => { console.error('Local Replay Studio failed to start. Check Node 24, the local port and encrypted settings.'); process.exitCode = 1; process.disconnect?.(); });
}
