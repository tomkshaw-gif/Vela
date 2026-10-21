// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Vela } from '../src/Vela';
import { Statusline } from '../src/widget/statusline';

(globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };

class ResizeHarness {
    static current: ResizeHarness;
    readonly observe = vi.fn();
    readonly unobserve = vi.fn();
    readonly disconnect = vi.fn();
    constructor(private readonly callback: ResizeObserverCallback) { ResizeHarness.current = this; }
    resize(target: Element): void { this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver); }
}

let line: Statusline;
let host: HTMLElement;
let headerHeight: number;
let accessoryHeight: number;
let measurements: number;

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeHarness);
    headerHeight = 24;
    accessoryHeight = 32;
    measurements = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        measurements++;
        const height = this.classList.contains('vela-statusline') ? headerHeight : this.classList.contains('vela-sl-accessory') ? accessoryHeight : 0;
        return new DOMRect(0, 0, 250, height);
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    line = new Statusline(host, 'COMEX:MGC1!');
});

afterEach(() => {
    line.destroy();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const offset = (): string => host.style.getPropertyValue('--vela-statusline-legend-offset');
const accessoryTop = (): string => host.style.getPropertyValue('--vela-statusline-accessory-top');

describe('Statusline accessories', () => {
    it('reserves measured space, follows both row resizes, and restores the default when empty', () => {
        expect(offset()).toBe('');
        line.attachAccessory(document.createElement('div'));
        const wrapper = host.querySelector<HTMLElement>('.vela-sl-accessory')!;
        expect(wrapper.dataset.velaScreenshot).toBe('1');
        expect([accessoryTop(), offset()]).toEqual(['27px', '62px']);
        expect(ResizeHarness.current.observe).toHaveBeenCalledWith(wrapper);

        headerHeight = 48;
        accessoryHeight = 50;
        ResizeHarness.current.resize(line.el);
        expect([accessoryTop(), offset()]).toEqual(['51px', '104px']);
        accessoryHeight = 0;
        ResizeHarness.current.resize(wrapper);
        expect([accessoryTop(), offset()]).toEqual(['', '']);
    });

    it('replaces rows safely, ignores an old disposer, and releases ownership on removal', () => {
        const first = document.createElement('div');
        const second = document.createElement('div');
        const removeFirst = line.attachAccessory(first);
        const firstWrapper = first.parentElement!;
        const removeSecond = line.attachAccessory(second);
        expect(first.parentElement).toBeNull();
        expect(ResizeHarness.current.unobserve).toHaveBeenCalledWith(firstWrapper);
        removeFirst();
        expect(host.contains(second)).toBe(true);
        removeSecond();
        removeSecond();
        expect(second.parentElement).toBeNull();
        expect(host.querySelector('.vela-sl-accessory')).toBeNull();
        expect(offset()).toBe('');
    });

    it('does not measure accessory or header geometry on digits-only crosshair moves', () => {
        let hover = (_event: { ohlc: { open: number; high: number; low: number; close: number } | null }): void => {};
        line.onChart({
            on: () => () => {},
            renderer: { onCrosshairMove: (callback: typeof hover) => { hover = callback; return () => {}; } },
            replay: { state: { active: false } },
        } as unknown as Vela);
        line.attachAccessory(document.createElement('div'));
        hover({ ohlc: { open: 100, high: 105, low: 99, close: 103 } });
        const before = measurements;
        hover({ ohlc: { open: 101, high: 106, low: 98, close: 104 } });
        expect(measurements).toBe(before);
    });

    it('disconnects observers and detaches the host-owned element during teardown', () => {
        const accessory = document.createElement('div');
        const remove = line.attachAccessory(accessory);
        line.destroy();
        expect(ResizeHarness.current.disconnect).toHaveBeenCalledOnce();
        expect(accessory.parentElement).toBeNull();
        expect(offset()).toBe('');
        expect(host.classList.contains('vela-has-statusline')).toBe(false);
        remove();
        // afterEach can call the public teardown again.
    });

    it('opts into terminal metadata and replay geometry, then restores the standard face', () => {
        line.setMeta('5', 'COMEX');
        expect(line.el.querySelector('.vela-sl-meta')?.textContent).toBe('· COMEX · 5m');
        line.setAppearance('terminal');
        expect(host.getAttribute('data-vela-legend-appearance')).toBe('terminal');
        expect([...line.el.querySelectorAll('.vela-sl-meta-part')].map((part) => part.textContent)).toEqual(['5', 'COMEX']);
        const replay = line.el.querySelector('.vela-sl-replay-badge')!;
        expect(replay.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 18 18');
        line.attachAccessory(document.createElement('div'));
        expect([accessoryTop(), offset()]).toEqual(['27px', '58px']);
        line.setAppearance('standard');
        expect(host.hasAttribute('data-vela-legend-appearance')).toBe(false);
        expect(line.el.querySelector('.vela-sl-meta')?.textContent).toBe('· COMEX · 5m');
        expect(replay.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 16 16');
        expect(offset()).toBe('62px');
    });
});
