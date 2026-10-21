// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { widgetActions, type WidgetContext } from '../../src/plugin';
import { defaultTimeframeFavorites, mountChartHeader, withDesktopTimeframeFavorites } from '../client/chart-header';

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
function fixture(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = '<div class="vela-widget-topbar"><button class="vela-widget-symbol">NQZ6</button><button class="vela-widget-alerts"><span class="vela-icon"></span></button><span class="vela-widget-action-pin"><button class="vela-widget-action-left">Replay</button></span><span class="vela-topbar-right"><button class="vela-widget-style" aria-label="Layout — 1"><span class="vela-icon"></span></button><button class="vela-widget-tool" aria-label="Fullscreen"></button></span></div>';
    document.body.append(root); return root;
}
describe('supported chart header actions', () => {
    it('seeds genuine supported favorites with second intervals confined to second data', () => {
        expect(defaultTimeframeFavorites('ohlcv-1m')).toEqual(['1', '2', '3', '5', '10', '15', '30', '60', '240', 'D', 'W', 'M']);
        expect(defaultTimeframeFavorites('ohlcv-1s')).toEqual(['15S', '30S', '1', '2', '3', '5', '10', '15', '30', '60', '240', 'D', 'W', 'M']);
    });
    it('migrates an old empty default once while preserving saved stars and later intentional clearing', () => {
        const legacy = { version: 1 as const, layout: '1', charts: [] };
        const migrated = withDesktopTimeframeFavorites(legacy, 'ohlcv-1m');
        expect(migrated.timeframeFavorites).toContain('2'); expect(migrated.timeframeFavorites).toContain('10');
        expect(withDesktopTimeframeFavorites({ ...migrated, timeframeFavorites: [] }, 'ohlcv-1m').timeframeFavorites).toEqual([]);
        expect(withDesktopTimeframeFavorites({ ...legacy, timeframeFavorites: ['5', 'D'] }, 'ohlcv-1m').timeframeFavorites).toEqual(['5', 'D']);
        expect(withDesktopTimeframeFavorites({ ...legacy, timeframeFavorites: ['15S', '5'] }, 'ohlcv-1m').timeframeFavorites).toEqual(['5']);
    });
    it('opens the existing panels and emits the replay presentation action through each invocation context', () => {
        const first = fixture(); const second = fixture(); const togglePanel = vi.fn(); const events: string[] = [];
        second.addEventListener('local-replay:chrome', (event) => events.push((event as CustomEvent).detail.kind));
        const context = { host: second, togglePanel } as unknown as WidgetContext;
        const actions = widgetActions('topbar');
        actions.find((item) => item.id === 'local.templatesShortcut')!.run(context);
        actions.find((item) => item.id === 'local.tradeShortcut')!.run(context);
        actions.find((item) => item.id === 'local.replayToggle')!.run(context);
        expect(togglePanel.mock.calls).toEqual([['local.templates'], ['local.trade']]);
        expect(events).toEqual(['replay-toggle']); expect(first.dataset.localReplayOpen).toBeUndefined();
    });
    it('keeps the native symbol/alert/layout handlers and reacts to actual replay and persistence state', async () => {
        const root = fixture(); const native = vi.fn(); root.querySelector('.vela-widget-alerts')!.addEventListener('click', native);
        const save = vi.fn(async () => {}); let name = 'Morning practice';
        disposers.push(mountChartHeader(root, { name: () => name, save }));
        expect(root.querySelector('.local-symbol-glyph svg')).not.toBeNull();
        expect(root.querySelector('.local-alert-label')!.textContent).toBe('Alert');
        root.querySelector<HTMLButtonElement>('.vela-widget-alerts')!.click(); expect(native).toHaveBeenCalledOnce();
        const replay = root.querySelector('[data-local-action="local.replayToggle"]')!;
        expect(replay.getAttribute('aria-pressed')).toBe('false');
        root.dataset.localReplayOpen = 'true'; root.dataset.localLayoutSave = 'saving'; await settle();
        expect(replay.getAttribute('aria-pressed')).toBe('true');
        expect(root.querySelector<HTMLButtonElement>('.local-layout-save')!.disabled).toBe(true);
        root.dataset.localLayoutSave = 'error'; await settle();
        root.querySelector<HTMLButtonElement>('.local-layout-save')!.click(); expect(save).toHaveBeenCalledOnce();
        root.dataset.localLayoutSave = 'saved'; name = 'Renamed session'; root.dataset.localLayoutName = name; await settle();
        expect(root.querySelector('.local-layout-name')!.textContent).toBe('Renamed session');
        expect(root.querySelector('.local-layout-save')!.textContent).toBe('Local saved');
    });
    it('rebuilds only missing enhancements after native reprojection and cleans up idempotently', async () => {
        const root = fixture(); const dispose = mountChartHeader(root, { name: () => 'Practice', save: async () => {} }); disposers.push(dispose);
        const symbol = root.querySelector('.vela-widget-symbol')!; symbol.textContent = 'ESZ6'; await settle();
        expect(symbol.querySelectorAll('.local-symbol-glyph')).toHaveLength(1);
        expect(symbol.getAttribute('aria-label')).toContain('ESZ6');
        dispose(); dispose();
        expect(root.querySelector('.local-symbol-glyph,.local-alert-label,.local-layout-name,.local-layout-save')).toBeNull();
        expect(root.querySelector('[data-local-action]')).toBeNull();
        expect(root.querySelector('.vela-widget-style')!.getAttribute('aria-label')).toBe('Layout — 1');
    });
    it('uses the browser fullscreen lifecycle and reports rejected requests', async () => {
        const root = fixture(); const toast = vi.fn(); const request = vi.fn(async () => { throw new Error('denied'); });
        root.requestFullscreen = request;
        const action = widgetActions('topbar').find((item) => item.id === 'local.fullscreen')!;
        const context = { host: root, toast } as unknown as WidgetContext;
        expect(action.when!(context)).toBe(true); action.run(context); await settle();
        expect(request).toHaveBeenCalledOnce(); expect(toast).toHaveBeenCalledWith(expect.stringContaining('Fullscreen'), 'error');
    });
});
