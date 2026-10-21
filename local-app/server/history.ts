import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import type { Bar, DatasetMeta } from '../shared/types';
import { continuousInstrument, epochMilliseconds, MAX_DATA_BYTES, parseContinuousBar } from './data';
import { AppError, requireObject } from './errors';
import { DatabentoHistoryClient } from './provider';
import type { FetchFunction } from './provider';
import type { HistoryChunk, HistoryController, HistoryJobSummary, HistoryManifest, HistoryMapping, HistoryRequest, HistorySymbol } from './history-types';
export type * from './history-types';

const MINUTE = 60_000; const MAX_CHUNKS = 244; const MAX_LINE_BYTES = 16_384;
let globalActive: object | null = null;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new AppError(400, 'History work was cancelled.', 'ABORTED'); };
const summary = (manifest: HistoryManifest): HistoryJobSummary => {
    const { format: _format, requestSha256: _hash, ...view } = manifest; return structuredClone(view);
};
function request(input: unknown): HistoryRequest {
    const value = requireObject(input);
    if (Object.keys(value).some(key => !['symbols', 'start', 'end'].includes(key)) || !Array.isArray(value.symbols) || value.symbols.length < 1 || value.symbols.length > 2 || new Set(value.symbols).size !== value.symbols.length) throw new AppError(400, 'Choose NQ.v.0 and/or GC.v.0 with an explicit history range.');
    for (const symbol of value.symbols) continuousInstrument(symbol);
    if (typeof value.start !== 'string' || typeof value.end !== 'string' || !value.start.endsWith('Z') || !value.end.endsWith('Z')) throw new AppError(400, 'History dates must be explicit UTC timestamps.');
    const start = epochMilliseconds(value.start); const end = epochMilliseconds(value.end);
    if (start < Date.UTC(2020, 0, 1) || end <= start || end > Date.now() || start % MINUTE || end % MINUTE || end - start > 10 * 366 * 86_400_000) throw new AppError(400, 'Use minute-aligned history from 2020 onward, at most ten years, ending no later than now.');
    return { symbols: [...value.symbols].sort() as HistorySymbol[], start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
function chunksFor(input: HistoryRequest): HistoryChunk[] {
    const chunks: HistoryChunk[] = [];
    for (const symbol of input.symbols) {
        for (let start = Date.parse(input.start); start < Date.parse(input.end);) {
            const date = new Date(start); const end = Math.min(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1), Date.parse(input.end));
            const iso = new Date(start).toISOString();
            chunks.push({ key: `${symbol.slice(0, 2)}-${iso.slice(0, 7)}`, request: { dataset: 'GLBX.MDP3', symbols: symbol, schema: 'ohlcv-1m', stype_in: 'continuous', start: iso, end: new Date(end).toISOString() }, state: 'pending', rows: 0, rawSha256: null, normalizedSha256: null, quotedAt: null, firstTime: null, lastTime: null }); start = end;
        }
    }
    if (chunks.length > MAX_CHUNKS) throw new AppError(400, 'History request contains too many monthly chunks.');
    return chunks;
}
async function fileHash(file: string, signal?: AbortSignal): Promise<string> {
    const hash = createHash('sha256'); const stream = createReadStream(file);
    const abort = () => stream.destroy(new AppError(400, 'History verification was cancelled.', 'ABORTED'));
    signal?.addEventListener('abort', abort, { once: true });
    try { check(signal); for await (const part of stream) { check(signal); hash.update(part); } return hash.digest('hex'); }
    finally { signal?.removeEventListener('abort', abort); stream.destroy(); }
}
async function verifyChunk(directory: string, chunk: HistoryChunk, signal?: AbortSignal): Promise<void> {
    try {
        if (await fileHash(join(directory, `${chunk.key}.raw.jsonl`), signal) !== chunk.rawSha256
            || await fileHash(join(directory, `${chunk.key}.bars.jsonl`), signal) !== chunk.normalizedSha256
            || await fileHash(join(directory, `${chunk.key}.symbology.json`), signal) !== chunk.mappingSha256) throw new Error();
    } catch (error) { check(signal); if (error instanceof AppError) throw error; throw new AppError(400, 'A staged history chunk failed integrity verification. No import or replacement was performed.', 'HISTORY_INTEGRITY'); }
}
async function stageResponse(response: Response, mappings: HistoryMapping[], directory: string, chunk: HistoryChunk, signal?: AbortSignal): Promise<Pick<HistoryChunk, 'rows' | 'rawSha256' | 'normalizedSha256' | 'mappingSha256' | 'firstTime' | 'lastTime'>> {
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_DATA_BYTES)) { await response.body?.cancel(); throw new AppError(413, 'Monthly history response exceeds its byte budget.'); }
    if (!response.body) throw new AppError(502, 'History response has no body.', 'INVALID_DATA');
    const rawPart = join(directory, `${chunk.key}.raw.part`); const barsPart = join(directory, `${chunk.key}.bars.part`);
    const raw = await open(rawPart, 'w', 0o600); const normalized = await open(barsPart, 'w', 0o600);
    const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
    const rawHash = createHash('sha256'); const normalizedHash = createHash('sha256');
    let bytes = 0; let pending = ''; let rows = 0; let previous = -1; let firstTime: number | null = null; let batch: string[] = [];
    const range = { start: Date.parse(chunk.request.start), end: Date.parse(chunk.request.end) };
    const closure = new Map<string, string>();
    const line = (text: string) => {
        if (!text.trim()) return;
        if (Buffer.byteLength(text) > MAX_LINE_BYTES) throw new AppError(413, 'History record exceeds its size limit.');
        let value: unknown; try { value = JSON.parse(text); } catch { throw new AppError(502, 'History response contains invalid JSONL.', 'INVALID_DATA'); }
        const row = requireObject(value); const hd = requireObject(row.hd); const id = String(hd.instrument_id);
        const time = epochMilliseconds(row.time ?? row.ts_event ?? hd.ts_event);
        const matched = mappings.filter(mapping => mapping.instrumentId === id && time >= mapping.start && time < mapping.end);
        if (matched.length !== 1 || row.symbol !== undefined && row.symbol !== matched[0]!.contract) throw new AppError(400, 'A history record lacks one verified dated raw-contract mapping.', 'INVALID_MAPPING');
        const bar = parseContinuousBar({ ...row, symbol: matched[0]!.contract }, chunk.request.symbols, range);
        if (bar.time <= previous || ++rows > (range.end - range.start) / MINUTE) throw new AppError(400, 'History bars must be unique, ordered and bounded by the frozen request.', 'INVALID_DATA');
        const key = `${new Date(bar.time).toISOString().slice(0, 10)}:${bar.instrumentId}`;
        const known = closure.get(key); if (known && known !== bar.contract) throw new AppError(400, 'Provider instrument mapping is contradictory.', 'INVALID_DATA');
        closure.set(key, bar.contract); previous = bar.time; firstTime ??= bar.time;
        const encoded = JSON.stringify(bar) + '\n'; normalizedHash.update(encoded); batch.push(encoded);
    };
    const flush = async () => { if (batch.length) { await normalized.writeFile(batch.join('')); batch = []; } };
    try {
        for (;;) {
            check(signal); const part = await reader.read(); if (part.done) break;
            bytes += part.value.byteLength; if (bytes > MAX_DATA_BYTES) throw new AppError(413, 'Monthly history response exceeds its byte budget.');
            rawHash.update(part.value); await raw.writeFile(part.value);
            pending += decoder.decode(part.value, { stream: true });
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0) { line(pending.slice(0, end).replace(/\r$/, '')); pending = pending.slice(end + 1); if (batch.length >= 1024) { await flush(); check(signal); } }
            if (Buffer.byteLength(pending) > MAX_LINE_BYTES) throw new AppError(413, 'History record exceeds its size limit.');
        }
        pending += decoder.decode(); if (pending) line(pending); await flush(); check(signal);
        await raw.sync(); await normalized.sync();
    } catch (error) {
        await reader.cancel().catch(() => {}); throw error;
    } finally { reader.releaseLock(); await raw.close(); await normalized.close(); }
    renameSync(rawPart, join(directory, `${chunk.key}.raw.jsonl`)); renameSync(barsPart, join(directory, `${chunk.key}.bars.jsonl`));
    const mappingText = JSON.stringify(mappings); const mappingPart = join(directory, `${chunk.key}.symbology.part`);
    writeFileSync(mappingPart, mappingText, { mode: 0o600 }); renameSync(mappingPart, join(directory, `${chunk.key}.symbology.json`));
    return { rows, rawSha256: rawHash.digest('hex'), normalizedSha256: normalizedHash.digest('hex'), mappingSha256: digest(mappingText), firstTime, lastTime: rows ? previous : null };
}

