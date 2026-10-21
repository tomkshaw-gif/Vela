import type { Bar } from '../shared/types';
import { instrumentFor } from './data';
import { AppError } from './errors';

export interface CachedTicker { symbol: string; modifier: 'heikinashi' | null }

/** Decode the runtime's extended ticker without discarding unsupported requests. */
export function parseCachedTicker(value: string): CachedTicker {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\u0000-\u001f]/.test(value)) throw new AppError(400, 'Use one exact cached futures contract.');
    let base = value;
    let modifier: CachedTicker['modifier'] = null;
    const separator = base.lastIndexOf(';');
    if (separator !== -1) {
        const requested = base.slice(separator + 1).toLowerCase();
        if (!['standard', 'heikinashi'].includes(requested)) throw new AppError(400, 'This cached feed cannot construct the requested ticker chart type.', 'TICKER_MODIFIER_UNAVAILABLE');
        modifier = requested === 'heikinashi' ? requested : null;
        base = base.slice(0, separator);
    }
    if (base.startsWith('=')) {
        let encoded: unknown;
        try { encoded = JSON.parse(base.slice(1)); } catch { throw new AppError(400, 'Invalid encoded cached ticker.'); }
        if (!encoded || typeof encoded !== 'object' || Array.isArray(encoded)) throw new AppError(400, 'Invalid encoded cached ticker.');
        const fields = encoded as Record<string, unknown>;
        if (Object.keys(fields).some((key) => !['symbol', 'session'].includes(key)) || (fields.session !== undefined && fields.session !== 'extended')) {
            throw new AppError(400, 'This cached feed supports the full extended session without settlement or adjustment modifiers.', 'TICKER_MODIFIER_UNAVAILABLE');
        }
        if (typeof fields.symbol !== 'string') throw new AppError(400, 'Invalid encoded cached ticker symbol.');
        base = fields.symbol;
    }
    const match = /^(?:[A-Za-z0-9_.-]+:)?([A-Za-z0-9]+)$/.exec(base);
    if (!match) throw new AppError(400, 'Use one exact cached futures contract.');
    const symbol = match[1]!;
    instrumentFor(symbol);
    return { symbol, modifier };
}

/** Transform the complete cutoff-safe aggregated prefix before selecting its window. */
export function transformCachedBars(bars: Bar[], modifier: CachedTicker['modifier']): Bar[] {
    if (!modifier) return bars;
    let previous: Bar | undefined;
    return bars.map((bar) => {
        const close = (bar.open + bar.high + bar.low + bar.close) / 4;
        const open = previous ? (previous.open + previous.close) / 2 : (bar.open + bar.close) / 2;
        previous = { ...bar, open, close, high: Math.max(bar.high, open, close), low: Math.min(bar.low, open, close) };
        return previous;
    });
}
