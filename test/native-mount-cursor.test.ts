// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DARK_THEME } from '../src/core/theme';
import { NativeRenderer } from '../src/renderers/native/NativeRenderer';
import { InvalidateLevel, type Scheduler } from '../src/renderers/native/core/Scheduler';

const nextTask = () => new Promise<void>(resolve => {
    (globalThis as unknown as { setImmediate(callback: () => void): void }).setImmediate(resolve);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('native mount cursor scheduling', () => {
    it('merges 120 task-separated cursor moves into one receiver-safe RAF and rearms after painting', async () => {
        const frames = new Map<number, FrameRequestCallback>();
        let frameId = 0;
        // Model the browser operation's receiver check while holding frames until explicitly fired.
        const raf = vi.fn(function (this: unknown, callback: FrameRequestCallback) {
            if (this !== undefined && this !== globalThis && this !== window) throw new TypeError('Illegal invocation');
            frames.set(++frameId, callback);
            return frameId;
        });
        expect(() => raf.call({}, () => {})).toThrow('Illegal invocation');
        raf.mockClear();
        vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
        vi.stubGlobal('CSS', { escape: (value: string) => value });
        vi.stubGlobal('requestAnimationFrame', raf);
        vi.stubGlobal('cancelAnimationFrame', vi.fn((handle: number) => frames.delete(handle)));
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

        const renderer = new NativeRenderer();
        const render = vi.spyOn(renderer as unknown as { renderFrame(level: InvalidateLevel): void }, 'renderFrame').mockImplementation(() => {});
        const host = document.createElement('div');
        document.body.appendChild(host);
        try {
            renderer.mount(host, DARK_THEME);
            const scheduler = Reflect.get(renderer, 'scheduler') as Scheduler;
            scheduler.flushNow(InvalidateLevel.Full);
            render.mockClear();
            raf.mockClear();
            const frame = () => {
                const pending = [...frames.values()];
                frames.clear();
                for (const callback of pending) callback(0);
            };

            for (let i = 0; i < 120; i++) {
                scheduler.invalidate(InvalidateLevel.Cursor);
                await nextTask();
            }
            const paintsBeforeFrame = render.mock.calls.length;
            const pendingFrames = frames.size;
            frame();
            expect(render).toHaveBeenCalledTimes(1);
            expect(paintsBeforeFrame).toBe(0);
            expect(pendingFrames).toBe(1);
            expect(raf).toHaveBeenCalledTimes(1);
            expect(render).toHaveBeenLastCalledWith(InvalidateLevel.Cursor);
            expect(frames.size).toBe(0);

            scheduler.invalidate(InvalidateLevel.Cursor);
            scheduler.invalidate(InvalidateLevel.Cursor);
            expect(raf).toHaveBeenCalledTimes(2);
            expect(frames.size).toBe(1);
            frame();
            expect(render.mock.calls).toEqual([[InvalidateLevel.Cursor], [InvalidateLevel.Cursor]]);
            expect(frames.size).toBe(0);
        } finally {
            renderer.destroy();
            host.remove();
        }
    });
});
