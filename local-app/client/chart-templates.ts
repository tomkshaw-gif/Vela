import type { IndicatorHandle, InputValue, Vela } from '../../src/index';
import { sanitizeState, type VelaWorkspace, type WorkspaceState } from '../../src/workspace';
import type { ExternalIndicatorEntry } from '../../src/plugin';
import { chartScripts, validatedScripts } from './script-persistence';
import { escapeHtml as esc } from './util';
import { applyLightPlotAppearance } from './chart-appearance';

export const CHART_TEMPLATES_KEY = 'vela.local.chart-templates.v1';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TEMPLATES = 50;
type Kind = 'indicators' | 'appearance' | 'workspace';
interface NativeEntry { type: string; inputs: Record<string, InputValue>; hidden: boolean }
export interface IndicatorTemplateData { natives: NativeEntry[]; scripts: ExternalIndicatorEntry[] }
interface Metadata { id: string; name: string; createdAt: string; updatedAt: string; revision: number; archived: boolean }
export type ChartTemplate = Metadata & (
    { kind: 'indicators'; data: IndicatorTemplateData } |
    { kind: 'appearance'; data: { rendererConfig: unknown; priceStyle: string } } |
    { kind: 'workspace'; data: WorkspaceState }
);
export interface TemplateDocument { version: 1; revision: number; templates: ChartTemplate[] }
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type TemplateChart = Pick<Vela, 'indicators' | 'availableNativeIndicators' | 'addNativeIndicator' | 'runIndicator'>;
const KIND_LABEL: Record<Kind, string> = { indicators: 'Indicators', appearance: 'Chart appearance', workspace: 'Workspace layout' };
function fail(message: string): never { throw new Error(message); }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const text = (value: unknown, max: number): string => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : fail('Invalid template text.');
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('Invalid template object.');

function validateJson(value: unknown, depth = 0, count = { value: 0 }): void {
    if (depth > 24 || ++count.value > 100000) fail('Template structure is too large.');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('Invalid template number.'); return; }
    if (typeof value === 'string') { if (value.length > 1_000_000) fail('Template text is too large.'); return; }
    if (!value || typeof value !== 'object' || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('Templates must contain plain JSON.');
    for (const [key, item] of Object.entries(value as object)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('Invalid template field.');
        validateJson(item, depth + 1, count);
    }
}
function values(value: unknown): Record<string, InputValue> {
    const input = record(value);
    if (Object.keys(input).length > 256) fail('Too many indicator settings.');
    for (const [key, item] of Object.entries(input)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key) || key.length > 200 || !['number', 'string', 'boolean'].includes(typeof item) || typeof item === 'number' && !Number.isFinite(item) || typeof item === 'string' && item.length > 10000) fail('Invalid indicator setting.');
    }
    return clone(input) as Record<string, InputValue>;
}
function indicatorData(value: unknown): IndicatorTemplateData {
    const data = record(value);
    if (!Array.isArray(data.natives) || !Array.isArray(data.scripts) || data.natives.length + data.scripts.length > 64) fail('A template supports up to 64 indicators.');
    const natives = data.natives.map((item: unknown) => {
        const entry = record(item);
        if (typeof entry.type !== 'string' || !/^[a-zA-Z][\w.-]{0,127}$/.test(entry.type) || typeof entry.hidden !== 'boolean') fail('Invalid native indicator template.');
        return { type: entry.type as string, hidden: entry.hidden as boolean, inputs: values(entry.inputs) };
    });
    return clone({ natives, scripts: validatedScripts(data.scripts) });
}
function workspaceData(value: unknown): WorkspaceState {
    const state = sanitizeState(value);
    if (!state || state.charts.length < 1 || state.charts.length > 16) fail('Invalid workspace layout template.');
    // Only the chart's public script document belongs in a portable template.
    delete state.ext;
    for (const chart of state.charts) {
        const scripts = chart.ext?.['local.pine'];
        chart.ext = scripts === undefined ? undefined : { 'local.pine': validatedScripts(scripts) };
    }
    return clone(state);
}
export function validateChartTemplate(value: unknown): ChartTemplate {
    validateJson(value);
    const template = record(value);
    const id = text(template.id, 128);
    if (!/^[\w.-]+$/.test(id) || !Number.isSafeInteger(template.revision) || (template.revision as number) < 1 || typeof template.archived !== 'boolean') fail('Invalid template identity.');
    const createdAt = text(template.createdAt, 40), updatedAt = text(template.updatedAt, 40);
    if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) fail('Invalid template date.');
    const meta: Metadata = { id, name: text(template.name, 120), createdAt, updatedAt, revision: template.revision as number, archived: template.archived };
    if (template.kind === 'indicators') return { ...meta, kind: 'indicators', data: indicatorData(template.data) };
    if (template.kind === 'workspace') return { ...meta, kind: 'workspace', data: workspaceData(template.data) };
    if (template.kind !== 'appearance') fail('Unknown template kind.');
    const data = record(template.data);
    return { ...meta, kind: 'appearance', data: { rendererConfig: clone(record(data.rendererConfig)), priceStyle: text(data.priceStyle, 128) } };
}
function decode(raw: string | null): TemplateDocument {
    if (raw === null) return { version: 1, revision: 0, templates: [] };
    if (new TextEncoder().encode(raw).length > MAX_BYTES) fail('Template storage exceeds 5 MiB. Export a backup before changing it.');
    const data = record(JSON.parse(raw));
    if (data.version !== 1 || !Number.isSafeInteger(data.revision) || (data.revision as number) < 0 || !Array.isArray(data.templates) || data.templates.length > MAX_TEMPLATES) fail('Invalid template storage. Existing data was preserved.');
    const templates = data.templates.map(validateChartTemplate);
    if (new Set(templates.map((template) => template.id)).size !== templates.length) fail('Duplicate template identity.');
    return { version: 1, revision: data.revision as number, templates };
}

