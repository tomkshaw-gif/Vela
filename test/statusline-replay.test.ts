// @vitest-environment jsdom
// The status line's badge: the market session state normally, the replay mode while the
// chart replays past bars — and the ticker's dot spacing.
import { describe, it, expect } from 'vitest';
import type { Vela } from '../src/Vela';
import { Statusline } from '../src/widget/statusline';

// jsdom ships no CSS.escape; the kit's style injection needs it for its id lookup.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (v: string) => v };

function make() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const line = new Statusline(host, 'BINANCE:BTCUSDT');
    const badge = line.el.querySelector<HTMLElement>('.vela-sl-market')!;
    return { line, badge };
}

describe('Statusline badge', () => {
    it('seeds resting OHLC and refreshes load, replacement, replay cuts and pointer leave', () => {
        const { line } = make();
        const callbacks = new Map<string, (event: unknown) => void>();
        let move = (_event: { ohlc: { open: number; high: number; low: number; close: number } | null }): void => {};
        let latest = { open: 100, high: 103, low: 99, close: 102 };
        const chart = {
            get latestBar() { return latest; },
            on: (name: string, callback: (event: unknown) => void) => { callbacks.set(name, callback); return () => callbacks.delete(name); },
            renderer: { onCrosshairMove: (callback: typeof move) => { move = callback; return () => {}; } },
            replay: { state: { active: false } },
        } as unknown as Vela;
        line.onChart(chart);
        const close = (): string | null | undefined => line.el.querySelectorAll('.vela-sl-ohlc b')[3]?.textContent;
        expect(close()).toBe('102.00');
        move({ ohlc: { ...latest, close: 101 } }); expect(close()).toBe('101.00');
        move({ ohlc: null }); expect(close()).toBe('102.00');
        callbacks.get('load:start')?.({}); expect(close()).toBeUndefined();
        latest = { ...latest, close: 103 };
        callbacks.get('data:changed')?.({ lastBar: latest }); expect(close()).toBe('103.00');
        move({ ohlc: { ...latest, close: 104 } });
        latest = { ...latest, close: 95 };
        callbacks.get('data:changed')?.({ lastBar: latest });
        callbacks.get('replay:start')?.({}); expect(close()).toBe('95.00');
        move({ ohlc: null }); expect(close()).toBe('95.00');
        latest = { ...latest, close: 105 };
        callbacks.get('bar')?.(latest); expect(close()).toBe('105.00');
        callbacks.get('replay:end')?.({}); expect(close()).toBe('105.00');
        callbacks.get('data:changed')?.({ lastBar: null }); expect(close()).toBeUndefined();
        line.destroy(); expect(callbacks.size).toBe(0);
    });

    it('shows the replay mode while replaying, then the market status again', () => {
        const { line, badge } = make();
        expect(badge.dataset.status).toBe('open');

        const bubble = badge.querySelector<HTMLElement>('.vela-callout')!;
        const replay = badge.querySelector<HTMLElement>('.vela-sl-replay-badge')!;
        expect([bubble.hidden, replay.hidden]).toEqual([false, true]);

        line.setReplaying(true);
        expect(badge.dataset.status).toBe('replay');
        expect([bubble.hidden, replay.hidden]).toEqual([true, false]);
        // circle and glyph in one drawing, in the inverse chip's colors (white on dark, dark on light)
        expect(replay.querySelector('circle')!.getAttribute('style')).toContain('var(--vela-selected-bg)');
        expect(replay.querySelector('path')!.getAttribute('style')).toContain('var(--vela-selected-fg)');

        line.setMarketStatus('closed'); // a session change while replaying waits for the end
        expect(badge.dataset.status).toBe('replay');

        line.setReplaying(false);
        expect(badge.dataset.status).toBe('closed');
        expect([bubble.hidden, replay.hidden]).toEqual([false, true]);
        line.destroy();
    });

    it('retains host-controlled replay across chart rebinding and native data/replay events', () => {
        const { line, badge } = make();
        const callbacks = new Map<string, (event: unknown) => void>();
        const nativeState = { active: false };
        const bar = { open: 100, high: 103, low: 99, close: 102 };
        const chart = {
            latestBar: bar,
            on: (name: string, callback: (event: unknown) => void) => { callbacks.set(name, callback); return () => callbacks.delete(name); },
            renderer: { onCrosshairMove: () => () => {} },
            replay: { state: nativeState },
        } as unknown as Vela;

        line.setMarketStatus('closed');
        line.setExternalReplaying(true);
        line.onChart(chart);
        expect(nativeState.active).toBe(false);
        expect(badge.dataset.status).toBe('replay');
        const events: Array<[string, unknown]> = [
            ['load:start', {}],
            ['data:changed', { lastBar: bar }],
            ['replay:start', {}],
            ['replay:end', {}],
        ];
        for (const [name, event] of events) {
            callbacks.get(name)?.(event);
            expect(badge.dataset.status).toBe('replay');
        }
        line.onChart(chart);
        expect(badge.dataset.status).toBe('replay');
        line.setExternalReplaying(false);
        expect(badge.dataset.status).toBe('closed');

        nativeState.active = true;
        callbacks.get('replay:start')?.({});
        line.setExternalReplaying(true);
        line.setExternalReplaying(false);
        expect(badge.dataset.status).toBe('replay');
        line.onChart(chart);
        expect(badge.dataset.status).toBe('replay');
        nativeState.active = false;
        callbacks.get('replay:end')?.({});
        expect(badge.dataset.status).toBe('closed');
        expect(badge.querySelector<HTMLElement>('.vela-callout')!.hidden).toBe(false);
        expect(badge.querySelector<HTMLElement>('.vela-sl-replay-badge')!.hidden).toBe(true);
        line.destroy();
        expect(callbacks.size).toBe(0);
    });

    it('sits the meta dot one space after the ticker, not a full row gap away', () => {
        make().line.destroy();
        const css = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
        expect(css).toContain('.vela-statusline .vela-sl-symbol + .vela-sl-meta { margin-left: calc(var(--vela-space-1) - var(--vela-space-2)); }');
    });
});