export function createHistoryController(options: { stagingDirectory: string; key: () => string | undefined; fetch?: FetchFunction }): HistoryController {
    if (!isAbsolute(options.stagingDirectory)) throw new AppError(400, 'History staging requires an explicit absolute application-owned directory.');
    mkdirSync(options.stagingDirectory, { recursive: true, mode: 0o700 });
    const root = realpathSync(options.stagingDirectory); const client = new DatabentoHistoryClient(options.key, options.fetch);
    let active: { id: string; abort: AbortController; promise: Promise<HistoryJobSummary>; token: object } | null = null; let closed = false;
    let importing: { id: string; abort: AbortController; promise: Promise<DatasetMeta> } | null = null;
    const directoryFor = (id: string) => {
        if (!/^history-[a-f0-9]{24}$/.test(id)) throw new AppError(400, 'Invalid history job ID.');
        const directory = resolve(root, id);
        if (!directory.startsWith(root + sep) || existsSync(directory) && realpathSync(directory) !== directory) throw new AppError(400, 'Invalid history staging directory.');
        return directory;
    };
    const save = (manifest: HistoryManifest) => {
        manifest.completedChunks = manifest.chunks.filter(chunk => chunk.state === 'complete').length;
        manifest.rows = manifest.chunks.reduce((sum, chunk) => sum + chunk.rows, 0); manifest.updatedAt = new Date().toISOString();
        const directory = directoryFor(manifest.jobId); const temporary = join(directory, `manifest-${randomUUID()}.tmp`);
        writeFileSync(temporary, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 }); renameSync(temporary, join(directory, 'manifest.json'));
    };
    const load = (id: string): HistoryManifest => {
        let manifest: HistoryManifest;
        try {
            const raw = readFileSync(join(directoryFor(id), 'manifest.json'), 'utf8'); if (Buffer.byteLength(raw) > 512_000) throw new Error();
            manifest = JSON.parse(raw) as HistoryManifest;
            const normalized = request(manifest.request); const hash = digest(JSON.stringify(normalized)); const expected = chunksFor(normalized);
            if (manifest.format !== 1 || manifest.jobId !== id || id !== `history-${hash.slice(0, 24)}` || manifest.requestSha256 !== hash || !Array.isArray(manifest.chunks) || manifest.chunks.length !== expected.length) throw new Error();
            for (const [index, chunk] of manifest.chunks.entries()) {
                if (chunk.key !== expected[index]!.key || JSON.stringify(chunk.request) !== JSON.stringify(expected[index]!.request) || !['pending', 'complete'].includes(chunk.state)
                    || !Number.isSafeInteger(chunk.rows) || chunk.rows < 0 || chunk.rows > 44_640
                    || chunk.state === 'complete' && (!/^[a-f0-9]{64}$/.test(chunk.rawSha256 ?? '') || !/^[a-f0-9]{64}$/.test(chunk.normalizedSha256 ?? '') || !/^[a-f0-9]{64}$/.test(chunk.mappingSha256 ?? ''))) throw new Error();
            }
        } catch (error) { if (error instanceof AppError) throw error; throw new AppError(400, 'History staging receipt is missing or invalid.', 'HISTORY_INTEGRITY'); }
        return manifest;
    };
    const lock = (directory: string, jobId: string): (() => void) => {
        const file = join(directory, 'active.lock');
        if (existsSync(file)) {
            let old: { jobId: string; pid: number };
            try { old = JSON.parse(readFileSync(file, 'utf8')); if (old.jobId !== jobId || !Number.isSafeInteger(old.pid) || old.pid < 1) throw new Error(); }
            catch { throw new AppError(409, 'History staging lock is invalid.', 'HISTORY_LOCKED'); }
            let alive = true; try { process.kill(old.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
            if (alive) throw new AppError(409, 'This history job is active in another process.', 'HISTORY_LOCKED');
            rmSync(file);
        }
        writeFileSync(file, JSON.stringify({ jobId, pid: process.pid }), { flag: 'wx', mode: 0o600 });
        return () => { rmSync(file, { force: true }); };
    };
    return {
        list() {
            const jobs = readdirSync(root).filter(name => /^history-[a-f0-9]{24}$/.test(name));
            if (jobs.length > 100) throw new AppError(413, 'History staging contains too many jobs.');
            return jobs.map(job => summary(load(job))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        },
        plan(input) {
            if (closed) throw new AppError(400, 'History controller is closed.');
            const normalized = request(input); const hash = digest(JSON.stringify(normalized)); const jobId = `history-${hash.slice(0, 24)}`; const directory = directoryFor(jobId);
            if (existsSync(join(directory, 'manifest.json'))) return summary(load(jobId));
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            const manifest: HistoryManifest = { format: 1, requestSha256: hash, jobId, request: normalized, state: 'planned', completedChunks: 0, totalChunks: 0, rows: 0, chunks: chunksFor(normalized), updatedAt: new Date().toISOString(), error: null };
            manifest.totalChunks = manifest.chunks.length; save(manifest); return summary(manifest);
        },
        status(jobId) { return summary(load(jobId)); },
        async run(jobId, runOptions = {}) {
            if (closed) throw new AppError(400, 'History controller is closed.');
            if (globalActive || active) throw new AppError(409, 'Another history job is active.', 'HISTORY_ACTIVE');
            const manifest = load(jobId); const directory = directoryFor(jobId); const unlock = lock(directory, jobId);
            const abort = new AbortController(); const token = {}; globalActive = token;
            const cancel = () => abort.abort(); runOptions.signal?.addEventListener('abort', cancel, { once: true });
            if (runOptions.signal?.aborted) abort.abort();
            const promise = (async () => {
                // Publish ownership before a pre-aborted run can finish synchronously.
                await Promise.resolve();
                try {
                    manifest.state = 'running'; manifest.error = null; save(manifest);
                    for (const chunk of manifest.chunks) {
                        check(abort.signal);
                        if (chunk.state === 'complete') { await verifyChunk(directory, chunk, abort.signal); continue; }
                        const disk = statfsSync(directory);
                        if (disk.bavail * disk.bsize < 2 * MAX_DATA_BYTES + 128 * 1024 * 1024) throw new AppError(413, 'History staging needs more local free disk space.', 'HISTORY_CAPACITY');
                        let receipt: (Awaited<ReturnType<typeof stageResponse>> & { quotedAt: string; costUsd: 0 }) | undefined;
                        for (let attempt = 0; attempt < 3; attempt++) {
                            check(abort.signal); save(manifest);
                            try {
                                receipt = await client.downloadMonth(chunk.request, async (response, mappings, quote) => ({ ...await stageResponse(response, mappings, directory, chunk, abort.signal), ...quote }), abort.signal);
                                break;
                            }
                            catch (error) {
                                if (abort.signal.aborted || !(error instanceof AppError) || !['PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT'].includes(error.code) || attempt === 2) throw error;
                                // Each retry repeats resolution and the exact fresh zero-cost quote.
                                await delay((attempt + 1) * 1000, undefined, { signal: abort.signal });
                            }
                        }
                        if (!receipt) throw new AppError(502, 'History month could not be staged.', 'HISTORY_FAILED');
                        Object.assign(chunk, receipt, { state: 'complete' }); save(manifest);
                        await setImmediate();
                    }
                    manifest.state = 'ready'; save(manifest); return summary(manifest);
                } catch (error) {
                    manifest.state = abort.signal.aborted ? 'cancelled' : 'failed';
                    manifest.error = abort.signal.aborted ? { code: 'ABORTED', message: 'History work was cancelled.' }
                        : { code: error instanceof AppError ? error.code : 'HISTORY_FAILED', message: error instanceof AppError ? error.message : 'History staging failed. Verified completed months can be resumed.' };
                    save(manifest); return summary(manifest);
                } finally {
                    runOptions.signal?.removeEventListener('abort', cancel); unlock();
                    if (globalActive === token) globalActive = null; active = null;
                }
            })();
            active = { id: jobId, abort, promise, token }; return await promise;
        },
        cancel(jobId) { directoryFor(jobId); if (active?.id === jobId) active.abort.abort(); if (importing?.id === jobId) importing.abort.abort(); },
        async dispose() {
            closed = true; const running = active; const loading = importing; running?.abort.abort(); loading?.abort.abort();
            await Promise.allSettled([running?.promise, loading?.promise]);
        },
        async importDataset(store, jobId, symbol, importOptions = {}) {
            if (closed) throw new AppError(400, 'History controller is closed.');
            const manifest = load(jobId); const directory = directoryFor(jobId); continuousInstrument(symbol);
            if (active || globalActive || manifest.state !== 'ready' || manifest.chunks.some(chunk => chunk.state !== 'complete')) throw new AppError(409, 'Only a completed, verified history job can be imported.', 'HISTORY_NOT_READY');
            const selected = manifest.chunks.filter(chunk => chunk.request.symbols === symbol);
            if (!selected.length) throw new AppError(400, 'The selected symbol is not part of this history job.');
            const abort = new AbortController(); const token = {}; globalActive = token;
            const cancel = () => abort.abort(); importOptions.signal?.addEventListener('abort', cancel, { once: true });
            if (importOptions.signal?.aborted) abort.abort();
            const promise = (async () => {
            for (const chunk of selected) await verifyChunk(directory, chunk, abort.signal);
            const manifestHash = digest(JSON.stringify({ request: manifest.request, symbol, chunks: selected }));
            const bars = async function* (): AsyncGenerator<Bar> {
                for (const chunk of selected) {
                    const file = join(directory, `${chunk.key}.bars.jsonl`); const hash = createHash('sha256'); let rows = 0;
                    const stream = createReadStream(file); const lines = createInterface({ input: stream, crlfDelay: Infinity });
                    try {
                        for await (const line of lines) {
                            check(abort.signal); if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new AppError(400, 'Staged record exceeds its bound.', 'HISTORY_INTEGRITY');
                            hash.update(line + '\n'); rows++; let bar: Bar;
                            try { bar = JSON.parse(line) as Bar; } catch { throw new AppError(400, 'Staged record is invalid.', 'HISTORY_INTEGRITY'); }
                            if (bar.time < Date.parse(chunk.request.start) || bar.time >= Date.parse(chunk.request.end)) throw new AppError(400, 'Staged record exceeds its frozen monthly scope.', 'HISTORY_INTEGRITY');
                            yield bar;
                        }
                        if (rows !== chunk.rows || hash.digest('hex') !== chunk.normalizedSha256) throw new AppError(400, 'Staged history changed during import.', 'HISTORY_INTEGRITY');
                    } finally { lines.close(); stream.destroy(); }
                }
            };
            return store.addHistoryDataset({ name: `${symbol} volume front month (unadjusted)`, symbol, expectedRows: selected.reduce((sum, chunk) => sum + chunk.rows, 0),
                scope: JSON.stringify({ history: manifestHash, symbol }), provenance: { stypeIn: 'continuous', rollRule: 'volume', rank: 0, adjustment: 'none', rollPolicy: 'flatten-prior-close', requestedStart: manifest.request.start, requestedEnd: manifest.request.end, manifestHash }, bars: bars(), signal: abort.signal });
            })();
            importing = { id: jobId, abort, promise };
            try { return await promise; }
            finally { importOptions.signal?.removeEventListener('abort', cancel); if (globalActive === token) globalActive = null; importing = null; }
        },
    };
}