export class ChartTemplateStore {
    constructor(private storage: StoragePort, private locks: Pick<LockManager, 'request'> | undefined) {}
    read(): TemplateDocument { return decode(this.storage.getItem(CHART_TEMPLATES_KEY)); }
    async update(expectedRevision: number, change: (templates: ChartTemplate[]) => ChartTemplate[]): Promise<TemplateDocument> {
        if (!this.locks) fail('This browser cannot safely save shared templates. Use the local desktop browser.');
        return this.locks.request(CHART_TEMPLATES_KEY, () => {
            const current = this.read();
            if (current.revision !== expectedRevision) fail('Templates changed in another window. Refresh the list and try again.');
            const templates = change(clone(current.templates)).map(validateChartTemplate);
            if (templates.length > MAX_TEMPLATES) fail('Template storage holds 50 templates, including archived templates. Export a backup to keep additional setups.');
            if (new Set(templates.map((template) => template.id)).size !== templates.length) fail('Duplicate template identity.');
            const next: TemplateDocument = { version: 1, revision: current.revision + 1, templates };
            const serialized = JSON.stringify(next);
            if (new TextEncoder().encode(serialized).length > MAX_BYTES) fail('Template storage is limited to 5 MiB. Current templates were preserved.');
            this.storage.setItem(CHART_TEMPLATES_KEY, serialized);
            return next;
        });
    }
}

export function captureIndicatorTemplate(chart: Pick<Vela, 'indicators'>): IndicatorTemplateData {
    const natives = chart.indicators().filter((handle) => handle.nativeType !== undefined).map((handle) => ({ type: handle.nativeType!, inputs: handle.inputValues(), hidden: !handle.visible }));
    return indicatorData(clone({ natives, scripts: chartScripts(chart as Vela) }));
}

