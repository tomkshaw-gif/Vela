import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHistoryController } from '../server/history';
import { ReplayStore } from '../server/store';
import type { HistoryRequest } from '../server/history';
import type { FetchFunction } from '../server/provider';
import type { Bar } from '../shared/types';

const directories: string[] = []; const stores: ReplayStore[] = [];
afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const directory of directories.splice(0)) {
        if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('vela-history-proof-')) throw new Error('Unexpected fixture directory.');
        rmSync(directory, { recursive: true, force: true });
    }
});
function directory() { const value = mkdtempSync(join(tmpdir(), 'vela-history-proof-')); directories.push(value); return value; }
function input(): HistoryRequest { return { symbols: ['NQ.v.0'], start: '2020-01-01T00:00:00.000Z', end: '2020-03-02T00:00:00.000Z' }; }
function provider(options: { cost?: (quote: number) => unknown; onQuote?: (quote: number) => void; badIdentity?: boolean } = {}) {
    let quotes = 0; let mappingRoot = 'NQ'; const calls: { kind: string; params: URLSearchParams }[] = [];
    const fetcher = vi.fn<FetchFunction>(async (url, init) => {
        const endpoint = new URL(String(url)); const quote = endpoint.pathname.endsWith('metadata.get_cost');
        if (endpoint.pathname.endsWith('symbology.resolve')) {
            const params = endpoint.searchParams; const continuous = params.get('stype_in') === 'continuous';
            const start = params.get('start_date')!; const month = new Date(start).getUTCMonth(); const id = String(1000 + month);
            if (continuous) mappingRoot = params.get('symbols')!.slice(0, 2);
            return new Response(JSON.stringify({ status: 0, stype_in: params.get('stype_in'), stype_out: params.get('stype_out'), result: { [continuous ? params.get('symbols')! : id]: [{ d0: start, d1: params.get('end_date'), s: continuous ? id : `${mappingRoot}${month > 1 ? 'M' : 'H'}0` }] } }));
        }
        const params = quote ? endpoint.searchParams : new URLSearchParams(String(init?.body));
        calls.push({ kind: quote ? 'quote' : 'range', params: new URLSearchParams(params) });
        if (quote) { quotes++; options.onQuote?.(quotes); return new Response(JSON.stringify(options.cost ? options.cost(quotes) : 0)); }
        const time = Date.parse(params.get('start')!); const root = params.get('symbols')!.slice(0, 2);
        return new Response([0, 1].map(offset => JSON.stringify({ hd: { ts_event: String(BigInt(time + offset * 60_000) * 1_000_000n), instrument_id: options.badIdentity ? undefined : 1000 + new Date(time).getUTCMonth() },
            symbol: `${root}${new Date(time).getUTCMonth() > 1 ? 'M' : 'H'}0`, open: '100000000000', high: '100000000000', low: '100000000000', close: '100000000000', volume: 1 })).join('\n') + '\n');
    });
    return { fetcher, calls };
}

