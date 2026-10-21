import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayPlayback } from '../client/replay-playback';

function deferred() {
    let resolve: () => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const settle = async (): Promise<void> => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function fixture() {
    const hooks = { advance: vi.fn(async (): Promise<void> => undefined), delay: vi.fn(() => 1000),
        canPlay: vi.fn(() => true), onError: vi.fn<(error: unknown) => void>() };
    return { hooks, playback: new ReplayPlayback(hooks) };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('replay playback clock', () => {
    it('starts immediately and ignores repeated play while one advance is pending', async () => {
        const { hooks, playback } = fixture();
        const pending = deferred(); hooks.advance.mockReturnValueOnce(pending.promise);
        playback.start(); playback.start(); playback.start();
        expect(playback.playing).toBe(true);
        expect(hooks.advance).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(10000);
        expect(hooks.advance).toHaveBeenCalledOnce();
        pending.resolve(); await settle();
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(hooks.advance).toHaveBeenCalledTimes(2);
    });

    it('uses the current speed after a slow advance without restarting or overlapping requests', async () => {
        const { hooks, playback } = fixture();
        const pending = deferred();
        let speed = 1; let inFlight = 0; let maximumInFlight = 0;
        hooks.delay.mockImplementation(() => 1000 / speed);
        hooks.advance.mockImplementation(async () => {
            inFlight++; maximumInFlight = Math.max(maximumInFlight, inFlight);
            if (hooks.advance.mock.calls.length === 1) await pending.promise;
            inFlight--;
        });
        playback.start(); speed = 10;
        await vi.advanceTimersByTimeAsync(10000);
        expect(hooks.advance).toHaveBeenCalledOnce();
        pending.resolve(); await settle();
        await vi.advanceTimersByTimeAsync(99);
        expect(hooks.advance).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        expect(hooks.advance).toHaveBeenCalledTimes(2);
        expect(maximumInFlight).toBe(1);
        expect(vi.getTimerCount()).toBe(1);
    });

    it('waits for the old advance after pause and play, then runs only the new clock', async () => {
        const { hooks, playback } = fixture();
        const pending = deferred(); hooks.advance.mockReturnValueOnce(pending.promise);
        playback.start(); playback.stop(); playback.start();
        expect(hooks.advance).toHaveBeenCalledOnce();
        pending.resolve(); await settle();
        expect(hooks.advance).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(hooks.advance).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(1);
    });

    it('does not send a queued bar after play, pause, play and pause during one pending advance', async () => {
        const { hooks, playback } = fixture();
        const pending = deferred(); hooks.advance.mockReturnValueOnce(pending.promise);
        playback.start(); playback.stop(); playback.start(); playback.stop();
        pending.resolve(); await settle();
        await vi.advanceTimersByTimeAsync(10000);
        expect(hooks.advance).toHaveBeenCalledOnce();
        expect(playback.playing).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('invalidates all intermediate starts when pause and play are pressed rapidly', async () => {
        const { hooks, playback } = fixture();
        const pending = deferred(); hooks.advance.mockReturnValueOnce(pending.promise);
        playback.start();
        for (let index = 0; index < 8; index++) { playback.stop(); playback.start(); }
        expect(hooks.advance).toHaveBeenCalledOnce();
        pending.resolve(); await settle();
        expect(hooks.advance).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);
    });

    it('clears the scheduled advance on stop and keeps repeated stop harmless', async () => {
        const { hooks, playback } = fixture();
        playback.start(); await settle();
        expect(vi.getTimerCount()).toBe(1);
        playback.stop(); playback.stop();
        await vi.advanceTimersByTimeAsync(10000);
        expect(hooks.advance).toHaveBeenCalledOnce();
        expect(playback.playing).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reports a pending advance failure once, cancels waiting starts and permits a later explicit restart', async () => {
        const { hooks, playback } = fixture();
        const pending = deferred(); const error = new Error('advance failed');
        hooks.advance.mockReturnValueOnce(pending.promise);
        playback.start(); playback.stop(); playback.start();
        pending.reject(error); await settle();
        expect(hooks.onError).toHaveBeenCalledExactlyOnceWith(error);
        expect(hooks.advance).toHaveBeenCalledOnce();
        expect(playback.playing).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        playback.start(); await settle();
        expect(hooks.advance).toHaveBeenCalledTimes(2);
        expect(playback.playing).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
    });

    it('stops and reports a synchronous advance exception', async () => {
        const { hooks, playback } = fixture(); const error = new Error('synchronous failure');
        hooks.advance.mockImplementationOnce(() => { throw error; });
        playback.start(); await settle();
        expect(hooks.onError).toHaveBeenCalledExactlyOnceWith(error);
        expect(playback.playing).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not start when the current session cannot play', () => {
        const { hooks, playback } = fixture(); hooks.canPlay.mockReturnValue(false);
        playback.start();
        expect(playback.playing).toBe(false);
        expect(hooks.advance).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops at a terminal state reached by the pending advance', async () => {
        const { hooks, playback } = fixture();
        const pending = deferred(); hooks.advance.mockReturnValueOnce(pending.promise);
        playback.start(); hooks.canPlay.mockReturnValue(false);
        pending.resolve(); await settle();
        expect(playback.playing).toBe(false);
        expect(hooks.advance).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rechecks the current session before a scheduled advance', async () => {
        const { hooks, playback } = fixture();
        playback.start(); await settle(); hooks.canPlay.mockReturnValue(false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(playback.playing).toBe(false);
        expect(hooks.advance).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rechecks play eligibility before a waiting restart can advance', async () => {
        const { hooks, playback } = fixture();
        const pending = deferred(); hooks.advance.mockReturnValueOnce(pending.promise);
        playback.start(); playback.stop(); playback.start();
        hooks.canPlay.mockReturnValue(false); pending.resolve(); await settle();
        expect(playback.playing).toBe(false);
        expect(hooks.advance).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops on a delay calculation failure without leaving an active clock', async () => {
        const { hooks, playback } = fixture(); const error = new Error('invalid speed');
        hooks.delay.mockImplementationOnce(() => { throw error; });
        playback.start(); await settle();
        expect(hooks.onError).toHaveBeenCalledExactlyOnceWith(error);
        expect(playback.playing).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
});
