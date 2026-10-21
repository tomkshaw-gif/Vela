import { randomUUID } from 'node:crypto';
import type { DatasetMeta, ProviderQuote, ProviderRequest } from '../shared/types';
import { continuousInstrument, epochMilliseconds, instrumentFor, interval, MAX_BARS, MAX_DATA_BYTES, validateBars } from './data';
import { AppError, requireObject } from './errors';
import type { ReplayStore } from './store';

const HOST = 'https://hist.databento.com';
const TTL = 120_000;
let downloadActive = false;
export type FetchFunction = typeof fetch;
/** A continuous-history range can reach the data endpoint only after its own fresh $0 quote. */
export class DatabentoHistoryClient {
    constructor(private key: () => string | undefined, private fetcher: FetchFunction = fetch) {}
    async downloadMonth<T>(request: import('./history-types').HistoryScope, consume: (response: Response, mappings: import('./history-types').HistoryMapping[], quote: { quotedAt: string; costUsd: 0 }) => Promise<T>, signal?: AbortSignal): Promise<T> {
        const frozen = Object.freeze({ ...request });
        continuousInstrument(frozen.symbols);
        if (frozen.dataset !== 'GLBX.MDP3' || frozen.schema !== 'ohlcv-1m' || frozen.stype_in !== 'continuous'
            || !Number.isFinite(Date.parse(frozen.start)) || !Number.isFinite(Date.parse(frozen.end)) || Date.parse(frozen.end) <= Date.parse(frozen.start)
            || Date.parse(frozen.end) - Date.parse(frozen.start) > 31 * 86_400_000) throw new AppError(400, 'Invalid frozen monthly history scope.');
        const base = new URLSearchParams(frozen);
        const key = this.key(); if (!key) throw new AppError(400, 'Configure a Databento key first.', 'KEY_REQUIRED');
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 120_000);
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const headers = { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` };
        try {
            const startDate = frozen.start.slice(0, 10); const endDate = new Date(Math.ceil(Date.parse(frozen.end) / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
            const mapping = async (symbols: string, stypeIn: string, stypeOut: string) => {
                const params = new URLSearchParams({ dataset: frozen.dataset, symbols, stype_in: stypeIn, stype_out: stypeOut, start_date: startDate, end_date: endDate });
                const response = await this.fetcher(`${HOST}/v0/symbology.resolve?${params}`, { headers, signal: combined, redirect: 'error' });
                if (!response.ok) { await response.body?.cancel(); throw new AppError(502, 'Databento rejected history symbol resolution.', response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED'); }
                let value: Record<string, unknown>; try { value = requireObject(JSON.parse(await boundedText(response, 262_144))); } catch { throw new AppError(502, 'History symbol resolution is invalid.', 'INVALID_MAPPING'); }
                if (![0, 1].includes(value.status as number) || value.stype_in !== stypeIn || value.stype_out !== stypeOut || !value.result || typeof value.result !== 'object' || Array.isArray(value.result)) throw new AppError(502, 'History symbol resolution is invalid.', 'INVALID_MAPPING');
                return value.result as Record<string, { d0: string; d1: string; s: string }[]>;
            };
            // The provider supports continuous -> instrument_id, then instrument_id -> raw_symbol.
            // A continuous -> raw_symbol request is explicitly unsupported.
            const ids = (await mapping(frozen.symbols, 'continuous', 'instrument_id'))[frozen.symbols];
            if (!Array.isArray(ids) || ids.length < 1 || ids.length > 64 || ids.some(row => !/^[1-9]\d{0,9}$/.test(row.s))) throw new AppError(502, 'Continuous history has no bounded instrument mapping.', 'INVALID_MAPPING');
            const raw = await mapping([...new Set(ids.map(row => row.s))].join(','), 'instrument_id', 'raw_symbol');
            const mappings: import('./history-types').HistoryMapping[] = [];
            const date = (value: string) => {
                const time = Date.parse(value); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new AppError(502, 'Invalid history mapping dates.', 'INVALID_MAPPING'); return time;
            };
            for (const id of ids) {
                const names = raw[id.s]; if (!Array.isArray(names) || names.length > 64) throw new AppError(502, 'History raw-contract mapping is missing.', 'INVALID_MAPPING');
                for (const name of names) {
                    const start = Math.max(date(id.d0), date(name.d0), Date.parse(frozen.start));
                    const end = Math.min(date(id.d1), date(name.d1), Date.parse(frozen.end));
                    // Instrument IDs may be reused after their continuous selection ends.
                    if (end <= start) continue;
                    if (instrumentFor(name.s).root !== frozen.symbols.slice(0, 2)) throw new AppError(502, 'History maps to another futures root.', 'INVALID_MAPPING');
                    mappings.push({ instrumentId: id.s, contract: name.s, start, end });
                }
            }
            if (mappings.length === 0 || mappings.length > 256) throw new AppError(502, 'History instrument mappings are incomplete.', 'INVALID_MAPPING');
            const quote = await this.fetcher(`${HOST}/v0/metadata.get_cost?${base}`, { headers, signal: combined, redirect: 'error' });
            if (!quote.ok) { await quote.body?.cancel(); throw new AppError(502, 'Databento rejected the history quote.', quote.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED'); }
            let cost: unknown;
            try { cost = JSON.parse(await boundedText(quote, 16_384)); } catch (error) { if (error instanceof AppError) throw error; throw new AppError(502, 'Databento returned an invalid history quote.', 'INVALID_QUOTE'); }
            if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw new AppError(502, 'Databento returned an invalid history quote.', 'INVALID_QUOTE');
            if (cost !== 0) throw new AppError(400, 'History acquisition stopped: this exact monthly request is not free. The budget is $0.', 'ZERO_BUDGET');
            const receipt = { quotedAt: new Date().toISOString(), costUsd: 0 as const };
            if (combined.aborted) throw new AppError(400, 'History acquisition was cancelled.', 'ABORTED');
            // Encoding/symbology output settings do not widen the freshly quoted billable scope.
            const parameters = new URLSearchParams(base);
            parameters.set('encoding', 'json'); parameters.set('compression', 'none'); parameters.set('pretty_px', 'false'); parameters.set('pretty_ts', 'false');
            parameters.set('stype_out', 'instrument_id'); parameters.set('map_symbols', 'false');
            const response = await this.fetcher(`${HOST}/v0/timeseries.get_range`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: parameters.toString(), signal: combined, redirect: 'error' });
            if (!response.ok) { await response.body?.cancel(); throw new AppError(502, 'Databento rejected the history range.', response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED'); }
            return await consume(response, mappings, receipt);
        } catch (error) {
            if (combined.aborted) throw new AppError(400, 'History acquisition was cancelled or timed out.', signal?.aborted ? 'ABORTED' : 'PROVIDER_TIMEOUT');
            if (error instanceof AppError) throw error;
            throw new AppError(502, 'Databento history acquisition failed.', 'PROVIDER_UNAVAILABLE');
        } finally { clearTimeout(timer); }
    }
}
export function validateProviderRequest(input: unknown): ProviderRequest {
    const obj = requireObject(input);
    if (Object.keys(obj).some(key => !['dataset', 'symbol', 'schema', 'start', 'end'].includes(key)) || obj.dataset !== 'GLBX.MDP3') throw new AppError(400, 'Only GLBX.MDP3 raw futures requests are supported.');
    instrumentFor(obj.symbol); const granularity = interval(obj.schema);
    if (typeof obj.start !== 'string' || typeof obj.end !== 'string' || !obj.start.endsWith('Z') || !obj.end.endsWith('Z')) throw new AppError(400, 'Provider dates must be explicit UTC timestamps ending in Z.');
    const start = epochMilliseconds(obj.start); const end = epochMilliseconds(obj.end);
    const maxDays = granularity === 1000 ? 2 : 31;
    if (end <= start || end - start > maxDays * 86_400_000 || start % granularity !== 0 || end % granularity !== 0 || (end - start) / granularity > MAX_BARS) throw new AppError(400, `Use an aligned range of at most ${maxDays} days.`);
    return { dataset: 'GLBX.MDP3', symbol: obj.symbol as string, schema: obj.schema as ProviderRequest['schema'], start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
function parameters(request: ProviderRequest): URLSearchParams {
    return new URLSearchParams({ dataset: request.dataset, symbols: request.symbol, schema: request.schema, stype_in: 'raw_symbol', start: request.start, end: request.end });
}
async function boundedText(response: Response, maxBytes: number): Promise<string> {
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { await response.body?.cancel(); throw new AppError(413, 'Provider response exceeds the local limit.'); }
    if (!response.body) throw new AppError(502, 'Provider returned no data.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
        for (;;) {
            const part = await reader.read(); if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > maxBytes) { await reader.cancel(); throw new AppError(413, 'Provider response exceeds the local limit.'); }
            chunks.push(part.value);
        }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, bytes).toString('utf8');
}
export class DatabentoProvider {
    private tickets = new Map<string, ProviderQuote>();
    constructor(private store: ReplayStore, private key: () => string | undefined, private fetcher: FetchFunction = fetch) {}
    private async perform(path: string, params: URLSearchParams, timeout: number, maxBytes: number): Promise<string> {
        const key = this.key(); if (!key) throw new AppError(400, 'Configure a Databento key first.', 'KEY_REQUIRED');
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const isQuote = path === '/v0/metadata.get_cost';
            const response = await this.fetcher(`${HOST}${path}${isQuote ? `?${params}` : ''}`, { method: isQuote ? 'GET' : 'POST', headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, ...(isQuote ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) }, body: isQuote ? undefined : params.toString(), signal: controller.signal, redirect: 'error' });
            if (!response.ok) { await response.body?.cancel(); throw new AppError(502, 'Databento rejected the request. Check your key, entitlement and date range.', 'PROVIDER_REJECTED'); }
            return await boundedText(response, maxBytes);
        } catch (error) {
            if (error instanceof AppError) throw error;
            throw new AppError(502, 'Databento request failed or timed out.', 'PROVIDER_UNAVAILABLE');
        } finally { clearTimeout(timer); }
    }
    private async zeroCost(request: ProviderRequest): Promise<void> {
        const response = await this.perform('/v0/metadata.get_cost', parameters(request), 10_000, 16_384);
        let cost: unknown;
        try { cost = JSON.parse(response); } catch { throw new AppError(502, 'Databento returned an invalid cost.', 'INVALID_QUOTE'); }
        if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw new AppError(502, 'Databento returned an invalid cost.', 'INVALID_QUOTE');
        if (cost !== 0) throw new AppError(400, 'This request is not free. The local download budget is $0.', 'ZERO_BUDGET');
    }
    async quote(input: unknown): Promise<ProviderQuote> {
        const request = validateProviderRequest(input);
        for (const [id, ticket] of this.tickets) if (Date.parse(ticket.expiresAt) <= Date.now()) this.tickets.delete(id);
        if (this.tickets.size >= 64) throw new AppError(429, 'Too many pending quotes. Wait for older quotes to expire.');
        await this.zeroCost(request);
        const ticket: ProviderQuote = { quoteId: randomUUID(), estimatedCostUsd: 0, maxCostUsd: 0, expiresAt: new Date(Date.now() + TTL).toISOString(), request };
        this.tickets.set(ticket.quoteId, ticket); return structuredClone(ticket);
    }
    async download(quoteId: unknown): Promise<DatasetMeta> {
        if (typeof quoteId !== 'string') throw new AppError(400, 'A quote ID is required.');
        const ticket = this.tickets.get(quoteId);
        if (!ticket || Date.parse(ticket.expiresAt) <= Date.now()) { this.tickets.delete(quoteId); throw new AppError(400, 'Quote expired. Request a new estimate.', 'QUOTE_EXPIRED'); }
        if (downloadActive) throw new AppError(409, 'Another download is in progress.', 'DOWNLOAD_ACTIVE');
        this.tickets.delete(quoteId); downloadActive = true;
        try {
            const cached = this.store.datasetForScope(JSON.stringify(ticket.request));
            if (cached) return cached;
            // Recheck the same frozen scope immediately before the billable endpoint.
            // The historical API has no atomic server-side billing cap.
            await this.zeroCost(ticket.request);
            const params = parameters(ticket.request);
            params.set('encoding', 'json'); params.set('compression', 'none'); params.set('pretty_px', 'true'); params.set('pretty_ts', 'true'); params.set('map_symbols', 'true');
            const raw = await this.perform('/v0/timeseries.get_range', params, 30_000, MAX_DATA_BYTES);
            const lines = raw.trim().split(/\r?\n/);
            if (lines.length > MAX_BARS) throw new AppError(413, 'Provider response contains too many bars.');
            let rows: unknown[];
            try { rows = lines.map(line => JSON.parse(line)); } catch { throw new AppError(502, 'Provider returned invalid JSONL.', 'INVALID_DATA'); }
            const bars = validateBars(rows, ticket.request.schema, ticket.request.symbol, { start: Date.parse(ticket.request.start), end: Date.parse(ticket.request.end) });
            return this.store.addDataset({ name: `${ticket.request.symbol} ${ticket.request.start.slice(0, 10)}`, symbol: ticket.request.symbol, schema: ticket.request.schema, source: 'databento', bars, scope: JSON.stringify(ticket.request) });
        } finally { downloadActive = false; }
    }
}
