import { describe, it, expect, vi } from 'vitest';
import { Scheduler, InvalidateLevel, repaintsData, repaintsChrome } from '../src/renderers/native/core/Scheduler';

const nextTask = () => new Promise<void>(resolve => {
    (globalThis as unknown as { setImmediate(callback: () => void): void }).setImmediate(resolve);
});

/** Controllable rAF: capture the pending callback so the test can fire frames. */
function harness() {
    let pending: (() => void) | null = null;
    const raf = (cb: () => void): number => {
        pending = cb;
        return 1;
    };
    const cancel = (): void => {
        pending = null;
    };
    const frames: InvalidateLevel[] = [];
    const scheduler = new Scheduler((lvl) => frames.push(lvl), raf, cancel);
    const fire = (): void => {
        const cb = pending;
        pending = null;
        cb?.();
    };
    return { scheduler, frames, fire, isArmed: () => pending !== null };
}

describe('native Scheduler', () => {
    it('coalesces multiple invalidations in a frame to the highest level', () => {
        const h = harness();
        h.scheduler.invalidate(InvalidateLevel.Cursor);
        h.scheduler.invalidate(InvalidateLevel.Full);
        h.scheduler.invalidate(InvalidateLevel.Light);
        expect(h.isArmed()).toBe(true);
        h.fire();
        expect(h.frames).toEqual([InvalidateLevel.Full]); // one frame, highest level
    });

    it('re-arms for the next frame after flushing', () => {
        const h = harness();
        h.scheduler.invalidate(InvalidateLevel.Light);
        h.fire();
        h.scheduler.invalidate(InvalidateLevel.Cursor);
        expect(h.isArmed()).toBe(true);
        h.fire();
        expect(h.frames).toEqual([InvalidateLevel.Light, InvalidateLevel.Cursor]);
    });

    it('treats None as a no-op (no frame, no arm)', () => {
        const h = harness();
        h.scheduler.invalidate(InvalidateLevel.None);
        expect(h.isArmed()).toBe(false);
        h.fire();
        expect(h.frames).toEqual([]);
    });

    it('flushNow paints synchronously', () => {
        const h = harness();
        h.scheduler.flushNow(InvalidateLevel.Full);
        expect(h.frames).toEqual([InvalidateLevel.Full]);
        expect(h.isArmed()).toBe(false);
    });

    it('destroy cancels a pending frame', () => {
        const h = harness();
        h.scheduler.invalidate(InvalidateLevel.Full);
        h.scheduler.destroy();
        h.fire();
        expect(h.frames).toEqual([]);
    });
});

describe('native Scheduler · Cursor-tier gate (repaintsData)', () => {
    it('repaints the data layer only at Light or Full', () => {
        expect(repaintsData(InvalidateLevel.None)).toBe(false);
        expect(repaintsData(InvalidateLevel.Cursor)).toBe(false); // hover → crosshair only
        expect(repaintsData(InvalidateLevel.Chrome)).toBe(false); // countdown tick → chrome only
        expect(repaintsData(InvalidateLevel.Light)).toBe(true);
        expect(repaintsData(InvalidateLevel.Full)).toBe(true);
    });
});

describe('native Scheduler · Chrome tier', () => {
    it('sits between Cursor and Light (subsumption order)', () => {
        expect(InvalidateLevel.Cursor).toBeLessThan(InvalidateLevel.Chrome);
        expect(InvalidateLevel.Chrome).toBeLessThan(InvalidateLevel.Light);
    });

    it('repaintsChrome: true from Chrome up (data-tier frames repaint chrome too)', () => {
        expect(repaintsChrome(InvalidateLevel.None)).toBe(false);
        expect(repaintsChrome(InvalidateLevel.Cursor)).toBe(false);
        expect(repaintsChrome(InvalidateLevel.Chrome)).toBe(true);
        expect(repaintsChrome(InvalidateLevel.Light)).toBe(true);
        expect(repaintsChrome(InvalidateLevel.Full)).toBe(true);
    });

    it('coalesces with its neighbors at the highest level', () => {
        const h = harness();
        h.scheduler.invalidate(InvalidateLevel.Chrome);
        h.scheduler.invalidate(InvalidateLevel.Cursor);
        h.fire();
        h.scheduler.invalidate(InvalidateLevel.Chrome);
        h.scheduler.invalidate(InvalidateLevel.Light);
        h.fire();
        expect(h.frames).toEqual([InvalidateLevel.Chrome, InvalidateLevel.Light]);
    });

    it('a lone countdown tick flushes as one Chrome frame', () => {
        const h = harness();
        h.scheduler.invalidate(InvalidateLevel.Chrome);
        expect(h.isArmed()).toBe(true);
        h.fire();
        expect(h.frames).toEqual([InvalidateLevel.Chrome]);
    });
});

