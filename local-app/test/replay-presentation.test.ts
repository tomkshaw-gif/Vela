// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplayPresentation, replayIntervalCount, replayIntervalLabel } from '../client/replay-presentation';
import { replayTransportMarkup } from '../client/shell';

afterEach(() => { document.body.replaceChildren(); });

describe('replay control presentation', () => {
    const mount = (): HTMLElement => {
        document.body.innerHTML = `<div class="vela-workspace"><div class="local-replay-strip">${replayTransportMarkup()}</div></div>`;
        return document.querySelector<HTMLElement>('.local-replay-strip')!;
    };

    it('starts closed, opens without playing, and pauses before hiding without changing session state', () => {
        const strip = mount();
        const pause = vi.fn(() => expect(strip.hidden).toBe(false));
        const preference = new Map<string, string>();
        const storage = { getItem: (key: string) => preference.get(key) ?? null,
            setItem: (key: string, value: string) => { preference.set(key, value); } };
        const controls = new ReplayPresentation(pause, storage);
        controls.mount(strip);
        expect(strip.hidden).toBe(true);
        expect(strip.parentElement!.dataset.localReplayOpen).toBe('false');
        controls.toggle();
        expect(strip.hidden).toBe(false);
        expect(strip.parentElement!.dataset.localReplayOpen).toBe('true');
        expect(pause).not.toHaveBeenCalled();
        controls.setOpen(false);
        expect(pause).toHaveBeenCalledOnce();
        expect(strip.hidden).toBe(true);
        expect(new ReplayPresentation(vi.fn(), storage).open).toBe(false);
    });

    it('retains the open preference across chart remounts and tolerates unavailable storage', () => {
        const storage = { getItem: () => 'true', setItem: () => { throw new Error('Storage unavailable'); } };
        const controls = new ReplayPresentation(vi.fn(), storage);
        controls.mount(mount());
        expect(document.querySelector<HTMLElement>('.local-replay-strip')!.hidden).toBe(false);
        controls.unmount();
        controls.mount(mount());
        expect(document.querySelector<HTMLElement>('.vela-workspace')!.dataset.localReplayOpen).toBe('true');
        expect(() => controls.setOpen(false)).not.toThrow();
        const fallback = new ReplayPresentation(vi.fn(), { getItem: () => { throw new Error('Denied'); }, setItem: vi.fn() });
        expect(fallback.open).toBe(false);
    });

    it('keeps Stop, Fast and Close reachable and exposes only implemented forward navigation', () => {
        const strip = mount();
        expect(strip.querySelector('[data-action="stop"]')?.getAttribute('aria-label')).toBe('Stop replay');
        expect(strip.querySelector('[data-action="fast-forward"]')).not.toBeNull();
        expect(strip.querySelector('[data-action="replay-close"]')).not.toBeNull();
        expect(strip.querySelectorAll('[data-action="replay-jump-preset"]')).toHaveLength(3);
        expect(strip.querySelector<HTMLSelectElement>('#replay-interval')?.value).toBe('1');
    });

    it('uses bounded complete source-bar intervals and labels second and minute data honestly', () => {
        expect(['1', '5', '10', '5000', '', '-1', 'NaN'].map(replayIntervalCount)).toEqual([1, 5, 10, 1, 1, 1, 1]);
        expect(replayIntervalLabel(60_000, 5)).toBe('5m');
        expect(replayIntervalLabel(1_000, 10)).toBe('10s');
    });
});
