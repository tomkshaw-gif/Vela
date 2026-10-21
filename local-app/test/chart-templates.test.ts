// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IndicatorHandle, InputValue, Vela } from '../../src/index';
import type { VelaWorkspace } from '../../src/workspace';
import { applyIndicatorTemplate, captureIndicatorTemplate, ChartTemplateStore, CHART_TEMPLATES_KEY, mountChartTemplates, validateChartTemplate, type ChartTemplate, type IndicatorTemplateData } from '../client/chart-templates';

const date = '2026-10-20T00:00:00.000Z';
const template = (): ChartTemplate => ({ id: 'setup-1', name: 'NQ setup', kind: 'indicators', createdAt: date, updatedAt: date, revision: 1, archived: false, data: { natives: [], scripts: [] } });
const locks = { request: vi.fn(async (_name: string, action: () => unknown) => action()) } as unknown as LockManager;
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); localStorage.clear(); document.body.replaceChildren(); vi.restoreAllMocks(); });
function storage(): Storage { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as Storage; }
function handle(id: string, nativeType?: string, source?: string): IndicatorHandle {
    let inputs: Record<string, InputValue> = { length: 20 }, props: Record<string, InputValue> = { initial_capital: 50000 }, visible = true;
    return { id, title: id, nativeType, source, inputs: [], props: [], get visible() { return visible; },
        inputValues: () => ({ ...inputs }), propValues: () => ({ ...props }),
        setInputs: vi.fn((value: Record<string, InputValue>) => { inputs = { ...value }; }), setProps: vi.fn((value: Record<string, InputValue>) => { props = { ...value }; }),
        setInput: vi.fn(), setProp: vi.fn(), setVisible: vi.fn((value: boolean) => { visible = value; }), updateCode: vi.fn(),
        moveTo: vi.fn(), on: vi.fn(() => () => {}), context: vi.fn(), remove: vi.fn() };
}
function chart(existing: IndicatorHandle[] = []) {
    const added: IndicatorHandle[] = [];
    const port = { indicators: () => existing, availableNativeIndicators: vi.fn(async () => [
        { type: 'moving-average', title: 'SMA', supported: true, present: true, multiInstance: true },
        { type: 'volume', title: 'Volume', supported: true, present: true, multiInstance: false },
    ]), addNativeIndicator: vi.fn((type: string, options?: { inputs?: Record<string, InputValue> }) => {
        const next = handle(`new-${added.length}`, type); if (options?.inputs) next.setInputs(options.inputs); added.push(next); return next;
    }), runIndicator: vi.fn(async () => { const next = handle(`script-${added.length}`, undefined, 'indicator("Test")'); added.push(next); return { ok: true, handle: next, error: null, context: null }; }) };
    return { port, added };
}
const scripts = (): IndicatorTemplateData['scripts'] => [{ id: 'saved-pine', name: 'My Pine', language: 'pine', script: 'indicator("Test")', inputs: { length: 14 }, props: { initial_capital: 50000 }, hidden: true }];
const native = (type = 'moving-average') => ({ type, inputs: { length: 50 }, hidden: true });