/** Validate new studies before removing the current setup. */
export async function applyIndicatorTemplate(chart: TemplateChart, input: IndicatorTemplateData, mode: 'replace' | 'append', current: () => boolean = () => true): Promise<void> {
    const data = indicatorData(input);
    const original = chart.indicators();
    const catalog = await chart.availableNativeIndicators();
    const staged: IndicatorHandle[] = [];
    const reused = new Map<IndicatorHandle, { entry: NativeEntry; inputs: Record<string, InputValue>; visible: boolean }>();
    const assertCurrent = (): void => { if (!current()) fail('The active chart changed. Its previous indicators were kept.'); };
    try {
        assertCurrent();
        const singleton = new Set<string>();
        for (const entry of data.natives) {
            const info = catalog.find((item) => item.type === entry.type);
            if (!info?.supported) fail(`Indicator ${entry.type} is unavailable for this chart.`);
            const existing = !info.multiInstance ? original.find((handle) => handle.nativeType === entry.type) : undefined;
            if (!info.multiInstance && singleton.has(entry.type)) fail(`Indicator ${entry.type} supports one instance.`);
            singleton.add(entry.type);
            if (existing) {
                if (mode === 'append') fail(`Indicator ${entry.type} already exists. Use Replace indicators to change its settings.`);
                reused.set(existing, { entry, inputs: existing.inputValues(), visible: existing.visible });
            } else {
                const added = chart.addNativeIndicator(entry.type, { inputs: entry.inputs });
                if (original.includes(added)) fail(`Indicator ${entry.type} could not be added as a separate instance.`);
                staged.push(added); added.setVisible(!entry.hidden);
            }
        }
        for (const script of data.scripts) {
            assertCurrent();
            const result = await chart.runIndicator(script.script, { id: `template-${crypto.randomUUID()}`, title: script.name, language: 'pine', inputs: script.inputs, props: script.props });
            if (!result.ok || !result.handle) throw result.error ?? new Error(`Could not run ${script.name}.`);
            staged.push(result.handle); assertCurrent(); result.handle.setVisible(!script.hidden);
        }
        assertCurrent();
        for (const [handle, { entry }] of reused) { handle.setInputs(entry.inputs); handle.setVisible(!entry.hidden); }
        if (mode === 'replace') for (const handle of original) if (!reused.has(handle)) handle.remove();
    } catch (error) {
        staged.forEach((handle) => handle.remove());
        for (const [handle, prior] of reused) { handle.setInputs(prior.inputs); handle.setVisible(prior.visible); }
        throw error;
    }
}

