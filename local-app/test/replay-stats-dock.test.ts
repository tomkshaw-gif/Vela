// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountReplayStatsDock, replayKeyStatsMarkup } from '../client/replay-stats-dock';
import type { Analytics } from '../shared/types';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

function fixture(saved?: string, height = 900) {
    const root = document.createElement('div');
    root.innerHTML = '<header></header><div class="vela-ws-main"></div><div class="vela-ws-strips"><div class="local-replay-strip"></div><section class="local-script-dock"><div role="separator" tabindex="0"></div><header class="local-script-tabs"><button class="min"></button><button class="max"></button></header><div class="local-script-replay">Real session results</div></section><span class="after"></span></div><footer></footer>';
    document.body.append(root);
    let availableHeight = height;
    Object.defineProperty(root, 'clientHeight', { get: () => availableHeight });
    const rect = (height: number): DOMRect => ({ height, width: 1000, x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: height, toJSON: () => ({ height }) });
    root.querySelector('header')!.getBoundingClientRect = () => rect(42);
    root.querySelector('footer')!.getBoundingClientRect = () => rect(38);
    root.querySelector('.local-replay-strip')!.getBoundingClientRect = () => rect(49);
    const dock = root.querySelector<HTMLElement>('.local-script-dock')!;
    dock.getBoundingClientRect = () => rect(Number.parseFloat(dock.style.height) || 280);
    const resize = dock.querySelector<HTMLElement>('[role=separator]')!;
    const captures = new Set<number>();
    resize.setPointerCapture = vi.fn(id => { captures.add(id); }); resize.hasPointerCapture = id => captures.has(id); resize.releasePointerCapture = vi.fn(id => { captures.delete(id); });
    const storage = { getItem: vi.fn(() => saved ?? null), setItem: vi.fn() };
    const minimize = dock.querySelector<HTMLButtonElement>('.min')!; const maximize = dock.querySelector<HTMLButtonElement>('.max')!;
    const controller = mountReplayStatsDock({ root, dock, resize, minimize, maximize, storage }); cleanup.push(controller.destroy);
    const pointer = (type: string, y: number, id = 1, primary = true, button = 0): void => {
        const event = new MouseEvent(type, { bubbles: true, clientY: y, button });
        Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: primary } }); resize.dispatchEvent(event);
    };
    const key = (key: string, shiftKey = false): void => { resize.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, shiftKey })); };
    return { root, dock, resize, storage, minimize, maximize, controller, pointer, key,
        viewport: (height: number) => { availableHeight = height; window.dispatchEvent(new Event('resize')); } };
}