describe('template persistence and imports', () => {
    it('uses a storage lock and rejects stale writes across windows without losing the first save', async () => {
        const port = storage(), first = new ChartTemplateStore(port, locks), second = new ChartTemplateStore(port, locks);
        expect(first.read().revision).toBe(0); const initial = await first.update(0, () => [template()]);
        expect(initial.revision).toBe(1); expect(locks.request).toHaveBeenCalled();
        await expect(second.update(0, () => [])).rejects.toThrow('another window');
        expect(second.read().templates[0]!.name).toBe('NQ setup');
    });
    it('keeps archived templates and their sources for restoration', async () => {
        const store = new ChartTemplateStore(storage(), locks);
        const source = template(); if (source.kind === 'indicators') source.data.scripts = scripts();
        await store.update(0, () => [source]);
        await store.update(1, (items) => items.map((item) => ({ ...item, archived: true, revision: 2 })));
        const saved = store.read().templates[0]!; expect(saved.archived).toBe(true);
        if (saved.kind === 'indicators') expect(saved.data.scripts[0]!.props).toEqual({ initial_capital: 50000 });
        await store.update(2, (items) => items.map((item) => ({ ...item, archived: false, revision: 3 })));
        expect(store.read().templates[0]!.archived).toBe(false);
    });
    it('preserves existing storage on malformed, oversized or uncoordinated updates', async () => {
        const port = storage(), store = new ChartTemplateStore(port, locks); await store.update(0, () => [template()]);
        const before = port.getItem(CHART_TEMPLATES_KEY);
        await expect(store.update(1, () => Array.from({ length: 51 }, (_, index) => ({ ...template(), id: `id-${index}` })))).rejects.toThrow('50 templates');
        expect(port.getItem(CHART_TEMPLATES_KEY)).toBe(before);
        await expect(new ChartTemplateStore(port, undefined).update(1, () => [])).rejects.toThrow('safely save');
        expect(port.getItem(CHART_TEMPLATES_KEY)).toBe(before);
    });
    it('rejects prototype payloads, invalid sources and invalid indicator values', () => {
        const hostile = JSON.parse(JSON.stringify(template()).replace('"natives":[]', '"natives":[],"__proto__":{"polluted":true}'));
        expect(() => validateChartTemplate(hostile)).toThrow('Invalid template field');
        const invalid = template(); if (invalid.kind === 'indicators') invalid.data.scripts = [{ ...scripts()[0]!, language: 'javascript' }];
        expect(() => validateChartTemplate(invalid)).toThrow('Invalid saved script');
        const bad = template(); if (bad.kind === 'indicators') bad.data.natives = [{ ...native(), inputs: { period: Number.NaN } }];
        expect(() => validateChartTemplate(bad)).toThrow('number');
    });
    it('sanitizes workspace extensions and validates Pine before keeping a layout', () => {
        const layout = { ...template(), kind: 'workspace', data: { version: 1, layout: '4', ext: { 'unrelated.credentials': { key: 'omitted' } }, charts: [{ id: 'c1', symbol: 'replay:NQM4', drawings: { drawings: [] }, ext: { 'other.settings': {}, 'local.pine': scripts() } }] } };
        const saved = validateChartTemplate(layout);
        if (saved.kind !== 'workspace') throw new Error('wrong kind');
        expect(saved.data.ext).toBeUndefined(); expect(saved.data.charts[0]!.ext).toEqual({ 'local.pine': scripts() });
        expect(saved.data.charts[0]!.drawings).toEqual({ drawings: [] });
    });
});