interface MountOptions {
    workspace: VelaWorkspace;
    onChange: () => Promise<void>;
    applyWorkspace: (state: WorkspaceState) => Promise<void>;
    blocked?: () => boolean;
}
export function mountChartTemplates(host: HTMLElement, options: MountOptions): { destroy: () => void } {
    const { workspace } = options;
    const win = host.ownerDocument.defaultView!;
    const store = new ChartTemplateStore(win.localStorage, win.navigator.locks);
    let document = store.read();
    let disposed = false, busy = false;
    let search = '', filter = '', archived = false, editing: { id: string; revision: number } | undefined;
    const controller = new AbortController();
    host.classList.add('local-chart-templates');
    host.innerHTML = '<form class="template-capture"><h2>Templates</h2><label>Name<input name="name" maxlength="120" required placeholder="My chart setup"></label><label>Save<select name="kind"><option value="indicators">Indicators</option><option value="appearance">Chart appearance</option><option value="workspace">Workspace layout</option></select></label><button type="submit">Save current setup</button></form><div class="template-filters"><input data-search aria-label="Search templates" placeholder="Search templates"><select data-filter aria-label="Template kind"><option value="">All templates</option><option value="indicators">Indicators</option><option value="appearance">Chart appearance</option><option value="workspace">Workspace layouts</option></select><label><input type="checkbox" data-archived> Show archived</label></div><div class="template-io"><button type="button" data-action="import">Import</button><button type="button" data-action="export-all">Export all</button><button type="button" data-action="refresh">Refresh</button><input type="file" data-file accept=".json,application/json" hidden></div><p class="template-message" role="status" aria-live="polite"></p><div class="template-list"></div><p class="template-note">Saved on this computer. Layouts keep this replay session’s contract. Indicator replacement keeps your drawings. Archive preserves a template for later restoration.</p>';
    host.querySelector('.template-list')!.insertAdjacentHTML('beforebegin', '<article class="template-preset"><strong>Light monochrome</strong><p>Light gradient plot, hollow rising candles and dark menus.</p><button type="button" data-action="light-plot">Apply light monochrome</button></article>');
    const message = (value: string, error = false): void => {
        const status = host.querySelector<HTMLElement>('.template-message')!; status.textContent = value; status.dataset.error = String(error);
    };
    const render = (): void => {
        const list = document.templates.filter((template) => template.archived === archived && (!filter || template.kind === filter) && template.name.toLowerCase().includes(search.toLowerCase())).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        host.querySelector('.template-list')!.innerHTML = list.map((template) => `<article data-id="${esc(template.id)}" class="template-card"><header><strong>${esc(template.name)}</strong><span>${KIND_LABEL[template.kind]}</span></header><small>${esc(new Date(template.updatedAt).toLocaleString())}</small>${editing?.id === template.id ? `<form class="template-rename"><label>New name<input name="name" maxlength="120" required value="${esc(template.name)}"></label><button type="submit">Save name</button><button type="button" data-action="cancel-rename">Cancel</button></form>` : `<div class="template-card-actions">${template.archived ? '<button type="button" data-action="restore">Restore</button>' : `<button type="button" data-action="apply">${template.kind === 'indicators' ? 'Replace indicators' : template.kind === 'workspace' ? 'Apply layout' : 'Apply appearance'}</button>${template.kind === 'indicators' ? '<button type="button" data-action="append">Add indicators</button>' : ''}`}<button type="button" data-action="rename">Rename</button><button type="button" data-action="export">Export</button>${template.archived ? '' : '<button type="button" data-action="archive">Archive</button>'}</div>`}</article>`).join('') || '<p class="template-empty">No matching templates. Save your current setup or import a template.</p>';
        host.querySelectorAll<HTMLElement>('.template-card').forEach((card) => {
            const template = document.templates.find((item) => item.id === card.dataset.id);
            if (template) card.dataset.revision = String(template.revision);
        });
        host.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = busy; });
    };
    const update = async (change: (templates: ChartTemplate[]) => ChartTemplate[]): Promise<void> => {
        document = await store.update(document.revision, change); editing = undefined; render();
    };
    const run = (task: () => Promise<void>): void => {
        if (busy || disposed) return;
        busy = true; render();
        void task().catch((error: unknown) => { if (!disposed) message(error instanceof Error ? error.message : String(error), true); }).finally(() => { busy = false; if (!disposed) render(); });
    };
    const chartCurrent = (): { chart: Vela; current: () => boolean } => {
        if (options.blocked?.()) fail('Pause replay and wait for the current action to finish before applying templates.');
        const cell = workspace.active, chart = cell.chart;
        return { chart, current: () => !disposed && !options.blocked?.() && workspace.active.id === cell.id && workspace.cell(cell.id)?.chart === chart };
    };
    const download = (name: string, templates: ChartTemplate[]): void => {
        const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'vela-chart-templates', version: 1, templates }, null, 2)], { type: 'application/json' }));
        const link = host.ownerDocument.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const edit = (template: ChartTemplate, change: (item: ChartTemplate) => ChartTemplate): Promise<void> => update((templates) => templates.map((item) => {
        if (item.id !== template.id) return item;
        if (item.revision !== template.revision) fail('This template changed in another window. Refresh before editing it.');
        return { ...change(item), revision: item.revision + 1, updatedAt: new Date().toISOString() };
    }));
    host.addEventListener('submit', (event) => {
        event.preventDefault(); const form = event.target as HTMLFormElement;
        const name = text(new FormData(form).get('name'), 120);
        if (form.matches('.template-rename')) {
            const template = document.templates.find((item) => item.id === editing?.id);
            if (template && template.revision === editing?.revision) run(async () => { await edit(template, (item) => ({ ...item, name })); message('Template renamed.'); });
            else message('This template changed. Cancel the edit and refresh before renaming it.', true);
            return;
        }
        const kind = new FormData(form).get('kind') as Kind;
        run(async () => {
            const { chart } = chartCurrent(); const now = new Date().toISOString();
            const metadata: Metadata = { id: crypto.randomUUID(), name, revision: 1, archived: false, createdAt: now, updatedAt: now };
            let template: ChartTemplate;
            if (kind === 'indicators') template = { ...metadata, kind, data: captureIndicatorTemplate(chart) };
            else if (kind === 'appearance') template = { ...metadata, kind, data: { rendererConfig: clone(chart.renderer.getConfig()), priceStyle: String(chart.renderer.get('priceStyle') ?? 'candles') } };
            else template = { ...metadata, kind: 'workspace', data: workspaceData(workspace.getState()) };
            await update((templates) => [...templates, validateChartTemplate(clone(template))]); message(`${KIND_LABEL[template.kind]} template saved.`);
        });
    }, { signal: controller.signal });
    host.addEventListener('input', (event) => {
        const input = event.target as HTMLInputElement;
        if (input.matches('[data-search]')) { search = input.value; render(); }
    }, { signal: controller.signal });
    host.addEventListener('change', (event) => {
        const input = event.target as HTMLInputElement;
        if (input.matches('[data-filter]')) { filter = input.value; render(); }
        if (input.matches('[data-archived]')) { archived = input.checked; render(); }
        if (!input.matches('[data-file]') || !input.files?.[0]) return;
        const file = input.files[0]; input.value = '';
        run(async () => {
            if (file.size > MAX_BYTES) fail('Template import is limited to 5 MiB.');
            const payload = record(JSON.parse(await file.text()));
            if (payload.format !== 'vela-chart-templates' || payload.version !== 1 || !Array.isArray(payload.templates) || payload.templates.length > MAX_TEMPLATES) fail('Unsupported template file.');
            const imported = payload.templates.map(validateChartTemplate).map((template) => ({ ...template, id: crypto.randomUUID(), name: `${template.name.slice(0,109)} (imported)`, revision: 1, archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
            await update((templates) => [...templates, ...imported]); message(`Imported ${imported.length} independent template copies.`);
        });
    }, { signal: controller.signal });
    host.addEventListener('click', (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>('button[data-action]');
        if (!button || busy) return;
        const card = button.closest<HTMLElement>('[data-id]');
        const action = button.dataset.action, template = document.templates.find((item) => item.id === card?.dataset.id);
        if (action === 'light-plot') {
            run(async () => {
                chartCurrent();
                applyLightPlotAppearance(workspace.active);
                await options.onChange(); message('Light monochrome appearance applied.');
            });
            return;
        }
        if (action === 'import') { host.querySelector<HTMLInputElement>('[data-file]')!.click(); return; }
        if (action === 'export-all') { download('vela-chart-templates.json', document.templates); return; }
        if (action === 'refresh') { try { document = store.read(); editing = undefined; render(); message('Template list refreshed.'); } catch (error) { message(String(error), true); } return; }
        if (action === 'cancel-rename') { editing = undefined; render(); return; }
        if (!template) return;
        if (card?.dataset.revision !== String(template.revision)) { message('This template changed in another window. Refresh before using it.', true); return; }
        if (action === 'rename') { editing = { id: template.id, revision: template.revision }; render(); host.querySelector<HTMLInputElement>('.template-rename input')?.focus(); return; }
        if (action === 'export') { download(`vela-template-${template.id}.json`, [template]); return; }
        if (action === 'archive' || action === 'restore') { run(async () => { await edit(template, (item) => ({ ...item, archived: action === 'archive' })); message(action === 'archive' ? 'Template archived. Show archived to restore it.' : 'Template restored.'); }); return; }
        if (action !== 'apply' && action !== 'append') return;
        run(async () => {
            const { chart, current } = chartCurrent();
            if (template.kind === 'indicators') await applyIndicatorTemplate(chart, template.data, action === 'append' ? 'append' : 'replace', current);
            else if (template.kind === 'workspace') await options.applyWorkspace(clone(template.data));
            else { chart.renderer.applyConfig(clone(template.data.rendererConfig)); chart.renderer.set('priceStyle', template.data.priceStyle); }
            await options.onChange(); message(`${template.name} applied.`);
        });
    }, { signal: controller.signal });
    const storage = (event: StorageEvent): void => {
        if (event.key !== CHART_TEMPLATES_KEY) return;
        try { document = store.read(); if (!editing && !busy) render(); message('Templates changed in another window. The list has been refreshed.'); }
        catch (error) { message(String(error), true); }
    };
    win.addEventListener('storage', storage); render();
    return { destroy: () => { disposed = true; controller.abort(); win.removeEventListener('storage', storage); host.replaceChildren(); host.classList.remove('local-chart-templates'); } };
}
