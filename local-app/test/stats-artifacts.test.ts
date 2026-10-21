import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createNodeStatsArtifactJobFactory } from '../server/market-stats/node-job';
import { createStatsArtifactService, artifactOperation } from '../server/market-stats/artifacts';
import type { MarketStatsInput } from '../server/market-stats';
import { createReplayServer } from '../server/index';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const start = Date.UTC(2024, 0, 2);
function input(): MarketStatsInput {
    return { symbol: 'TEST', assetClass: 'crypto', sourceIntervalMs: 60000, revealedUntil: start + 11 * 86400000 + 180000,
        bars: Array.from({ length: 36 }, (_, i) => ({ time: start + Math.floor(i / 3) * 86400000 + i % 3 * 60000, open: 100, high: 103, low: 98, close: i % 6 < 3 ? 102 : 99, volume: 1 })),
        session: { key: 'short', start: '00:00', end: '00:03', tz: 'UTC', overnight: false }, calendar: null, orWindows: [1], ibWindow: 1, query: { dsl: 'closeGreen' } };
}
async function service() {
    const directory = await mkdtemp(join(tmpdir(), 'vela-stats-artifacts-')); directories.push(directory);
    return { directory, service: createStatsArtifactService(createNodeStatsArtifactJobFactory({ scratchDirectory: directory, workerUrl: new URL('../server/market-stats/worker.ts', import.meta.url), execArgv: ['--import', import.meta.resolve('tsx')] })) };
}
it('reads actual matched one-minute candles and derived levels through a worker and removes its scratch job', async () => {
    const f = await service();
    try {
        const result = await f.service.run(input(), { kind: 'session', sessionId: 'TEST|short|2024-01-03', contextBars: 2 });
        expect(result.kind).toBe('session'); if (result.kind !== 'session') throw new Error('Wrong artifact');
        expect(result.session).toMatchObject({ tradeDate: '2024-01-03', levels: { prevClose: 102, open: 100, close: 99 } });
        expect(result.session.bars).toHaveLength(3); expect(result.session.context.bars).toHaveLength(2);
        expect(result.session.bars.every(bar => bar.ts < input().revealedUntil)).toBe(true);
        expect(await readdir(f.directory)).toEqual([]);
        await expect(f.service.run(input(), { kind: 'session', sessionId: 'TEST|short|2025-01-01', contextBars: 0 })).rejects.toThrow();
    } finally { await f.service.dispose(); }
}, 15000);
it('exports all matching feature rows with outcome columns as real CSV and Parquet, without returning local paths', async () => {
    const f = await service();
    try {
        for (const format of ['csv', 'parquet'] as const) {
            const result = await f.service.run(input(), { kind: 'export', format });
            if (result.kind !== 'export') throw new Error('Wrong artifact');
            const data = Buffer.from(result.data, 'base64'); expect(result.rows).toBe(12); expect(result.bytes).toBe(data.length);
            expect(result.sha256).toBe(createHash('sha256').update(data).digest('hex'));
            if (format === 'csv') { expect(data.toString()).toContain('outcome_success'); expect(data.toString().trim().split('\n')).toHaveLength(13); }
            else expect(data.subarray(0, 4).toString()).toBe('PAR1');
            expect(result).not.toHaveProperty('path'); expect(await readdir(f.directory)).toEqual([]);
        }
    } finally { await f.service.dispose(); }
}, 15000);
it('rejects arbitrary export paths, coerced formats and unbounded session options before starting any job', () => {
    for (const op of [{ kind: 'export', format: ['csv'] }, { kind: 'export', format: 'csv', path: '../outside.csv' }, { kind: 'session', sessionId: 'x', contextBars: 241 }]) expect(() => artifactOperation(op)).toThrow();
});

it('terminates and drains a pending job before cancellation settles, and rearms for later work', async () => {
    let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void; const draining = new Promise<void>(resolve => { release = resolve; });
    const dispose = vi.fn(() => draining);
    const service = createStatsArtifactService(() => { started(); return { result: new Promise(() => {}), dispose }; });
    const abort = new AbortController(); let settled = false;
    const work = service.run(input(), { kind: 'export', format: 'csv' }, { signal: abort.signal }).finally(() => { settled = true; });
    const failure = expect(work).rejects.toMatchObject({ code: 'ABORTED' }); await began;
    await expect(service.run(input(), { kind: 'export', format: 'csv' })).rejects.toMatchObject({ code: 'BUSY' });
    abort.abort(); await Promise.resolve(); await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce(); expect(settled).toBe(false); release(); await failure;
    await service.dispose();
});

