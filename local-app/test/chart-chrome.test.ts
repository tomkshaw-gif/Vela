// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHART_TOPBAR, mountChartChrome } from '../client/chart-chrome';

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(): { root: HTMLElement; panels: HTMLElement; button: HTMLButtonElement; footer: (height: number) => void } {
    const root = document.createElement('div'); root.dataset.layout = 'desktop';
    root.innerHTML = '<div class="vela-widget-topbar"><span class="vela-topbar-right"><span class="vela-widget-panels"><button>Native panel</button></span></span></div><div class="vela-ws-main"><div class="vela-ws-grid"></div><section class="vela-panel" hidden></section></div><div class="vela-ws-strips"></div><div class="vela-widget-bottombar"></div>';
    document.body.append(root);
    let stripHeight = 48;
    Object.defineProperty(root.querySelector('.vela-widget-topbar'), 'getBoundingClientRect', { value: () => new DOMRect(0, 0, 1000, 38) });
    Object.defineProperty(root.querySelector('.vela-ws-strips'), 'getBoundingClientRect', { value: () => new DOMRect(0, 520, 1000, stripHeight) });
    Object.defineProperty(root.querySelector('.vela-widget-bottombar'), 'getBoundingClientRect', { value: () => new DOMRect(0, 568, 1000, 32) });
    return { root, panels: root.querySelector('.vela-widget-panels')!, button: root.querySelector('button')!, footer: (height) => { stripHeight = height; } };
}

function mount(root: HTMLElement): () => void {
    const dispose = mountChartChrome(root); disposers.push(dispose); return dispose;
}

describe('native chart chrome arrangement', () => {
    it('places real native controls in the requested topbar order', () => {
        expect(CHART_TOPBAR).toEqual({ left: ['symbol', 'timeframes', 'style', 'indicators', 'local.templatesShortcut', 'alerts', 'local.replayToggle', 'undo-redo'],
            right: ['layout', 'local.fullscreen', 'screenshot', 'local.tradeShortcut', 'local.sessions', 'panels'] });
    });

    it('keeps the existing native panel buttons, callbacks and dock content intact', () => {
        const { root, panels, button } = fixture();
        const parent = panels.parentElement;
        const panel = root.querySelector<HTMLElement>('.vela-panel')!;
        button.addEventListener('click', () => { panel.hidden = !panel.hidden; button.dataset.active = panel.hidden ? '' : '1'; });
        const before = root.querySelectorAll('button').length;
        mount(root);
        expect(root.classList.contains('local-chart-chrome')).toBe(true);
        expect(panels.parentElement).toBe(parent);
        expect(panels.firstElementChild).toBe(button);
        expect(root.querySelectorAll('button')).toHaveLength(before);
        expect(panels.getAttribute('role')).toBe('toolbar');
        expect(panels.getAttribute('aria-orientation')).toBe('vertical');
        button.click(); expect(panel.hidden).toBe(false); expect(button.dataset.active).toBe('1');
        button.click(); expect(panel.hidden).toBe(true);
    });

    it('measures replay and bottom-bar height so the rail cannot overlap wrapping controls', () => {
        let notify: ResizeObserverCallback = () => {};
        const observe = vi.fn();
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback: ResizeObserverCallback) { notify = callback; }
            observe = observe;
            disconnect(): void {}
        });
        const { root, footer } = fixture(); mount(root);
        expect(root.style.getPropertyValue('--local-chart-rail-top')).toBe('38px');
        expect(root.style.getPropertyValue('--local-chart-rail-bottom')).toBe('80px');
        expect(observe).toHaveBeenCalledTimes(4);
        footer(96); notify([], {} as ResizeObserver);
        expect(root.style.getPropertyValue('--local-chart-rail-bottom')).toBe('128px');
    });

    it('leaves native mobile controls and semantics in their original arrangement', async () => {
        const { root, panels, button } = fixture();
        panels.setAttribute('aria-label', 'Native actions'); mount(root);
        root.dataset.layout = 'mobile';
        await Promise.resolve();
        expect(panels.getAttribute('role')).toBeNull();
        expect(panels.getAttribute('aria-orientation')).toBeNull();
        expect(panels.getAttribute('aria-label')).toBe('Native actions');
        expect(panels.firstElementChild).toBe(button);
        root.dataset.layout = 'desktop';
        await Promise.resolve();
        expect(panels.getAttribute('aria-orientation')).toBe('vertical');
    });

    it('restores host classes, properties and attributes and disconnects observers on disposal', async () => {
        const disconnect = vi.fn();
        let notify: ResizeObserverCallback = () => {};
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback: ResizeObserverCallback) { notify = callback; }
            observe(): void {}
            disconnect = disconnect;
        });
        const { root, panels } = fixture();
        root.style.setProperty('--local-chart-rail-top', '21px', 'important');
        panels.setAttribute('role', 'group');
        const dispose = mount(root); dispose(); dispose();
        expect(disconnect).toHaveBeenCalledOnce();
        expect(root.classList.contains('local-chart-chrome')).toBe(false);
        expect(root.style.getPropertyValue('--local-chart-rail-top')).toBe('21px');
        expect(root.style.getPropertyPriority('--local-chart-rail-top')).toBe('important');
        expect(root.style.getPropertyValue('--local-chart-rail-bottom')).toBe('');
        expect(panels.getAttribute('role')).toBe('group');
        expect(panels.getAttribute('aria-label')).toBeNull();
        notify([], {} as ResizeObserver); window.dispatchEvent(new Event('resize'));
        root.dataset.layout = 'mobile'; await Promise.resolve();
        expect(root.style.getPropertyValue('--local-chart-rail-top')).toBe('21px');
    });

    it('handles hosts without a native panel group without reserving empty space', () => {
        const root = document.createElement('div');
        const dispose = mountChartChrome(root); dispose();
        expect(root.classList.contains('local-chart-chrome')).toBe(false);
        expect(() => mountChartChrome(undefined)()).not.toThrow();
    });
});
