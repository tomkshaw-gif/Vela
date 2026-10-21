import { randomUUID } from 'node:crypto';
import type { DatasetMeta, ProviderQuote, ProviderRequest } from '../shared/types';
import { epochMilliseconds, instrumentFor, interval, MAX_BARS, MAX_DATA_BYTES, validateBars } from './data';
import { AppError, requireObject } from './errors';
import type { ReplayStore } from './store';

const HOST = 'https://hist.databento.com';
const TTL = 120_000;
let downloadActive = false;
export type FetchFunction = typeof fetch;
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