describe('indicator templates', () => {
    it('captures native settings and full Pine source, properties and hidden state', () => {
        const nativeHandle = handle('SMA', 'moving-average'), pine = handle('Pine', undefined, 'strategy("Example")'); pine.setVisible(false);
        const captured = captureIndicatorTemplate({ indicators: () => [nativeHandle, pine] });
        expect(captured.natives).toEqual([{ type: 'moving-average', inputs: { length: 20 }, hidden: false }]);
        expect(captured.scripts[0]).toMatchObject({ script: 'strategy("Example")', inputs: { length: 20 }, props: { initial_capital: 50000 }, hidden: true });
    });
    it('removes old indicators only after all replacement studies run and preserves script settings', async () => {
        const old = handle('original', 'moving-average'), { port, added } = chart([old]);
        await applyIndicatorTemplate(port, { natives: [native()], scripts: scripts() }, 'replace');
        expect(old.remove).toHaveBeenCalledOnce(); expect(added).toHaveLength(2); expect(added.every((item) => !item.visible)).toBe(true);
        expect(port.runIndicator).toHaveBeenCalledWith('indicator("Test")', expect.objectContaining({ inputs: { length: 14 }, props: { initial_capital: 50000 }, language: 'pine' }));
    });
    it('keeps the original setup if a staged script fails or exceeds its engine budget', async () => {
        const old = handle('original', 'moving-average'), { port, added } = chart([old]);
        port.runIndicator.mockResolvedValue({ ok: false, handle: null!, error: new Error('Script budget reached') as never, context: null });
        await expect(applyIndicatorTemplate(port, { natives: [native()], scripts: scripts() }, 'replace')).rejects.toThrow('budget');
        expect(old.remove).not.toHaveBeenCalled(); expect(added[0]!.remove).toHaveBeenCalledOnce();
    });
    it('cancels a pending application when the active cell changes', async () => {
        const old = handle('original', 'moving-average'), { port, added } = chart([old]); let current = true;
        port.runIndicator.mockImplementation(async () => { const next = handle('staged', undefined, 'indicator("Test")'); added.push(next); current = false; return { ok: true, handle: next, error: null, context: null }; });
        await expect(applyIndicatorTemplate(port, { natives: [], scripts: scripts() }, 'replace', () => current)).rejects.toThrow('active chart changed');
        expect(old.remove).not.toHaveBeenCalled(); expect(added[0]!.remove).toHaveBeenCalledOnce();
    });
    it('updates an existing singleton only when replacement validation succeeds', async () => {
        const old = handle('Volume', 'volume'), { port } = chart([old]);
        await applyIndicatorTemplate(port, { natives: [native('volume')], scripts: [] }, 'replace');
        expect(port.addNativeIndicator).not.toHaveBeenCalled(); expect(old.inputValues()).toEqual({ length: 50 }); expect(old.visible).toBe(false); expect(old.remove).not.toHaveBeenCalled();
        await expect(applyIndicatorTemplate(port, { natives: [native('volume')], scripts: [] }, 'append')).rejects.toThrow('already exists');
        expect(old.remove).not.toHaveBeenCalled();
    });
    it('adds studies without removing existing indicators and rejects unsupported data-dependent studies', async () => {
        const old = handle('original', 'moving-average'), { port } = chart([old]);
        await applyIndicatorTemplate(port, { natives: [native()], scripts: [] }, 'append'); expect(old.remove).not.toHaveBeenCalled();
        await expect(applyIndicatorTemplate(port, { natives: [native('footprint')], scripts: [] }, 'replace')).rejects.toThrow('unavailable'); expect(old.remove).not.toHaveBeenCalled();
    });
    it('keeps edits to untouched singleton studies when a staged script fails', async () => {
        const old = handle('Volume', 'volume'), { port } = chart([old]);
        port.runIndicator.mockImplementation(async () => {
            old.setInputs({ length: 33 }); old.setVisible(false);
            return { ok: false, handle: null!, error: new Error('Compile failed') as never, context: null };
        });
        await expect(applyIndicatorTemplate(port, { natives: [native('volume')], scripts: scripts() }, 'replace')).rejects.toThrow('Compile failed');
        expect(old.inputValues()).toEqual({ length: 33 }); expect(old.visible).toBe(false);
        expect(old.remove).not.toHaveBeenCalled();
    });
    it('restores only changed singleton settings after a partial commit fails', async () => {
        const old = handle('Volume', 'volume'), { port, added } = chart([old]);
        const setVisible = vi.mocked(old.setVisible).getMockImplementation()!;
        vi.spyOn(old, 'setVisible').mockImplementationOnce(() => { throw new Error('Apply failed'); }).mockImplementation(setVisible);
        await expect(applyIndicatorTemplate(port, { natives: [native(), native('volume')], scripts: [] }, 'replace')).rejects.toThrow('Apply failed');
        expect(added[0]!.remove).toHaveBeenCalledOnce();
        expect(old.inputValues()).toEqual({ length: 20 }); expect(old.visible).toBe(true);
        expect(old.remove).not.toHaveBeenCalled();
    });
});

