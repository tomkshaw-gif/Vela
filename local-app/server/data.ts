import { createHash } from 'node:crypto';
import { INSTRUMENTS } from '../shared/types';
import type { Bar, Instrument, Schema } from '../shared/types';
import { AppError, requireObject, text } from './errors';

export const MAX_BARS = 250_000;
export const MAX_DATA_BYTES = 48 * 1024 * 1024;
export function interval(schema: unknown): number {
    if (schema === 'ohlcv-1m') return 60_000;
    if (schema === 'ohlcv-1s') return 1000;
    throw new AppError(400, 'Supported schemas are ohlcv-1m and ohlcv-1s.');
}
export function instrumentFor(symbol: unknown): Instrument {
    if (typeof symbol !== 'string' || !/^(MNQ|MES|NQ|ES|GC)[FGHJKMNQUVXZ]\d{1,4}$/.test(symbol)) throw new AppError(400, 'Use one exact NQ, MNQ, ES, MES or GC raw futures contract.');
    const root = /^(MNQ|MES|NQ|ES|GC)/.exec(symbol)?.[1];
    const value = INSTRUMENTS.find(item => item.root === root);
    if (!value) throw new AppError(400, 'Unsupported contract.');
    return { ...value };
}
export function epochMilliseconds(value: unknown): number {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) throw new AppError(400, 'Timestamp must be an exact integer.');
        // Public bars use epoch milliseconds. Databento nanoseconds must be strings.
        if (value < 0 || value > 8_640_000_000_000_000) throw new AppError(400, 'Invalid timestamp.');
        return value;
    }
    if (typeof value !== 'string') throw new AppError(400, 'Missing timestamp.');
    if (/^\d{16,20}$/.test(value)) {
        const ns = BigInt(value);
        if (ns % 1_000_000n !== 0n) throw new AppError(400, 'Bar timestamp has sub-millisecond precision.');
        const ms = Number(ns / 1_000_000n);
        if (!Number.isSafeInteger(ms)) throw new AppError(400, 'Invalid timestamp.');
        return ms;
    }
    if (/^\d{10,15}$/.test(value)) return epochMilliseconds(Number(value));
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) throw new AppError(400, 'Use UTC ISO timestamps ending in Z or epoch milliseconds.');
    const fractional = /\.(\d+)Z$/.exec(value)?.[1] ?? '';
    if (fractional.slice(3).replace(/0/g, '')) throw new AppError(400, 'Bar timestamp has sub-millisecond precision.');
    const ms = Date.parse(value);
    if (!Number.isSafeInteger(ms) || ms < 0) throw new AppError(400, 'Invalid timestamp.');
    if (new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new AppError(400, 'Invalid calendar timestamp.');
    return ms;
}
function numeric(value: unknown, label: string): number {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))) throw new AppError(400, `Invalid ${label}.`);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new AppError(400, `Invalid ${label}.`);
    return parsed;
}
export function validateBars(input: unknown, schema: Schema, symbol: string, range?: { start: number; end: number }): Bar[] {
    const granularity = interval(schema);
    const inst = instrumentFor(symbol);
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_BARS) throw new AppError(400, `Dataset must contain 1-${MAX_BARS} bars.`);
    let previous = -1;
    let instrumentId: string | undefined;
    return input.map(raw => {
        const row = requireObject(raw);
        const hd = row.hd && typeof row.hd === 'object' ? requireObject(row.hd) : {};
        if (row.symbol !== undefined && row.symbol !== symbol) throw new AppError(400, 'Dataset contains another contract.');
        if (hd.instrument_id !== undefined) {
            const current = String(hd.instrument_id);
            if (!/^\d+$/.test(current) || (instrumentId !== undefined && instrumentId !== current)) throw new AppError(400, 'Dataset contains multiple or invalid instrument IDs.');
            instrumentId = current;
        }
        const time = epochMilliseconds(row.time ?? row.ts_event ?? hd.ts_event);
        if (time <= previous || time % granularity !== 0) throw new AppError(400, 'Bar times must be unique, sorted and aligned to the native schema.');
        if (range && (time < range.start || time >= range.end)) throw new AppError(400, 'Provider returned data outside the requested range.');
        previous = time;
        // Raw Databento JSONL identifies nanosecond record times in its header and
        // integer prices in nanodollars. Bare public bars always use price units.
        const rawFixed = row.time === undefined && typeof hd.ts_event === 'string' && /^\d{16,20}$/.test(hd.ts_event)
            && [row.open, row.high, row.low, row.close].every(value => (typeof value === 'string' && /^\d+$/.test(value)) || (typeof value === 'number' && Number.isSafeInteger(value)));
        const price = (value: unknown, label: string): number => {
            if (!rawFixed) return numeric(value, label);
            const nano = BigInt(String(value));
            const nanoTick = BigInt(Math.round(inst.tickSize * 1_000_000_000));
            if (nano % nanoTick !== 0n || nano <= 0n || nano > 10_000_000_000_000_000n) throw new AppError(400, 'Raw fixed prices must be exact positive contract ticks.');
            return Number(nano / nanoTick) * inst.tickSize;
        };
        const open = price(row.open, 'open'); const high = price(row.high, 'high');
        const low = price(row.low, 'low'); const close = price(row.close, 'close'); const volume = numeric(row.volume, 'volume');
        if (low <= 0 || high > 10_000_000 || high < Math.max(open, close, low) || low > Math.min(open, close) || volume < 0 || !Number.isSafeInteger(volume)) throw new AppError(400, 'Invalid OHLC or volume.');
        for (const price of [open, high, low, close]) if (Math.abs(price / inst.tickSize - Math.round(price / inst.tickSize)) > 1e-7) throw new AppError(400, 'Price is not aligned to the contract tick size.');
        return { time, open, high, low, close, volume };
    });
}
export function continuousInstrument(symbol: unknown): Instrument {
    if (symbol !== 'NQ.v.0' && symbol !== 'GC.v.0') throw new AppError(400, 'Use canonical NQ.v.0 or GC.v.0 volume-ranked front month.', 'INVALID_CONTINUOUS_SYMBOL');
    return { ...INSTRUMENTS.find(instrument => instrument.root === symbol.slice(0, 2))! };
}
export function parseContinuousBar(raw: unknown, symbol: string, range: { start: number; end: number }): Bar & { instrumentId: string; contract: string } {
    const instrument = continuousInstrument(symbol); const row = requireObject(raw); const hd = requireObject(row.hd);
    const contract = row.symbol; const contractInstrument = instrumentFor(contract);
    if (contractInstrument.root !== instrument.root) throw new AppError(400, 'Continuous data contains an unrelated futures contract.', 'INVALID_DATA');
    const instrumentId = String(hd.instrument_id);
    if (!/^[1-9]\d{0,9}$/.test(instrumentId) || Number(instrumentId) > 0xffff_ffff) throw new AppError(400, 'Continuous data must retain the actual instrument identity.', 'INVALID_DATA');
    const bar = validateBars([row], 'ohlcv-1m', contract as string, range)[0]!;
    return { ...bar, instrumentId, contract: contract as string };
}
export function parseImport(input: unknown): { name: string; symbol: string; schema: Schema; bars: Bar[] } {
    const obj = requireObject(input); const symbol = text(obj.symbol, 'symbol', 16); instrumentFor(symbol);
    interval(obj.schema); const schema = obj.schema as Schema;
    if (typeof obj.text !== 'string' || Buffer.byteLength(obj.text) > MAX_DATA_BYTES) throw new AppError(413, 'Import is too large.');
    let rows: unknown[];
    const lines = obj.text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    if (lines.length > MAX_BARS + 1) throw new AppError(413, 'Import contains too many bars.');
    if (obj.format === 'jsonl') {
        try { rows = lines.map(line => JSON.parse(line)); } catch { throw new AppError(400, 'Invalid JSONL.'); }
    } else if (obj.format === 'csv') {
        const headers = (lines.shift() ?? '').split(',').map(item => item.trim());
        if (headers.join(',') !== 'time,open,high,low,close,volume' && headers.join(',') !== 'ts_event,open,high,low,close,volume') throw new AppError(400, 'CSV header must be time,open,high,low,close,volume.');
        rows = lines.map(line => {
            const cells = line.split(',').map(cell => cell.trim().replace(/^"(.*)"$/, '$1'));
            if (cells.length !== headers.length) throw new AppError(400, 'Invalid CSV row.');
            return Object.fromEntries(headers.map((key, index) => [key, cells[index]]));
        });
    } else throw new AppError(400, 'Import format must be csv or jsonl.');
    return { name: obj.name === undefined ? `${symbol} imported` : text(obj.name, 'name'), symbol, schema, bars: validateBars(rows, schema, symbol) };
}
export function checksum(bars: Bar[]): string { return createHash('sha256').update(JSON.stringify(bars)).digest('hex'); }
export function demoBars(): Bar[] {
    const bars: Bar[] = []; let close = 20_000; const start = Date.UTC(2024, 0, 2, 14, 30);
    let seed = 5197;
    for (let i = 0; i < 10_000; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const open = close; close = open + ((seed % 25) - 12) * 0.25;
        bars.push({ time: start + i * 60_000, open, high: Math.max(open, close) + ((seed >>> 8) % 8) * 0.25, low: Math.min(open, close) - ((seed >>> 12) % 8) * 0.25, close, volume: 50 + seed % 1200 });
    }
    return bars;
}