describe('native Scheduler merged RAF', () => {
    function frameHarness(onFrame?: (level: InvalidateLevel) => void) {
        const rafs = new Map<number, () => void>(), frames: InvalidateLevel[] = [];
        let id = 0;
        const raf = vi.fn((callback: () => void) => { rafs.set(++id, callback); return id; });
        const cancel = vi.fn((handle: number) => { rafs.delete(handle); });
        const scheduler = new Scheduler(level => { frames.push(level); onFrame?.(level); },
            raf, cancel);
        return { scheduler, frames, rafs, raf, cancel,
            frame: () => { const pending = [...rafs.values()]; rafs.clear(); for (const task of pending) task(); } };
    }

    it('keeps one pending RAF across 120 task-separated cursor invalidations', async () => {
        const h = frameHarness();
        for (let i = 0; i < 120; i++) {
            h.scheduler.invalidate(InvalidateLevel.Cursor);
            await nextTask();
            expect(h.rafs.size).toBe(1);
        }
        expect(h.frames).toEqual([]); expect(h.raf).toHaveBeenCalledTimes(1);
        h.frame();
        expect(h.frames).toEqual([InvalidateLevel.Cursor]); expect(h.rafs.size).toBe(0);
        h.frame(); expect(h.frames).toEqual([InvalidateLevel.Cursor]);
    });

    it('coalesces cursor and chrome work in one frame', () => {
        const h = frameHarness();
        h.scheduler.invalidate(InvalidateLevel.Chrome);
        h.scheduler.invalidate(InvalidateLevel.Cursor); h.scheduler.invalidate(InvalidateLevel.Cursor);
        expect(h.frames).toEqual([]); expect(h.rafs.size).toBe(1);
        h.frame(); expect(h.frames).toEqual([InvalidateLevel.Chrome]); expect(h.raf).toHaveBeenCalledTimes(1);
    });

    for (const level of [InvalidateLevel.Light, InvalidateLevel.Full])
        it(`lets ${InvalidateLevel[level]} subsume cursor and chrome work`, () => {
            const h = frameHarness();
            h.scheduler.invalidate(InvalidateLevel.Cursor); h.scheduler.invalidate(level);
            h.scheduler.invalidate(InvalidateLevel.Chrome); h.scheduler.invalidate(InvalidateLevel.Cursor);
            expect(h.frames).toEqual([]); expect(h.rafs.size).toBe(1);
            h.frame(); expect(h.frames).toEqual([level]); expect(h.rafs.size).toBe(0);
        });

    it('consumes the pending RAF during a synchronous flush', () => {
        const h = frameHarness();
        h.scheduler.invalidate(InvalidateLevel.Cursor); h.scheduler.flushNow(InvalidateLevel.Full);
        h.frame(); expect(h.frames).toEqual([InvalidateLevel.Full]); expect(h.rafs.size).toBe(0);
        expect(h.cancel).toHaveBeenCalledTimes(1);
        h.scheduler.invalidate(InvalidateLevel.Full); h.scheduler.flushNow(InvalidateLevel.Cursor);
        h.frame(); expect(h.frames).toEqual([InvalidateLevel.Full, InvalidateLevel.Full]);
    });

    it('flushes a pending cursor synchronously even when no new level is requested', () => {
        const h = frameHarness();
        h.scheduler.invalidate(InvalidateLevel.Cursor); h.scheduler.flushNow(InvalidateLevel.None);
        h.frame(); expect(h.frames).toEqual([InvalidateLevel.Cursor]); expect(h.rafs.size).toBe(0);
    });

    it('allows reentrant cursor invalidations to merge into the next frame', () => {
        const h = frameHarness(() => {
            if (h.frames.length === 1) {
                h.scheduler.invalidate(InvalidateLevel.Cursor); h.scheduler.invalidate(InvalidateLevel.Cursor);
            }
        });
        h.scheduler.invalidate(InvalidateLevel.Cursor); h.frame();
        expect(h.frames).toEqual([InvalidateLevel.Cursor]); expect(h.rafs.size).toBe(1);
        h.frame();
        expect(h.frames).toEqual([InvalidateLevel.Cursor, InvalidateLevel.Cursor]);
        expect(h.raf).toHaveBeenCalledTimes(2); expect(h.rafs.size).toBe(0);
    });

    it('cancels the merged frame on destroy and ignores late invalidations', () => {
        const h = frameHarness();
        h.scheduler.invalidate(InvalidateLevel.Chrome); h.scheduler.invalidate(InvalidateLevel.Cursor);
        h.scheduler.destroy(); h.frame();
        h.scheduler.invalidate(InvalidateLevel.Cursor); h.scheduler.invalidate(InvalidateLevel.Full);
        h.scheduler.flushNow(InvalidateLevel.Full); h.frame();
        expect(h.frames).toEqual([]); expect(h.rafs.size).toBe(0);
        expect(h.raf).toHaveBeenCalledTimes(1); expect(h.cancel).toHaveBeenCalledTimes(1);
    });
});
