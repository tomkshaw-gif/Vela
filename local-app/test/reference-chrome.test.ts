// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountReferenceChrome } from '../client/reference-chrome';

const disposers: (() => void)[] = [];
afterEach(() => {
    disposers.splice(0).forEach((dispose) => dispose());
    document.body.replaceChildren(); vi.unstubAllGlobals();
});

function fixture(): { root: HTMLElement; rail: HTMLElement; settings: HTMLButtonElement; bottom: HTMLElement; drawing: HTMLElement } {
    const root = document.createElement('div'); root.dataset.layout = 'desktop';
    root.innerHTML = '<header class="vela-widget-topbar"><button class="vela-widget-alerts"><span class="vela-icon"></span></button><span class="vela-topbar-right"><span class="vela-widget-panels"></span></span></header><div class="vela-dtb"></div><footer class="vela-widget-bottombar"><button class="vela-bb-settings" aria-label="Chart settings"></button></footer>';
    const rail = root.querySelector<HTMLElement>('.vela-widget-panels')!;
    for (const id of ['dataWindow', 'objects', 'local.trade', 'local.pine', 'local.templates', 'local.strategy', 'local.assistant', 'local.watchlist']) {
        const button = document.createElement('button'); button.className = `vela-widget-tool vela-widget-panel-${id}`;
        button.setAttribute('aria-label', id); rail.append(button);
    }
    const drawing = root.querySelector<HTMLElement>('.vela-dtb')!;
    drawing.getBoundingClientRect = () => new DOMRect(0, 0, 52, 700);
    document.body.append(root);
    return { root, rail, settings: root.querySelector<HTMLButtonElement>('.vela-bb-settings')!, bottom: root.querySelector<HTMLElement>('footer')!, drawing };
}
function mount(root: HTMLElement): () => void { const dispose = mountReferenceChrome(root); disposers.push(dispose); return dispose; }
const labels = (rail: HTMLElement): (string | null)[] => [...rail.children].map((button) => button.getAttribute('aria-label'));
const settled = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

describe('chart control arrangement', () => {
    it('places the functional script, results and templates buttons in a stable lower group', () => {
        const { root, rail } = fixture(); const before = root.querySelectorAll('button').length;
        mount(root);
        expect(labels(rail)).toEqual(['local.watchlist', 'Alerts', 'objects', 'dataWindow', 'local.templates', 'local.assistant', 'local.trade', 'local.pine', 'local.strategy']);
        expect(root.querySelectorAll('button')).toHaveLength(before + 1);
        expect(rail.querySelector('[data-local-panel="local.pine"]')).not.toBeNull();
    });
    it('moves the existing native settings control and preserves its click callback', () => {
        const { root, rail, settings } = fixture(); const open = vi.fn(); settings.addEventListener('click', open);
        mount(root); expect(settings.parentElement).toBe(root.querySelector('.vela-topbar-right'));
        settings.click(); expect(open).toHaveBeenCalledOnce();
    });
    it('restores the native mobile control order and settings location, then resumes the desktop rail', async () => {
        const { root, rail, settings, bottom } = fixture(); const original = labels(rail); mount(root);
        root.dataset.layout = 'mobile'; await settled();
        expect(settings.parentElement).toBe(bottom); expect(labels(rail)).toEqual(original);
        root.dataset.layout = 'desktop'; await settled();
        expect(settings.parentElement).toBe(root.querySelector('.vela-topbar-right')); expect(labels(rail).indexOf('local.pine')).toBeLessThan(labels(rail).indexOf('local.strategy'));
    });
    it('recovers after native panel reprojection without duplicating or losing settings', async () => {
        const { root, rail, settings } = fixture(); mount(root);
        const button = document.createElement('button'); button.className = 'vela-widget-tool vela-widget-panel-local.pine';
        const click = vi.fn(); button.addEventListener('click', click);
        rail.replaceChildren(button); await settled();
        expect(rail.children).toHaveLength(2); expect(rail.lastElementChild).toBe(button); expect(settings.parentElement).toBe(root.querySelector('.vela-topbar-right'));
        button.click(); expect(click).toHaveBeenCalledOnce();
    });
    it('tracks the actual collapsed drawing toolbar width', () => {
        let notify: ResizeObserverCallback = () => {};
        vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { notify = callback; } observe(): void {} disconnect(): void {} });
        const { root, drawing } = fixture(); mount(root); expect(root.style.getPropertyValue('--local-reference-left')).toBe('52px');
        drawing.getBoundingClientRect = () => new DOMRect(0, 0, 28, 700); notify([], {} as ResizeObserver);
        expect(root.style.getPropertyValue('--local-reference-left')).toBe('28px');
    });
    it('restores original controls and attributes and stops observing on disposal', async () => {
        const { root, rail, settings, bottom } = fixture(); const original = labels(rail);
        root.style.setProperty('--local-reference-left', '19px', 'important');
        const first = rail.firstElementChild!; first.setAttribute('data-local-panel', 'prior');
        const dispose = mount(root); dispose(); dispose();
        expect(labels(rail)).toEqual(original); expect(settings.parentElement).toBe(bottom);
        expect(first.getAttribute('data-local-panel')).toBe('prior'); expect(root.classList.contains('local-reference-chrome')).toBe(false);
        expect(root.style.getPropertyValue('--local-reference-left')).toBe('19px'); expect(root.style.getPropertyPriority('--local-reference-left')).toBe('important');
        root.dataset.layout = 'mobile'; await settled(); window.dispatchEvent(new Event('resize'));
        expect(root.style.getPropertyValue('--local-reference-left')).toBe('19px');
    });
    it('does not create controls when there is no native rail', () => {
        const root = document.createElement('div'); mount(root)();
        expect(root.childElementCount).toBe(0); expect(root.classList.contains('local-reference-chrome')).toBe(false);
        expect(() => mountReferenceChrome(undefined)()).not.toThrow();
    });
});
