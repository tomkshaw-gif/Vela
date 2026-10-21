import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReplayServer } from '../server/index';
import { DEFAULT_RULES } from '../shared/types';
import type { Bar, DatasetMeta, Session, SessionView } from '../shared/types';

it('exports and restores a complete 250000-bar saved attempt through the real HTTP import route', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vela-capacity-test-'));
    const app = await createReplayServer({ dataDirectory: directory, port: 0, apiKey: 'capacity-test-only-no-provider' });
    try {
        const source: Bar[] = Array.from({ length: 250_000 }, (_, i) => {
            const open = 20000 + (i % 100) * 0.25;
            return { time: Date.UTC(2024, 5, 3, 13, 30) + i * 1000, open, high: open + 0.5, low: open - 0.25, close: open + 0.25, volume: 1 + (i % 1000) };
        });
        const dataset = app.store.addDataset({ name: 'Maximum import capacity fixture', symbol: 'NQM4', schema: 'ohlcv-1s', source: 'csv', bars: source });
        const url = await app.listen();
        const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json() as { token: string };
        const send = (path: string, value: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': bootstrap.token }, body: JSON.stringify(value) });
        const createdResponse = await send('/api/sessions', { name: 'Maximum capacity attempt', datasetId: dataset.id, mode: 'practice', initialBalance: 50000, commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 124_999, rules: DEFAULT_RULES });
        expect(createdResponse.status).toBe(200); const created = await createdResponse.json() as SessionView;
        const advance = await send(`/api/sessions/${created.session.id}/command`, { expectedRevision: 0, command: { type: 'advance', count: 5000 } });
        expect(advance.status).toBe(200); const saved = await advance.json() as SessionView;
        const exportedResponse = await fetch(`${url}/api/sessions/${saved.session.id}/export`);
        expect(exportedResponse.status).toBe(200); const compactBackup = await exportedResponse.text();
        expect(Buffer.byteLength(compactBackup)).toBeLessThan(64 * 1024 * 1024);
        const backup = JSON.parse(compactBackup) as { version: number; session: Session; dataset: DatasetMeta; bars: Bar[] };
        expect(backup.bars).toHaveLength(250_000); expect(backup.bars[0]).toEqual(source[0]); expect(backup.bars.at(-1)).toEqual(source.at(-1));
        expect(backup.session.cursor).toBe(saved.session.cursor); expect(backup.dataset.checksum).toBe(dataset.checksum);
        const importedResponse = await fetch(`${url}/api/sessions/import`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': bootstrap.token }, body: compactBackup });
        expect(importedResponse.status).toBe(200); const restored = await importedResponse.json() as SessionView;
        expect(restored.session.id).not.toBe(saved.session.id); expect(restored.session.cursor).toBe(saved.session.cursor);
        expect(restored.session.account).toEqual(saved.session.account); expect(restored.dataset.checksum).toBe(dataset.checksum);
        expect(restored.dataset.barCount).toBe(250_000); expect(app.store.readBars(restored.dataset.id)).toEqual(source);
        const original = await (await fetch(`${url}/api/sessions/${saved.session.id}`)).json() as SessionView;
        expect(original.session).toEqual(saved.session);
    } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30_000);
