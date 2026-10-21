import type { Bar, ChartView } from '../shared/types';
import type { LocalApi } from './api';
import { mergeBars } from './util';
import { toServerTimeframe } from '../shared/timeframes';

export const serverTimeframe = toServerTimeframe;

/** An incremental answer can fill its window before reaching the saved cursor. */
export async function revealedWindow(api: Pick<LocalApi, 'get'>, sessionId: string, timeframe: string,
    previous: readonly Bar[], signal: AbortSignal): Promise<{ bars: Bar[]; cursorTime: number | null }> {
    const query = new URLSearchParams({ timeframe: serverTimeframe(timeframe), limit: '5000' });
    const after = previous.at(-1)?.time;
    if (after !== undefined) query.set('after', String(after));
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/chart?`;
    let result = await api.get<ChartView>(path + query, signal);
    let prior = previous;
    if (after !== undefined && result.hasMore) {
        query.delete('after');
        result = await api.get<ChartView>(path + query, signal);
        prior = [];
    }
    return { bars: mergeBars(prior, result.bars.filter((bar) => result.cursorTime !== null && bar.time <= result.cursorTime)), cursorTime: result.cursorTime };
}
