import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReplayServer } from '../server/index';
import type { HistoryJobSummary } from '../server/history-types';
import { DEFAULT_RULES, type Bar, type SessionView } from '../shared/types';

const apps: Awaited<ReturnType<typeof createReplayServer>>[] = [];
const directories: string[] = [];
afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'vela-history-routes-')); directories.push(directory);
    const transport = vi.fn(async () => { throw new Error('Unexpected provider request'); });
    const app = await createReplayServer({ dataDirectory: directory, port: 0, apiKey: 'synthetic-test-key', fetch: transport }); apps.push(app);
    const base = await app.listen(); const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json() as { token: string };
    const post = (path: string, input: unknown, token = bootstrap.token) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, body: JSON.stringify(input) });
    return { app, base, post, transport };
}
describe('continuous history HTTP boundary', () => {
    it('persists a bounded plan and lists progress without downloading or exposing file paths', async () => {
        const f = await fixture(); const input = { symbols: ['NQ.v.0', 'GC.v.0'], start: '2020-01-01T00:00:00.000Z', end: '2020-03-01T00:00:00.000Z' };
        const response = await f.post('/api/history', input); expect(response.status).toBe(201);
        const plan = await response.json() as HistoryJobSummary; expect(plan.totalChunks).toBe(4); expect(plan.rows).toBe(0);
        const list = await (await fetch(`${f.base}/api/history`)).json() as HistoryJobSummary[];
        expect(list.map(job => job.jobId)).toContain(plan.jobId);
        const status = await (await fetch(`${f.base}/api/history/${plan.jobId}`)).json(); expect(status).toEqual(plan);
        expect(JSON.stringify(status)).not.toMatch(/stagingDirectory|[A-Z]:\\/);
        expect(f.transport).not.toHaveBeenCalled(); expect(f.app.store.listDatasets()).toHaveLength(0);
    });
    it('requires local write authentication and strict route payloads before provider access', async () => {
        const f = await fixture();
        expect((await f.post('/api/history', {}, '0'.repeat(64))).status).toBe(403);
        expect((await f.post('/api/history?run=true', {})).status).toBe(400);
        expect((await f.post('/api/history/history-000000000000000000000000/run', { extra: true })).status).toBe(400);
        expect(f.transport).not.toHaveBeenCalled();
    });
    it('rejects import of incomplete staged history without changing datasets', async () => {
        const f = await fixture();
        const response = await f.post('/api/history', { symbols: ['GC.v.0'], start: '2020-01-01T00:00:00.000Z', end: '2020-02-01T00:00:00.000Z' });
        expect(response.status).toBe(201); const plan = await response.json() as HistoryJobSummary;
        const imported = await f.post(`/api/history/${plan.jobId}/import`, { symbol: 'GC.v.0' });
        expect(imported.status).toBe(409); expect(f.app.store.listDatasets()).toEqual([]);
    });
    it('runs commands with bounded global indices and rejects oversized time jumps before reading history', async () => {
        const f = await fixture(); const start = Date.UTC(2024, 0, 1);
        const bars = Array.from({ length: 5010 }, (_, index) => ({ time: start + index * 60000, open: 100, high: 100, low: 100, close: 100, volume: 1 }));
        const dataset = f.app.store.addDataset({ name: 'Synthetic bounded command fixture', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars });
        const created = await f.post('/api/sessions', { name: 'Bounded replay', datasetId: dataset.id, mode: 'practice', initialBalance: 50000,
            commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES });
        const view = await created.json() as SessionView; expect(created.status).toBe(200);
        const unbounded = vi.spyOn(f.app.store, 'readBars').mockImplementation(() => { throw new Error('Unbounded command read'); });
        const path = `/api/sessions/${view.session.id}/command`;
        expect((await f.post(path, { expectedRevision: 0, command: { type: 'advanceTo', time: bars[5000]!.time } })).status).toBe(400);
        const advanced = await f.post(path, { expectedRevision: 0, command: { type: 'advanceTo', time: bars[4999]!.time } });
        expect(advanced.status).toBe(200); expect((await advanced.json() as SessionView).session.cursor).toBe(4999);
        const final = await f.post(path, { expectedRevision: 1, command: { type: 'advanceTo', time: bars[5009]!.time + 86400000 } });
        expect(final.status).toBe(200); expect((await final.json() as SessionView).session.cursor).toBe(5009);
        expect(unbounded).not.toHaveBeenCalled();
    });
    it('retains continuous execution identity on creation and restart and fails closed on legacy export', async () => {
        const f = await fixture(); const start = Date.UTC(2024, 0, 1);
        async function* source(): AsyncGenerator<Bar> { for (let i = 0; i < 4; i++) yield { time: start + i * 60000, open: 2000, high: 2000, low: 2000, close: 2000, volume: 1, instrumentId: '100', contract: 'GCG4' }; }
        const dataset = await f.app.store.addHistoryDataset({ name: 'Synthetic GC continuous', symbol: 'GC.v.0', expectedRows: 4, scope: 'synthetic', bars: source(),
            provenance: { stypeIn: 'continuous', rollRule: 'volume', rank: 0, adjustment: 'none', rollPolicy: 'flatten-prior-close', requestedStart: new Date(start).toISOString(), requestedEnd: new Date(start + 4 * 60000).toISOString(), manifestHash: 'a'.repeat(64) } });
        const created = await f.post('/api/sessions', { name: 'Continuous replay', datasetId: dataset.id, mode: 'practice', initialBalance: 50000,
            commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES });
        const view = await created.json() as SessionView; expect(created.status).toBe(200); expect(view.session.executionVersion).toBe(3);
        const restarted = await f.post(`/api/sessions/${view.session.id}/clone`, { restart: true });
        expect(restarted.status).toBe(200); expect((await restarted.json() as SessionView).session.executionVersion).toBe(3);
        const exported = await fetch(`${f.base}/api/sessions/${view.session.id}/export`);
        expect(exported.status).toBe(413); expect(await exported.json()).toMatchObject({ code: 'HISTORY_EXPORT_TOO_LARGE' });
        expect(f.app.store.dataset(dataset.id).continuous?.segments[0]?.contract).toBe('GCG4');
    });
});
