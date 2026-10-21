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