describe('template panel workflow', () => {
    it('offers an explicit light plot preset without overwriting saved templates', async () => {
        Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
        const host = document.createElement('div'); document.body.append(host);
        const applyConfig = vi.fn(), set = vi.fn(), applyStatusPrefs = vi.fn();
        const port = { renderer: { applyConfig, set } };
        const cell = { id: 'c1', chart: port, statusPrefs: () => ({ parts: null, indicatorTitles: true, indicatorValues: true, watermark: true, replayWatermark: true }), applyStatusPrefs };
        const workspace = { active: cell, cell: () => cell } as unknown as VelaWorkspace;
        const onChange = vi.fn();
        const panel = mountChartTemplates(host, { workspace, applyWorkspace: vi.fn(), onChange }); disposers.push(panel.destroy);
        expect(applyConfig).not.toHaveBeenCalled();
        host.querySelector<HTMLButtonElement>('[data-action="light-plot"]')!.click();
        await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce());
        expect(applyConfig).toHaveBeenCalledWith(expect.objectContaining({ layout: expect.objectContaining({ backgroundGradient: { topColor: '#ffffff', bottomColor: '#d9d9d9' } }) }));
        expect(applyStatusPrefs).toHaveBeenCalledWith(expect.objectContaining({ watermark: false, replayWatermark: false }));
        expect(localStorage.getItem(CHART_TEMPLATES_KEY)).toBeNull();
    });

    it('saves, searches, renames, archives and restores templates through working controls', async () => {
        Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
        const host = document.createElement('div'); document.body.append(host);
        const { port } = chart([handle('SMA', 'moving-average')]);
        const workspace = { active: { id: 'c1', chart: port }, cell: () => ({ chart: port }) } as unknown as VelaWorkspace;
        const panel = mountChartTemplates(host, { workspace, applyWorkspace: vi.fn(), onChange: vi.fn() }); disposers.push(panel.destroy);
        host.querySelector<HTMLInputElement>('.template-capture input')!.value = 'Morning';
        host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(host.querySelector('.template-card strong')?.textContent).toBe('Morning'));
        const click = (action: string): void => host.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click();
        click('rename'); host.querySelector<HTMLInputElement>('.template-rename input')!.value = 'London';
        host.querySelector('.template-rename')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(host.querySelector('.template-card strong')?.textContent).toBe('London'));
        const search = host.querySelector<HTMLInputElement>('[data-search]')!; search.value = 'Missing'; search.dispatchEvent(new Event('input', { bubbles: true })); expect(host.querySelector('.template-card')).toBeNull();
        search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); click('archive');
        await vi.waitFor(() => expect(host.querySelector('.template-card')).toBeNull());
        const archived = host.querySelector<HTMLInputElement>('[data-archived]')!; archived.checked = true; archived.dispatchEvent(new Event('change', { bubbles: true })); click('restore');
        await vi.waitFor(() => expect(host.querySelector('.template-card')).toBeNull());
        archived.checked = false; archived.dispatchEvent(new Event('change', { bubbles: true })); expect(host.querySelector('.template-card strong')?.textContent).toBe('London');
    });
});

