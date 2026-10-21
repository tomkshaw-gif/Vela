// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mountEventComparison } from '../client/event-comparison';
import type { EventComparisonContext, EventComparisonRequest, EventComparisonResult } from '../shared/event-comparison';
import { pinEventComparison } from '../shared/event-comparison';
import { MARKET_STATS_SOURCE } from '../server/market-stats/contract';
import type { QueryResult } from '@luxalgo/edge-stats';

const BASE = Date.UTC(2024, 0, 2);
function fixture() {
    const context: EventComparisonContext = {
        request: { datasetId: 'fixture', sourceMode: 'cache', from: BASE, until: BASE + 180_000, eventCalendar: 'bundled',
            session: { key: 'short', start: '00:00', end: '00:03', tz: 'UTC', overnight: false }, calendar: null, query: { dsl: 'closeGreen' } },
        result: { source: MARKET_STATS_SOURCE, selection: { datasetId: 'fixture', name: 'Fixture', symbol: 'TEST', checksum: 'fixture', sourceMode: 'cache',
            from: BASE, until: BASE + 180_000, eventCalendar: 'bundled' }, coverage: { fingerprint: 'bars', revealedUntil: BASE + 180_000, inputBarCount: 3,
            eligibleBarCount: 3, excludedFutureBars: 0, firstBarOpen: BASE, lastBarClose: BASE + 180_000, calendarMode: 'schedule-only',
            events: { fingerprint: 'events', calendars: [{ event: 'LOCAL', version: 'test-v1', fingerprint: 'calendar', dates: 1, coverage: { from: '2024-01-02', to: '2024-01-02' } }] } },
            warnings: [], result: { sessions: [{ sessionId: 'TEST|short|2024-01-02', tradeDate: '2024-01-02', success: true, value: null }] } as QueryResult },
        calendars: [{ event: 'LOCAL', version: 'test-v1', sources: ['Synthetic'], coverage: { from: '2024-01-02', to: '2024-01-02' }, dates: ['2024-01-02'] }],
    };
    const result: EventComparisonResult = { pin: pinEventComparison(context.request, context.result),
        calendar: { ...context.calendars[0]!, fingerprint: 'calendar', timing: 'day-only' },
        sessions: [{ sessionId: 'TEST|short|2024-01-02', tradeDate: '2024-01-02', symbol: 'TEST', sessionKey: 'short', tz: 'UTC', contract: null,
            isRollDay: false, startTs: BASE, endTs: BASE + 180_000, firstBarOpen: BASE, lastBarClose: BASE + 180_000, barCount: 3,
            baseline: { kind: 'first-session-bar-open', price: 100, time: BASE, percentAvailable: true }, tickSize: 0.25,
            prices: { open: 100, close: 97, high: 108, low: 96 },
            range: { points: 12, ticks: 48, percent: 12 }, netChange: { points: -3, ticks: -12, percent: -3 },
            longMae: { points: 4, ticks: 16, percent: 4 }, longMfe: { points: 8, ticks: 32, percent: 8 },
            shortMae: { points: 8, ticks: 32, percent: 8 }, shortMfe: { points: 4, ticks: 16, percent: 4 },
            path: [{ time: BASE + 60_000, elapsedMinutes: 1, change: { points: 2, ticks: 8, percent: 2 } },
                { time: BASE + 120_000, elapsedMinutes: 2, change: { points: 5, ticks: 20, percent: 5 } },
                { time: BASE + 180_000, elapsedMinutes: 3, change: { points: -3, ticks: -12, percent: -3 } }] }],
        basis: 'First measured session-bar open; no pre-session context.', disclaimer: 'Day-session examples only; no release minute or probabilities.' };
    const host = document.createElement('div'); document.body.append(host);
    const compare = vi.fn(async (_input: EventComparisonRequest, _signal: AbortSignal) => structuredClone(result)); const view = mountEventComparison(host, { compare }); view.update(context);
    const choose = () => { const checkbox = host.querySelector<HTMLInputElement>('[data-event-session]')!; checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true })); };
    return { host, view, context, result, compare, choose };
}
afterEach(() => document.body.replaceChildren());
it('offers only covered exact matches, runs the selected day-session and shows an accessible overlay and unit summary', async () => {
    const f = fixture(); f.choose(); await f.view.run();
    expect(f.compare).toHaveBeenCalledWith(expect.objectContaining({ calendarEvent: 'LOCAL', sessionIds: ['TEST|short|2024-01-02'] }), expect.any(AbortSignal));
    expect(f.host.querySelector('svg[role="img"] path')).not.toBeNull();
    expect(f.host.textContent).toContain('12 points'); expect(f.host.textContent).toContain('-3 points');
    expect(f.host.textContent).toContain('Long MAE'); expect(f.host.textContent).toContain('no release minute');
    expect(f.host.querySelector('[data-event-status]')?.getAttribute('aria-live')).toBe('polite');
    expect(f.host.querySelector('[data-event-compare]')?.getAttribute('type')).toBe('button'); await f.view.destroy();
});
it('retains selections and the labeled last result across query/source/range invalidation', async () => {
    const f = fixture(); f.choose(); await f.view.run(); f.view.update(null);
    expect(f.host.querySelector<HTMLInputElement>('[data-event-session]')?.checked).toBe(true);
    expect(f.host.textContent).toContain('Last completed comparison'); expect(f.host.textContent).toContain('-3 points');
    const changed = structuredClone(f.context); changed.request.query.dsl = 'closeRed'; changed.request.until += 60_000;
    changed.result.selection.datasetId = 'new-source'; f.view.update(changed);
    expect(f.host.querySelector<HTMLInputElement>('[data-event-session]')?.checked).toBe(true);
    expect(f.host.textContent).toContain('Last completed comparison'); expect(f.host.textContent).toContain('closeGreen'); await f.view.destroy();
});
it('aborts on a newer context, keeps busy until drain, ignores the old completion and preserves the newer draft', async () => {
    const f = fixture(); f.choose(); await f.view.run();
    let release!: (value: EventComparisonResult) => void;
    f.compare.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = f.view.run(); const signal = f.compare.mock.calls.at(-1)![1] as AbortSignal;
    const changed = structuredClone(f.context); changed.request.query.dsl = 'closeRed'; f.view.update(changed);
    expect(signal.aborted).toBe(true); expect(f.host.querySelector<HTMLButtonElement>('[data-event-compare]')!.disabled).toBe(true);
    await f.view.run(); expect(f.compare).toHaveBeenCalledTimes(2);
    release({ ...f.result, basis: 'STALE COMPLETION' }); await pending;
    expect(f.host.textContent).not.toContain('STALE COMPLETION'); expect(f.host.textContent).toContain('-3 points');
    expect(f.host.querySelector<HTMLInputElement>('[data-event-session]')?.checked).toBe(true); await f.view.destroy();
});
it('cancels and awaits native drain before navigation or destruction settles', async () => {
    const f = fixture(); f.choose(); let release!: (value: EventComparisonResult) => void;
    f.compare.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = f.view.run(); const signal = f.compare.mock.calls[0]![1] as AbortSignal;
    let settled = false; const leaving = f.view.prepareToLeave().then(() => { settled = true; }); await Promise.resolve();
    expect(signal.aborted).toBe(true); expect(settled).toBe(false); release(f.result); await Promise.all([pending, leaving]);
    expect(settled).toBe(true); expect(f.host.textContent).not.toContain('12 points'); await f.view.destroy();
});
it('rejects stale or unmatched callback results while preserving the last completed comparison', async () => {
    const f = fixture(); f.choose(); await f.view.run();
    const stale = structuredClone(f.result); stale.pin.coverageFingerprint = 'stale'; stale.basis = 'FORGED'; f.compare.mockResolvedValue(stale);
    await f.view.run(); expect(f.host.textContent).not.toContain('FORGED'); expect(f.host.textContent).toContain('Last completed comparison');
    expect(f.host.textContent).toContain('receipt'); await f.view.destroy();
});
it('does not plot an unavailable tick series as a false zero baseline', async () => {
    const f = fixture(); f.result.sessions[0]!.tickSize = null;
    const session = f.result.sessions[0]!;
    for (const value of [session.range, session.netChange, session.longMae, session.longMfe, session.shortMae, session.shortMfe, ...session.path.map(point => point.change)]) value.ticks = null;
    const units = f.host.querySelector<HTMLSelectElement>('[data-event-units]')!; units.value = 'ticks'; units.dispatchEvent(new Event('change', { bubbles: true }));
    f.choose(); await f.view.run(); expect(f.host.querySelectorAll('svg path')).toHaveLength(0);
    expect(f.host.textContent).toContain('Ticks unavailable'); await f.view.destroy();
});
