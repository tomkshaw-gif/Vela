import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplayAnalyticsRefresh } from '../client/replay-analytics';
import type { Analytics } from '../shared/types';

afterEach(() => { vi.useRealTimers(); });
function fixture() {
    vi.useFakeTimers();
    let target = { sessionId: 'synthetic-one', version: 1 };
    let enabled = true, mutationBusy = false;
    const jobs: { signal: AbortSignal; resolve(value: Analytics): void }[] = [];
    const apply = vi.fn(), onError = vi.fn();
    const load = vi.fn((_target: unknown, signal: AbortSignal) => new Promise<Analytics>(resolve => { jobs.push({ signal, resolve }); }));
    const refresh = new ReplayAnalyticsRefresh({ target: () => mutationBusy ? null : target, enabled: () => enabled && !mutationBusy, load, apply, onError });
    return { refresh, load, jobs, apply, onError, target: (value: typeof target) => { target = value; },
        enabled: (value: boolean) => { enabled = value; }, mutationBusy: (value: boolean) => { mutationBusy = value; } };
}
describe('live replay analytics', () => {
    it('coalesces rapid ledger changes and rejects an obsolete response', async () => {
        const f = fixture(); f.refresh.invalidate(); await vi.advanceTimersByTimeAsync(0); expect(f.load).toHaveBeenCalledTimes(1);
        for (let version = 2; version < 20; version++) { f.target({ sessionId: 'synthetic-one', version }); f.refresh.invalidate(); }
        f.jobs[0]!.resolve({ netPnl: 1 } as Analytics); await vi.advanceTimersByTimeAsync(299); expect(f.apply).not.toHaveBeenCalled(); expect(f.load).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1); expect(f.load).toHaveBeenCalledTimes(2);
        f.jobs[1]!.resolve({ netPnl: 19 } as Analytics); await vi.advanceTimersByTimeAsync(0); expect(f.apply).toHaveBeenCalledWith({ netPnl: 19 }); f.refresh.destroy();
    });
    it('aborts a previous session and never applies its result to the new session', async () => {
        const f = fixture(); const old = f.refresh.refresh(); f.refresh.reset(); expect(f.jobs[0]!.signal.aborted).toBe(true);
        f.target({ sessionId: 'synthetic-two', version: 1 }); const next = f.refresh.refresh();
        f.jobs[0]!.resolve({ netPnl: 111 } as Analytics); await old; expect(f.apply).not.toHaveBeenCalled();
        f.jobs[1]!.resolve({ netPnl: 222 } as Analytics); await next; expect(f.apply).toHaveBeenCalledExactlyOnceWith({ netPnl: 222 }); f.refresh.destroy();
    });
    it('stops pending timer work on disposal', async () => {
        const f = fixture(); f.refresh.invalidate(); f.refresh.destroy(); await vi.advanceTimersByTimeAsync(1000); expect(f.load).not.toHaveBeenCalled();
    });
    it('resumes dirty work after a blocked timer is consumed without another ledger change', async () => {
        const f = fixture(); const first = f.refresh.refresh(); f.jobs[0]!.resolve({ netPnl: 1 } as Analytics); await first;
        f.refresh.invalidate(); f.enabled(false); await vi.advanceTimersByTimeAsync(300); expect(f.load).toHaveBeenCalledTimes(1);
        f.enabled(true); f.refresh.wake(); await vi.advanceTimersByTimeAsync(0); expect(f.load).toHaveBeenCalledTimes(2);
        f.jobs[1]!.resolve({ netPnl: 2 } as Analytics); await vi.advanceTimersByTimeAsync(0); expect(f.apply).toHaveBeenLastCalledWith({ netPnl: 2 }); f.refresh.destroy();
    });
    it('rejects metrics that arrive before the pending replay command updates the visible client state', async () => {
        const f = fixture(); const old = f.refresh.refresh();
        f.mutationBusy(true); f.jobs[0]!.resolve({ netPnl: 500 } as Analytics); await old;
        expect(f.apply).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(300); expect(f.load).toHaveBeenCalledTimes(1);
        f.target({ sessionId: 'synthetic-one', version: 2 }); f.refresh.invalidate(); f.mutationBusy(false); f.refresh.wake();
        await vi.advanceTimersByTimeAsync(0); expect(f.load).toHaveBeenCalledTimes(2);
        f.jobs[1]!.resolve({ netPnl: 500 } as Analytics); await vi.advanceTimersByTimeAsync(0); expect(f.apply).toHaveBeenCalledExactlyOnceWith({ netPnl: 500 }); f.refresh.destroy();
    });
    it('does not start requests during a mutation and waking clean state does not fetch', async () => {
        const f = fixture(); f.refresh.wake(); await vi.advanceTimersByTimeAsync(1000); expect(f.load).not.toHaveBeenCalled();
        f.mutationBusy(true); await f.refresh.refresh(); expect(f.load).not.toHaveBeenCalled();
        f.mutationBusy(false); f.refresh.wake(); await vi.advanceTimersByTimeAsync(0); expect(f.load).toHaveBeenCalledTimes(1);
        f.jobs[0]!.resolve({ netPnl: 0 } as Analytics); await vi.advanceTimersByTimeAsync(0); f.refresh.destroy();
    });
});