describe('bounded zero-budget continuous history', () => {
    it('freezes canonical monthly scopes, finishes all chunks, verifies receipts and exposes no dataset until import', async () => {
        const staging = directory(); const remote = provider(); const controller = createHistoryController({ stagingDirectory: staging, key: () => 'fixture-key', fetch: remote.fetcher });
        const plan = controller.plan(input()); expect(plan.totalChunks).toBe(3); expect(plan.state).toBe('planned');
        expect(controller.list().map(job => job.jobId)).toEqual([plan.jobId]);
        const store = new ReplayStore(directory()); stores.push(store);
        expect(store.listDatasets()).toEqual([]);
        const ready = await controller.run(plan.jobId); expect(ready.state).toBe('ready'); expect(ready.completedChunks).toBe(3); expect(ready.rows).toBe(6);
        expect(ready.chunks.every(chunk => chunk.costUsd === 0 && Number.isFinite(Date.parse(chunk.quotedAt!)))).toBe(true);
        expect(remote.calls.map(call => call.kind)).toEqual(['quote', 'range', 'quote', 'range', 'quote', 'range']);
        for (let index = 0; index < remote.calls.length; index += 2) {
            const quote = remote.calls[index]!.params; const range = remote.calls[index + 1]!.params;
            for (const key of ['dataset', 'symbols', 'stype_in', 'schema', 'start', 'end']) expect(range.get(key)).toBe(quote.get(key));
            expect(range.get('stype_out')).toBe('instrument_id'); expect(range.get('pretty_px')).toBe('false');
        }
        expect(store.listDatasets()).toEqual([]);
        const dataset = await controller.importDataset(store, plan.jobId, 'NQ.v.0');
        expect(dataset.barCount).toBe(6); expect(dataset.continuous).toMatchObject({ rollRule: 'volume', adjustment: 'none', rollPolicy: 'flatten-prior-close' });
        expect(dataset.continuous!.segments).toHaveLength(3); expect(store.readBarWindow(dataset.id, 4, 2)[0]).toMatchObject({ contract: 'NQM0', instrumentId: '1002' });
        expect((await controller.importDataset(store, plan.jobId, 'NQ.v.0')).id).toBe(dataset.id);
        await controller.dispose();
    });
    it('stops before a nonzero/invalid monthly data call and resumes only the remaining verified chunks', async () => {
        const staging = directory(); const expensive = provider({ cost: quote => quote === 2 ? 1 : 0 });
        const first = createHistoryController({ stagingDirectory: staging, key: () => 'fixture-key', fetch: expensive.fetcher });
        const plan = first.plan(input()); const stopped = await first.run(plan.jobId);
        expect(stopped.state).toBe('failed'); expect(stopped.error?.code).toBe('ZERO_BUDGET'); expect(stopped.completedChunks).toBe(1);
        expect(expensive.calls.filter(call => call.kind === 'range')).toHaveLength(1); await first.dispose();
        const free = provider(); const resume = createHistoryController({ stagingDirectory: staging, key: () => 'fixture-key', fetch: free.fetcher });
        expect(resume.list()[0]!.completedChunks).toBe(1);
        expect((await resume.run(plan.jobId)).state).toBe('ready'); expect(free.calls.filter(call => call.kind === 'range')).toHaveLength(2); await resume.dispose();
        const invalid = provider({ cost: () => '0' }); const rejected = createHistoryController({ stagingDirectory: directory(), key: () => 'fixture-key', fetch: invalid.fetcher });
        const bad = rejected.plan(input()); expect((await rejected.run(bad.jobId)).error?.code).toBe('INVALID_QUOTE');
        expect(invalid.calls.filter(call => call.kind === 'range')).toHaveLength(0); await rejected.dispose();
    });
    it('cancels and drains, rejects overlapping jobs, resumes after cancellation', async () => {
        const staging = directory(); const abort = new AbortController(); let controller: ReturnType<typeof createHistoryController>;
        const remote = provider({ onQuote: count => { if (count === 2) abort.abort(); } });
        controller = createHistoryController({ stagingDirectory: staging, key: () => 'fixture-key', fetch: remote.fetcher });
        const plan = controller.plan(input()); const running = controller.run(plan.jobId, { signal: abort.signal });
        await expect(controller.run(plan.jobId)).rejects.toMatchObject({ code: 'HISTORY_ACTIVE' });
        const cancelled = await running; expect(cancelled.state).toBe('cancelled'); expect(cancelled.completedChunks).toBe(1);
        await controller.dispose(); const resumedRemote = provider();
        const resumed = createHistoryController({ stagingDirectory: staging, key: () => 'fixture-key', fetch: resumedRemote.fetcher });
        expect((await resumed.run(plan.jobId)).state).toBe('ready'); await resumed.dispose();
    });
    it('refuses corrupt staging and missing provider contract identities', async () => {
        const staging = directory(); const remote = provider(); const controller = createHistoryController({ stagingDirectory: staging, key: () => 'fixture-key', fetch: remote.fetcher });
        const plan = controller.plan(input()); const ready = await controller.run(plan.jobId);
        writeFileSync(join(staging, plan.jobId, `${ready.chunks[0]!.key}.bars.jsonl`), '{}\n');
        const store = new ReplayStore(directory()); stores.push(store);
        await expect(controller.importDataset(store, plan.jobId, 'NQ.v.0')).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY' });
        expect(store.listDatasets()).toEqual([]); await controller.dispose();
        const missing = provider({ badIdentity: true }); const rejected = createHistoryController({ stagingDirectory: directory(), key: () => 'fixture-key', fetch: missing.fetcher });
        expect((await rejected.run(rejected.plan(input()).jobId)).state).toBe('failed'); await rejected.dispose();
    });
    it('requires another fresh zero quote after a transient range failure and stops if that quote changes', async () => {
        const remote = provider({ cost: quote => quote === 1 ? 0 : 1 });
        const fetcher: FetchFunction = async (...args) => {
            const response = await remote.fetcher(...args);
            if (String(args[0]).endsWith('/timeseries.get_range')) { await response.body?.cancel(); return new Response('', { status: 503 }); }
            return response;
        };
        const controller = createHistoryController({ stagingDirectory: directory(), key: () => 'fixture-key', fetch: fetcher });
        const plan = controller.plan({ ...input(), end: '2020-02-01T00:00:00Z' });
        const result = await controller.run(plan.jobId);
        expect(result.state).toBe('failed'); expect(result.error?.code).toBe('ZERO_BUDGET');
        expect(remote.calls.map(call => call.kind)).toEqual(['quote', 'range', 'quote']); await controller.dispose();
    });
    it('never publishes provisional datasets, rolls back an interrupted incremental import', async () => {
        const store = new ReplayStore(directory()); stores.push(store); const abort = new AbortController(); let published = -1;
        async function* source(): AsyncGenerator<Bar> {
            yield { time: Date.UTC(2020, 0, 2), open: 100, high: 100, low: 100, close: 100, volume: 1, instrumentId: '1', contract: 'NQH0' };
            published = store.listDatasets().length;
            expect(() => store.addDataset({ name: 'Concurrent fixture', symbol: 'NQH0', schema: 'ohlcv-1m', source: 'csv', bars: [] })).toThrow(expect.objectContaining({ code: 'HISTORY_IMPORT_ACTIVE' }));
            expect(() => store.close()).toThrow(expect.objectContaining({ code: 'HISTORY_IMPORT_ACTIVE' }));
            expect(() => store.dataset(store.db.prepare('SELECT id FROM datasets WHERE ready=0').get()!.id as string)).toThrow();
            abort.abort(); yield { time: Date.UTC(2020, 0, 2, 0, 1), open: 100, high: 100, low: 100, close: 100, volume: 1, instrumentId: '1', contract: 'NQH0' };
        }
        await expect(store.addHistoryDataset({ name: 'Fixture', symbol: 'NQ.v.0', expectedRows: 2, scope: 'fixture', provenance: { stypeIn: 'continuous', rollRule: 'volume', rank: 0, adjustment: 'none', rollPolicy: 'flatten-prior-close', requestedStart: input().start, requestedEnd: input().end, manifestHash: '0'.repeat(64) }, bars: source(), signal: abort.signal })).rejects.toMatchObject({ code: 'ABORTED' });
        expect(published).toBe(0); expect(store.listDatasets()).toEqual([]); expect(store.db.prepare('SELECT COUNT(*) AS count FROM bars').get()!.count).toBe(0);
    });
    it('rejects arbitrary symbol/path/range inputs and returns detached status', async () => {
        const controller = createHistoryController({ stagingDirectory: directory(), key: () => undefined });
        for (const value of [{ ...input(), symbols: ['../NQ.v.0'] }, { ...input(), start: '2019-01-01T00:00:00Z' }, { ...input(), end: '2100-01-01T00:00:00Z' }, { ...input(), path: '/outside' }]) expect(() => controller.plan(value)).toThrow();
        expect(() => controller.status('../outside')).toThrow();
        const plan = controller.plan(input()); plan.chunks[0]!.request.symbols = 'GC.v.0';
        expect(controller.status(plan.jobId).chunks[0]!.request.symbols).toBe('NQ.v.0'); await controller.dispose();
    });
    it('does not retain a busy job when a request is already cancelled before it starts', async () => {
        const remote = provider(); const controller = createHistoryController({ stagingDirectory: directory(), key: () => 'fixture-key', fetch: remote.fetcher });
        try {
            const plan = controller.plan({ ...input(), end: '2020-02-01T00:00:00Z' });
            expect((await controller.run(plan.jobId, { signal: AbortSignal.abort() })).state).toBe('cancelled');
            expect(remote.calls).toEqual([]);
            expect((await controller.run(plan.jobId)).state).toBe('ready');
        } finally { await controller.dispose(); }
    });
});