describe('shared replay results dock', () => {
    it('renders the supplied metrics with separate currency and empty-value typography', () => {
        const analysis = { netPnl: -791, maxDrawdown: 883, winRate: null, wins: 0, trades: 2, profitFactor: null } as Analytics;
        const host = document.createElement('div'); host.innerHTML = replayKeyStatsMarkup(analysis);
        const values = host.querySelectorAll('.local-stat-value');
        expect(values[0]!.textContent).toBe('-791.00USD'); expect(values[0]!.classList.contains('negative')).toBe(true);
        expect(values[1]!.textContent).toBe('883.00USD'); expect(values[2]!.textContent).toBe('—0/2'); expect(values[3]!.textContent).toBe('—');
        expect(host.querySelector('.local-stat-currency')!.textContent).toBe('USD');
        expect(host.textContent).not.toContain('?');
    });
    it('drags to arbitrary pixel heights and saves only the completed drag', () => {
        const f = fixture(); f.pointer('pointerdown', 620); f.pointer('pointermove', 457);
        expect(f.dock.style.height).toBe('443px'); expect(f.storage.setItem).not.toHaveBeenCalled();
        expect(f.resize.getAttribute('aria-valuenow')).toBe('443');
        f.pointer('pointerup', 457);
        expect(JSON.parse(f.storage.setItem.mock.lastCall![1])).toEqual({ height: 443, mode: 'normal' });
        expect(f.resize.releasePointerCapture).toHaveBeenCalledWith(1);
    });
    it('reserves chart space and reclamps after a viewport change without losing the preferred height', () => {
        const f = fixture(); f.pointer('pointerdown', 620); f.pointer('pointermove', -1000); f.pointer('pointerup', -1000);
        expect(f.dock.style.height).toBe('591px');
        f.viewport(600); expect(f.dock.style.height).toBe('291px');
        f.viewport(900); expect(f.dock.style.height).toBe('591px');
        expect(f.storage.setItem).toHaveBeenCalledTimes(1);
    });
    it('ignores non-primary pointers and keeps ownership of an active drag', () => {
        const f = fixture(); f.pointer('pointerdown', 620, 1, false); f.pointer('pointermove', 457);
        expect(f.dock.style.height).toBe('280px');
        f.pointer('pointerdown', 620); f.pointer('pointermove', 457, 2); f.pointer('pointerup', 457, 2);
        expect(f.dock.style.height).toBe('280px'); expect(f.storage.setItem).not.toHaveBeenCalled();
        f.pointer('pointermove', 457); f.pointer('pointercancel', 457); expect(f.dock.style.height).toBe('443px');
    });
    it('collapses and expands without discarding height and restores persisted mode', () => {
        const f = fixture('{"height":407,"mode":"minimized"}');
        expect(f.dock.style.height).toBe('30px'); expect(f.minimize.getAttribute('aria-expanded')).toBe('false');
        f.minimize.click(); expect(f.dock.style.height).toBe('407px');
        f.minimize.click(); expect(f.dock.classList.contains('local-script-minimized')).toBe(true);
        f.controller.open(); expect(f.dock.style.height).toBe('407px'); expect(f.dock.hidden).toBe(false);
    });
    it('maximizes outside the strip, restores its exact slot, and closes without leaving an overlay', () => {
        const f = fixture('{"height":315,"mode":"normal"}'); const strip = f.dock.parentElement;
        f.maximize.click(); expect(f.dock.parentElement).toBe(f.root); expect(f.maximize.getAttribute('aria-pressed')).toBe('true');
        f.maximize.click(); expect(f.dock.parentElement).toBe(strip); expect(f.dock.nextSibling).toBe(strip!.querySelector('.after')); expect(f.dock.style.height).toBe('315px');
        f.maximize.click(); f.controller.close(); expect(f.dock.hidden).toBe(true); expect(f.dock.parentElement).toBe(strip); expect(f.dock.classList.contains('local-script-maximized')).toBe(false);
    });
    it('supports keyboard resizing, extrema and collapse on the separator', () => {
        const f = fixture(); f.key('ArrowUp'); expect(f.dock.style.height).toBe('300px');
        f.key('ArrowUp', true); expect(f.dock.style.height).toBe('350px');
        f.key('ArrowDown'); expect(f.dock.style.height).toBe('330px');
        f.key('Home'); expect(f.dock.style.height).toBe('30px'); f.key('Enter'); expect(f.dock.style.height).toBe('330px');
        f.key('End'); expect(f.dock.style.height).toBe('591px'); expect(f.resize.getAttribute('aria-valuemax')).toBe('591');
    });
    it('falls back when preferences are invalid and removes all handlers on disposal', () => {
        const f = fixture('{"height":null,"mode":"normal"}'); expect(f.dock.style.height).toBe('280px');
        f.controller.destroy(); cleanup.splice(cleanup.indexOf(f.controller.destroy), 1);
        f.key('ArrowUp'); f.minimize.click(); f.pointer('pointerdown', 600); f.pointer('pointermove', 400);
        expect(f.dock.style.height).toBe('280px'); expect(f.storage.setItem).not.toHaveBeenCalled();
        expect([...f.dock.parentNode!.childNodes].some(node => node.nodeType === Node.COMMENT_NODE)).toBe(false);
    });
});