it('rejects forged exports and out-of-scope session payloads instead of exposing worker paths or unchecked candles', async () => {
    for (const value of [{ kind: 'export', format: 'csv', rows: 1, bytes: 1, data: 'eA==', sha256: 'bad' },
        { kind: 'export', format: 'csv', rows: 1, bytes: 1, data: 'eA==', sha256: createHash('sha256').update('x').digest('hex'), path: 'private' },
        { kind: 'session', session: { sessionId: 'other', bars: [] } }]) {
        const dispose = vi.fn(async () => {});
        const service = createStatsArtifactService(() => ({ result: Promise.resolve(value as never), dispose }));
        try { await expect(service.run(input(), value.kind === 'session' ? { kind: 'session', sessionId: 'selected', contextBars: 0 } : { kind: 'export', format: 'csv' })).rejects.toMatchObject({ code: 'INVALID_RESULT' }); expect(dispose).toHaveBeenCalledOnce(); }
        finally { await service.dispose(); }
    }
});

it('accepts a canonical SHA-correct four-MiB CSV within the declared export budget', async () => {
    const bytes = Buffer.from('value\n' + 'x'.repeat(4 * 1024 * 1024 - 7) + '\n');
    const result = { kind: 'export' as const, format: 'csv' as const, rows: 1, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') };
    const dispose = vi.fn(async () => {});
    const service = createStatsArtifactService(() => ({ result: Promise.resolve(result), dispose }));
    try {
        const response = await service.run(input(), { kind: 'export', format: 'csv' });
        expect(response.kind).toBe('export'); if (response.kind !== 'export') throw new Error('Wrong artifact');
        expect(response.sha256).toBe(result.sha256); expect(response.bytes).toBe(4 * 1024 * 1024);
        expect(Buffer.from(response.data, 'base64').equals(bytes)).toBe(true); expect(dispose).toHaveBeenCalledOnce();
    } finally { await service.dispose(); }
});

it.each(['Zh==', 'Zg=', 'Z g==', 'Zg!!'])('rejects noncanonical base64 %s even when its decoded-byte hash matches', async data => {
    const bytes = Buffer.from(data, 'base64'); const dispose = vi.fn(async () => {});
    const service = createStatsArtifactService(() => ({ result: Promise.resolve({ kind: 'export', format: 'csv', rows: 1, bytes: bytes.length,
        data, sha256: createHash('sha256').update(bytes).digest('hex') }), dispose }));
    try { await expect(service.run(input(), { kind: 'export', format: 'csv' })).rejects.toMatchObject({ code: 'INVALID_RESULT' }); expect(dispose).toHaveBeenCalledOnce(); }
    finally { await service.dispose(); }
});

it('serves session inspection and both export formats through authenticated HTTP with the exact source receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vela-stats-artifacts-')); directories.push(directory);
    const app = await createReplayServer({ dataDirectory: directory, port: 0, apiKey: '' });
    try {
        const origin = await app.listen(); const { token } = await (await fetch(origin + '/api/bootstrap')).json() as { token: string };
        const source = input(); const dataset = app.store.addDataset({ name: 'Synthetic artifact source', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars: [...source.bars] });
        const request = { datasetId: dataset.id, sourceMode: 'cache', from: dataset.start, until: dataset.end, session: source.session, calendar: null, query: source.query };
        const post = (path: string, body: unknown, auth = true) => fetch(origin + '/api/market-stats/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Local-Token': token } : {}) }, body: JSON.stringify(body) });
        expect((await post('session', { request, sessionId: 'NQM4|short|2024-01-03' }, false)).status).toBe(403);
        const detail = await post('session', { request, sessionId: 'NQM4|short|2024-01-03', contextBars: 0 });
        expect(detail.status).toBe(200); expect(await detail.json()).toMatchObject({ kind: 'session', selection: { datasetId: dataset.id, checksum: dataset.checksum, sourceMode: 'cache' }, session: { tradeDate: '2024-01-03', bars: expect.any(Array) } });
        const counted = await (await post('query', request)).json() as { result: { n: number } };
        expect(counted.result.n).toBe(9); // The configured future excludes three weekend dates.
        const exported = await post('export', { request, format: 'csv' }); expect(exported.status).toBe(200);
        expect(await exported.json()).toMatchObject({ kind: 'export', format: 'csv', rows: counted.result.n, selection: { until: dataset.end } });
        expect((await post('export', { request, format: 'csv', path: '../arbitrary.csv' })).status).toBe(400);
        expect(app.store.sessions()).toEqual([]);
    } finally { await app.close(); }
}, 15000);