describe('template favorites and recents', () => {
    it('keeps legacy templates readable and persists favorites and bounded, deduplicated recent use', async () => {
        const port = storage();
        const templates = Array.from({ length: 25 }, (_, i) => ({ ...template(), id: `setup-${i}` }));
        port.setItem(CHART_TEMPLATES_KEY, JSON.stringify({ version: 1, revision: 1, templates }));
        const store = new ChartTemplateStore(port, locks);
        expect(store.read().settings).toEqual({ favorites: [], recent: [] });
        await store.setFavorite(1, 'setup-0', true);
        for (const item of templates) await store.recordRecent(item.id, item.revision);
        await store.recordRecent('setup-12', 1);
        const restored = new ChartTemplateStore(port, locks).read();
        expect(restored.settings.favorites).toEqual(['setup-0']);
        expect(restored.settings.recent).toHaveLength(20);
        expect(restored.settings.recent[0]).toBe('setup-12');
        expect(new Set(restored.settings.recent).size).toBe(20);
        await store.setFavorite(restored.revision, 'setup-0', false);
        expect(store.read().settings.favorites).toEqual([]);
    });

    it('prunes missing references without changing template identities or writing on read', () => {
        const port = storage(), raw = JSON.stringify({ version: 1, revision: 4, templates: [template()], settings: { favorites: ['gone', 'setup-1', 'setup-1'], recent: ['gone', 'setup-1'] } });
        port.setItem(CHART_TEMPLATES_KEY, raw);
        expect(new ChartTemplateStore(port, locks).read().settings).toEqual({ favorites: ['setup-1'], recent: ['setup-1'] });
        expect(port.getItem(CHART_TEMPLATES_KEY)).toBe(raw);
    });

    it.each([
        { favorites: 'setup-1', recent: [] },
        { favorites: [123], recent: [] },
        { favorites: ['bad/id'], recent: [] },
        { favorites: [], recent: Array(21).fill('setup-1') },
        { favorites: Array(51).fill('setup-1'), recent: [] },
    ])('preserves malformed settings without silently replacing them: %j', async (settings) => {
        const port = storage(), raw = JSON.stringify({ version: 1, revision: 1, templates: [template()], settings });
        port.setItem(CHART_TEMPLATES_KEY, raw);
        const store = new ChartTemplateStore(port, locks);
        expect(() => store.read()).toThrow(/settings/i);
        await expect(store.setFavorite(1, 'setup-1', true)).rejects.toThrow(/settings/i);
        expect(port.getItem(CHART_TEMPLATES_KEY)).toBe(raw);
    });

    it('rejects stale edits, archived use and failed storage writes without losing prior preferences', async () => {
        const port = storage(), store = new ChartTemplateStore(port, locks);
        await store.update(0, () => [template()]);
        await store.setFavorite(1, 'setup-1', true);
        await expect(store.setFavorite(1, 'setup-1', false)).rejects.toThrow('another window');
        await store.update(2, items => items.map(item => ({ ...item, archived: true, revision: 2 })));
        await expect(store.recordRecent('setup-1', 1)).rejects.toThrow(/changed|archived/);
        expect(store.read().settings).toEqual({ favorites: ['setup-1'], recent: [] });
        const before = port.getItem(CHART_TEMPLATES_KEY);
        vi.spyOn(port, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
        await expect(store.setFavorite(3, 'setup-1', false)).rejects.toThrow('Storage full');
        expect(port.getItem(CHART_TEMPLATES_KEY)).toBe(before);
    });
    it('merges recent use with newer favorites and cancels a write queued behind a lock', async () => {
        const port = storage(), store = new ChartTemplateStore(port, locks);
        await store.update(0, () => [template()]);
        let enter!: () => void;
        const queued = { request: (_key: string, callback: () => unknown) => new Promise(resolve => { enter = () => resolve(callback()); }) } as unknown as LockManager;
        const pending = new ChartTemplateStore(port, queued).recordRecent('setup-1', 1);
        await store.setFavorite(1, 'setup-1', true); enter(); await pending;
        expect(store.read().settings).toEqual({ favorites: ['setup-1'], recent: ['setup-1'] });
        const before = port.getItem(CHART_TEMPLATES_KEY); let current = true;
        // The callback can throw while the lock is entered, just as the real lock promise rejects.
        const cancelledLocks = { request: (_key: string, callback: () => unknown) => new Promise((resolve, reject) => { enter = () => { try { resolve(callback()); } catch (error) { reject(error); } }; }) } as unknown as LockManager;
        const cancelled = new ChartTemplateStore(port, cancelledLocks).recordRecent('setup-1', 1, () => current);
        current = false; enter(); await expect(cancelled).rejects.toThrow('active chart changed');
        expect(port.getItem(CHART_TEMPLATES_KEY)).toBe(before);
    });
});

function panelFixture() {
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    const host = document.createElement('div'); document.body.append(host);
    const { port, added } = chart([handle('original', 'moving-average')]);
    const chartEvents = new Map<string, () => void>(), workspaceEvents = new Map<string, () => void>();
    const target = { ...port, market: { symbol: 'replay:NQM4', timeframe: '1', offline: true }, setMarket: vi.fn(),
        on: vi.fn((event: string, listener: () => void) => { chartEvents.set(event, listener); return () => chartEvents.delete(event); }) };
    const cell = { id: 'c1', chart: target };
    const workspace = { active: cell, cell: () => cell,
        on: vi.fn((event: string, listener: () => void) => { workspaceEvents.set(event, listener); return () => workspaceEvents.delete(event); }) };
    const onChange = vi.fn(async () => {}), applyWorkspace = vi.fn(async () => {});
    const mount = () => { const panel = mountChartTemplates(host, { workspace: workspace as unknown as VelaWorkspace, onChange, applyWorkspace }); disposers.push(panel.destroy); return panel; };
    return { host, target, added, chartEvents, workspaceEvents, workspace, onChange, applyWorkspace, mount };
}

describe('favorite and recent template application', () => {
    it('uses accessible favorite and recent controls, restores them on remount and keeps the replay market pinned', async () => {
        const store = new ChartTemplateStore(localStorage, locks);
        await store.update(0, () => [template()]);
        const fixture = panelFixture(), panel = fixture.mount(), { host } = fixture;
        const favorite = host.querySelector<HTMLButtonElement>('[data-action="favorite"]')!;
        expect(favorite?.getAttribute('aria-pressed')).toBe('false');
        favorite.focus(); favorite.click();
        await vi.waitFor(() => expect(host.querySelector('[data-action="favorite"]')?.getAttribute('aria-pressed')).toBe('true'));
        expect(document.activeElement?.getAttribute('data-action')).toBe('favorite');
        const quick = host.querySelector<HTMLButtonElement>('.template-favorites [data-action="apply"]')!;
        expect(quick?.getAttribute('aria-label')).toContain('NQ setup'); quick.click();
        await vi.waitFor(() => expect(fixture.onChange).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(store.read().settings.recent).toEqual(['setup-1']));
        expect(fixture.target.setMarket).not.toHaveBeenCalled();
        expect(fixture.target.market.symbol).toBe('replay:NQM4');
        panel.destroy(); fixture.mount();
        host.querySelector<HTMLButtonElement>('.template-recents [data-action="apply"]')!.click();
        await vi.waitFor(() => expect(fixture.onChange).toHaveBeenCalledTimes(2));
        const collection = host.querySelector<HTMLSelectElement>('[data-collection]')!;
        collection.value = 'favorites'; collection.dispatchEvent(new Event('change', { bubbles: true }));
        expect(host.querySelectorAll('.template-list .template-card')).toHaveLength(1);
        expect(host.querySelector('.template-note')?.textContent).toContain('pane placement and order are not included');
    });

    it('never applies a stale favorite even when its storage event has not arrived', async () => {
        const store = new ChartTemplateStore(localStorage, locks);
        await store.update(0, () => [template()]); await store.setFavorite(1, 'setup-1', true);
        const fixture = panelFixture(); fixture.mount();
        await store.update(2, items => items.map(item => ({ ...item, archived: true, revision: 2 })));
        fixture.host.querySelector<HTMLButtonElement>('.template-favorites [data-action="apply"]')!.click();
        await vi.waitFor(() => expect(fixture.host.querySelector('.template-message')?.textContent).toMatch(/changed|archived/));
        expect(fixture.target.availableNativeIndicators).not.toHaveBeenCalled();
        expect(fixture.onChange).not.toHaveBeenCalled();
        expect(store.read().settings.recent).toEqual([]);
    });

    it('keeps malformed preference storage intact and offers a working refresh after recovery', () => {
        const raw = JSON.stringify({ version: 1, revision: 1, templates: [template()], settings: { favorites: null, recent: [] } });
        localStorage.setItem(CHART_TEMPLATES_KEY, raw);
        const fixture = panelFixture(); fixture.mount();
        expect(fixture.host.querySelector('.template-message')?.textContent).toMatch(/settings/i);
        expect(localStorage.getItem(CHART_TEMPLATES_KEY)).toBe(raw);
        localStorage.setItem(CHART_TEMPLATES_KEY, JSON.stringify({ version: 1, revision: 1, templates: [template()] }));
        fixture.host.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.click();
        expect(fixture.host.querySelector('.template-card strong')?.textContent).toBe('NQ setup');
    });

    it('rolls back staged studies when the template changes during compilation, before removing originals', async () => {
        const source = template(); if (source.kind === 'indicators') source.data = { natives: [native()], scripts: scripts() };
        const store = new ChartTemplateStore(localStorage, locks); await store.update(0, () => [source]);
        const fixture = panelFixture(); fixture.mount();
        let settle!: (result: Awaited<ReturnType<typeof fixture.target.runIndicator>>) => void;
        fixture.target.runIndicator.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
        fixture.host.querySelector<HTMLButtonElement>('[data-action="apply"]')!.click();
        await vi.waitFor(() => expect(fixture.target.runIndicator).toHaveBeenCalledOnce());
        await store.update(1, items => items.map(item => ({ ...item, revision: 2, name: 'Changed setup' })));
        const staged = handle('pending', undefined, 'indicator("Test")');
        settle({ ok: true, handle: staged, error: null, context: null });
        await vi.waitFor(() => expect(fixture.added[0]!.remove).toHaveBeenCalledOnce());
        expect(staged.remove).toHaveBeenCalledOnce();
        expect(fixture.target.indicators()[0]!.remove).not.toHaveBeenCalled();
        expect(fixture.onChange).not.toHaveBeenCalled();
        expect(store.read().settings.recent).toEqual([]);
    });

    it('reports applied state separately when recent-use storage fails and retains prior favorites', async () => {
        const store = new ChartTemplateStore(localStorage, locks); await store.update(0, () => [template()]); await store.setFavorite(1, 'setup-1', true);
        const fixture = panelFixture(); fixture.mount();
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
        fixture.host.querySelector<HTMLButtonElement>('.template-favorites [data-action="apply"]')!.click();
        await vi.waitFor(() => expect(fixture.host.querySelector('.template-message')?.textContent).toContain('applied. Recent use could not be saved'));
        expect(fixture.onChange).toHaveBeenCalledOnce();
        expect(store.read().settings).toEqual({ favorites: ['setup-1'], recent: [] });
    });

    it.each(['failure', 'destroy', 'cell-switch', 'market-switch'])('does not record recent use or persist a partial application after %s', async (reason) => {
        const source = template(); if (source.kind === 'indicators') source.data = { natives: [native()], scripts: scripts() };
        const store = new ChartTemplateStore(localStorage, locks); await store.update(0, () => [source]); await store.setFavorite(1, source.id, true);
        const fixture = panelFixture(), panel = fixture.mount();
        let settle!: (result: Awaited<ReturnType<typeof fixture.target.runIndicator>>) => void;
        fixture.target.runIndicator.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
        fixture.host.querySelector<HTMLButtonElement>('.template-favorites [data-action="apply"]')!.click();
        await vi.waitFor(() => expect(fixture.target.runIndicator).toHaveBeenCalledOnce());
        if (reason === 'destroy') panel.destroy();
        if (reason === 'cell-switch') fixture.workspaceEvents.get('cell:active')?.();
        if (reason === 'market-switch') fixture.chartEvents.get('load:start')?.();
        const staged = handle('pending', undefined, 'indicator("Test")');
        settle(reason === 'failure' ? { ok: false, handle: null!, error: new Error('Compile failed') as never, context: null } : { ok: true, handle: staged, error: null, context: null });
        await vi.waitFor(() => expect(fixture.added[0]!.remove).toHaveBeenCalledOnce());
        expect(fixture.target.indicators()[0]!.remove).not.toHaveBeenCalled();
        expect(fixture.onChange).not.toHaveBeenCalled();
        expect(store.read().settings.recent).toEqual([]);
        expect(fixture.target.setMarket).not.toHaveBeenCalled();
        expect(fixture.chartEvents.size).toBe(0); expect(fixture.workspaceEvents.size).toBe(0);
    });
});
