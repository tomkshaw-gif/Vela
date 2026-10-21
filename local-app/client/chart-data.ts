import type { Bar, ChartView, SessionView } from '../shared/types';
import type { LocalApi } from './api';
import { mergeBars } from './util';
import { toServerTimeframe } from '../shared/timeframes';

export const serverTimeframe = toServerTimeframe;

export function replaySnapshot(view: SessionView): string {
    return JSON.stringify({ cursor: view.session.cursor, revision: view.session.revision,
        datasetId: view.dataset.id, checksum: view.dataset.checksum });
}

/** An incremental answer can fill its window before reaching the saved cursor. */
export async function revealedWindow(api: Pick<LocalApi, 'get'>, sessionId: string, timeframe: string,
    previous: readonly Bar[], signal: AbortSignal, view?: SessionView): Promise<{ bars: Bar[]; cursorTime: number | null }> {
    const query = new URLSearchParams({ timeframe: serverTimeframe(timeframe), limit: '5000' });
    if (view) {
        if (view.session.id !== sessionId) throw new Error('Chart snapshot belongs to another session.');
        query.set('snapshot', replaySnapshot(view));
    }
    const after = previous.at(-1)?.time;
    if (after !== undefined) query.set('after', String(after));
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/chart?`;
    let result = await api.get<ChartView>(path + query, signal);
    let prior = previous;
    if (after !== undefined && (result.hasMore || result.cursorTime !== null && after > result.cursorTime)) {
        query.delete('after');
        result = await api.get<ChartView>(path + query, signal);
        prior = [];
    }
    const revealed = (bar: Bar): boolean => result.cursorTime !== null && bar.time <= result.cursorTime;
    return { bars: mergeBars(prior.filter(revealed), result.bars.filter(revealed)), cursorTime: result.cursorTime };
}
