import { describe, expect, it, vi } from 'vitest';
import { DatabentoHistoryClient, type FetchFunction } from '../server/provider';
import type { HistoryMapping, HistoryScope } from '../server/history';

const scope: HistoryScope = { dataset: 'GLBX.MDP3', symbols: 'NQ.v.0', schema: 'ohlcv-1m', stype_in: 'continuous', start: '2022-03-01T00:00:00.000Z', end: '2022-04-01T00:00:00.000Z' };
type MappingRow = { d0: string; d1: string; s: string };
// Public symbology.resolve metadata: instrument 3541 is reused after its
// NQ.v.0 selection ends. No market bars or account data are in this fixture.
const selected: MappingRow[] = [
    { d0: '2022-03-01', d1: '2022-03-16', s: '3541' },
    { d0: '2022-03-16', d1: '2022-04-01', s: '2895' },
];
const raw = (): Record<string, MappingRow[]> => ({
    '3541': [
        { d0: '2022-03-01', d1: '2022-03-22', s: 'NQH2' },
        { d0: '2022-03-22', d1: '2022-04-01', s: 'NOI:SA 05D 18J2' },
    ],
    '2895': [{ d0: '2022-03-01', d1: '2022-04-01', s: 'NQM2' }],
});
function fixture(names = raw()) {
    const calls: { path: string; parameters: URLSearchParams }[] = [];
    const fetcher = vi.fn<FetchFunction>(async (url, init) => {
        const endpoint = new URL(String(url)); const parameters = init?.method === 'POST' ? new URLSearchParams(String(init.body)) : endpoint.searchParams;
        calls.push({ path: endpoint.pathname, parameters: new URLSearchParams(parameters) });
        if (endpoint.pathname === '/v0/symbology.resolve') {
            const continuous = parameters.get('stype_in') === 'continuous';
            return new Response(JSON.stringify({ status: 0, stype_in: continuous ? 'continuous' : 'instrument_id', stype_out: continuous ? 'instrument_id' : 'raw_symbol', result: continuous ? { 'NQ.v.0': selected } : names }));
        }
        if (endpoint.pathname === '/v0/metadata.get_cost') return new Response('0');
        if (endpoint.pathname === '/v0/timeseries.get_range') return new Response('');
        throw new Error('Unexpected provider endpoint in fixture.');
    });
    return { client: new DatabentoHistoryClient(() => 'synthetic-key', fetcher), calls };
}

describe('dated continuous raw-contract mapping intersections', () => {
    it('excludes post-selection ID reuse and preserves the actual March 2022 NQ contract intervals', async () => {
        const remote = fixture();
        const mappings = await remote.client.downloadMonth(scope, async (response, mappings, quote) => { await response.body?.cancel(); expect(quote.costUsd).toBe(0); return mappings; });
        expect(mappings).toEqual([
            { instrumentId: '3541', contract: 'NQH2', start: Date.parse('2022-03-01'), end: Date.parse('2022-03-16') },
            { instrumentId: '2895', contract: 'NQM2', start: Date.parse('2022-03-16'), end: Date.parse('2022-04-01') },
        ] satisfies HistoryMapping[]);
        expect(remote.calls.map(call => call.path)).toEqual(['/v0/symbology.resolve', '/v0/symbology.resolve', '/v0/metadata.get_cost', '/v0/timeseries.get_range']);
        for (const call of remote.calls.slice(0, 2)) {
            expect(call.parameters.get('start_date')).toBe('2022-03-01'); expect(call.parameters.get('end_date')).toBe('2022-04-01');
        }
        expect(remote.calls[1]!.parameters.get('symbols')).toBe('3541,2895');
        for (const [key, value] of Object.entries(scope)) {
            expect(remote.calls[2]!.parameters.get(key)).toBe(value); expect(remote.calls[3]!.parameters.get(key)).toBe(value);
        }
    });

    it.each(['NOI:SA 05D 18J2', 'NQH2-NQM2', 'ESH2', 'NQ.v.0', undefined])('rejects selected unsupported or unrelated raw identity %s before quote or range', async symbol => {
        const names = raw(); names['3541']![0]!.s = symbol as string;
        const remote = fixture(names); const consume = vi.fn();
        await expect(remote.client.downloadMonth(scope, consume)).rejects.toThrow();
        expect(consume).not.toHaveBeenCalled(); expect(remote.calls.map(call => call.path)).toEqual(['/v0/symbology.resolve', '/v0/symbology.resolve']);
    });

    it('still validates mapping dates before excluding a nonselected raw interval', async () => {
        const names = raw(); names['3541']![1]!.d0 = '2022-02-30';
        const remote = fixture(names);
        await expect(remote.client.downloadMonth(scope, async () => undefined)).rejects.toMatchObject({ code: 'INVALID_MAPPING' });
        expect(remote.calls.map(call => call.path)).toEqual(['/v0/symbology.resolve', '/v0/symbology.resolve']);
    });
});
