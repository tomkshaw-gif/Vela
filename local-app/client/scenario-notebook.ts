import { ApiError, type LocalApi } from './api';
import { emptyScenarioContent, parseScenarioContent, parseScenarioContext, scenarioAnnotations, scenarioId, scenarioInteger, scenarioObject, SCENARIO_LIMITS } from '../shared/scenarios';
import type { ScenarioAnnotation, ScenarioCase, ScenarioContent, ScenarioContext, ScenarioDocument, ScenarioSummary, SaveScenarioInput } from '../shared/scenarios';
import './scenario-notebook.css';
export interface ScenarioNotebookOptions { api: LocalApi; storageKey?: string; onPreview?: (annotations: ScenarioAnnotation[], context: ScenarioContext) => void | Promise<void> }
export interface ScenarioNotebook {
    setContext(context: ScenarioContext | null): void;
    /** A proposal remains a local draft until the user clicks Save. */
    propose(content: ScenarioContent): boolean;
    /** Drain explicit saves and durably preserve drafts before desktop ACK. Never autosaves hypotheses. */
    prepare(): Promise<void>; destroy(): void;
}
type RawCase = { [K in keyof ScenarioCase]: string };
interface Form { title: string; bull: RawCase; bear: RawCase; notes: string; evidence: ScenarioContent['evidence'] }
interface Draft {
    key: string; context: ScenarioContext; form: Form; document: ScenarioDocument | null;
    dirty: boolean; watermark: number; generation: number; used: number;
}
const STORAGE_PREFIX = 'vela.local.scenarios.v1';
const MAX_RECOVERY = 1_500_000;
let documentStorageKey: string | undefined;
let initialRecovery: string | null = null;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const same = (a: ScenarioContext, b: ScenarioContext): boolean => JSON.stringify(a) === JSON.stringify(b);
const scope = (c: ScenarioContext): string => `${c.sessionId}:${c.datasetId}:${c.datasetChecksum}`;
function uid(): string { return crypto.randomUUID(); }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
}
function toForm(content: ScenarioContent): Form {
    const raw = (value: ScenarioCase): RawCase => Object.fromEntries(Object.entries(value).map(([key, value]) => [key, value === null ? '' : String(value)])) as RawCase;
    return { title: content.title, notes: content.notes, bull: raw(content.bull), bear: raw(content.bear), evidence: clone(content.evidence) };
}
function content(form: Form): ScenarioContent {
    const number = (value: string): number | null => value.trim() === '' ? null : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) ? Number(value) : NaN;
    const parsed = (value: RawCase): ScenarioCase => ({ ...value, triggerPrice: number(value.triggerPrice), invalidationPrice: number(value.invalidationPrice),
        targetPrice: number(value.targetPrice), projectedTime: number(value.projectedTime) });
    return parseScenarioContent({ title: form.title, notes: form.notes, bull: parsed(form.bull), bear: parsed(form.bear), evidence: form.evidence });
}
function parseForm(value: unknown): Form {
    const v = scenarioObject(value, ['title', 'notes', 'bull', 'bear', 'evidence']);
    const rawCase = (value: unknown): RawCase => {
        const result = scenarioObject(value, ['thesis', 'trigger', 'invalidation', 'triggerPrice', 'invalidationPrice', 'targetPrice', 'projectedTime']);
        for (const [key, text] of Object.entries(result)) if (typeof text !== 'string' || text.length > (key.endsWith('Price') || key === 'projectedTime' ? 128 : 4000)) throw new Error('Invalid draft.');
        if (Object.keys(result).length !== 7) throw new Error('Invalid draft.');
        return result as RawCase;
    };
    const form = { title: v.title, notes: v.notes, bull: rawCase(v.bull), bear: rawCase(v.bear), evidence: v.evidence } as Form;
    if (typeof form.title !== 'string' || form.title.length > 120) throw new Error('Invalid draft.');
    // Incomplete titles remain recoverable text; Save applies the required-title rule.
    parseScenarioContent({ ...emptyScenarioContent(), notes: form.title });
    const safeCase = (raw: RawCase): ScenarioCase => ({ ...raw, triggerPrice: null, invalidationPrice: null, targetPrice: null, projectedTime: null });
    parseScenarioContent({ ...form, title: form.title.trim() ? form.title : 'Untitled scenario', bull: safeCase(form.bull), bear: safeCase(form.bear) });
    return form;
}
function parseSummary(value: unknown): ScenarioSummary {
    const v = scenarioObject(value, ['id', 'title', 'revision', 'createdAt', 'updatedAt', 'archived', 'context', 'content']);
    if (typeof v.title !== 'string' || v.title.length > 120 || typeof v.createdAt !== 'string' || v.createdAt.length > 32
        || typeof v.updatedAt !== 'string' || v.updatedAt.length > 32 || !Number.isFinite(Date.parse(v.createdAt)) || !Number.isFinite(Date.parse(v.updatedAt))
        || typeof v.archived !== 'boolean') throw new Error('Invalid scenario response.');
    return { id: scenarioId(v.id), title: v.title, revision: scenarioInteger(v.revision), createdAt: v.createdAt, updatedAt: v.updatedAt, archived: v.archived, context: parseScenarioContext(v.context) };
}
function parseDocument(value: unknown): ScenarioDocument {
    const summary = parseSummary(value), v = value as Record<string, unknown>, result = { ...summary, content: parseScenarioContent(v.content) };
    if (result.title !== result.content.title) throw new Error('Invalid scenario response.'); return result;
}
/** A reload or copied window forks recovery into a fresh owner key; it never writes another window's key. */
function defaultKey(): string {
    if (!documentStorageKey) {
        const previous = sessionStorage.getItem(STORAGE_PREFIX);
        initialRecovery = previous?.startsWith(`${STORAGE_PREFIX}.`) ? localStorage.getItem(previous) : null;
        documentStorageKey = `${STORAGE_PREFIX}.${uid()}`;
        sessionStorage.setItem(STORAGE_PREFIX, documentStorageKey);
    }
    return documentStorageKey;
}

export function mountScenarioNotebook(host: HTMLElement, options: ScenarioNotebookOptions): ScenarioNotebook {
    const root = node('section', '', 'scenario-notebook'), heading = node('h3', 'Scenario notebook');
    const notice = node('p', 'User hypotheses, without probabilities or order placement.', 'scenario-notice');
    const provenance = node('p', '', 'scenario-provenance'), status = node('p', '', 'scenario-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const toolbar = node('div', '', 'scenario-toolbar'), saved = node('select'), draftsSelect = node('select');
    saved.setAttribute('aria-label', 'Saved scenarios'); draftsSelect.setAttribute('aria-label', 'Local scenario drafts');
    const form = node('div', '', 'scenario-form'), footer = node('p', 'Scenario JSON exports separately. Session export and clone do not include this notebook. Later-cursor saves are hidden after a rewind.', 'scenario-notice');
    root.append(heading, notice, toolbar, provenance, form, status, footer); host.append(root);
    const drafts = new Map<string, Draft>(), busy = new Set<string>(), pending = new Set<Promise<void>>();
    const failures = new Set<string>(); let current: ScenarioContext | null = null, active: Draft | null = null, epoch = 0, sequence = 0, closed = false, preparing = false;
    let summaries: ScenarioSummary[] = [], storageKey = '', storageError = false, recoveryBlocked = false, refreshSequence = 0;
    const message = (text: string) => { if (!closed) status.textContent = text; };
    function persist(): void {
        if (!storageKey || recoveryBlocked) throw new Error('Scenario draft storage is unavailable.');
        const raw = JSON.stringify({ version: 1, drafts: [...drafts.values()] });
        if (raw.length > MAX_RECOVERY) throw new Error('Scenario draft recovery is full. Export a draft before continuing.');
        localStorage.setItem(storageKey, raw); storageError = false;
    }
    function protect(): void { try { persist(); } catch { storageError = true; message('Draft recovery failed. Keep this window open and export your notes.'); } }
    try {
        storageKey = options.storageKey ?? defaultKey();
        const stored = localStorage.getItem(storageKey) ?? (options.storageKey ? null : initialRecovery);
        if (stored !== null) {
            if (stored.length > MAX_RECOVERY) throw new Error('Draft recovery is full.');
            const parsed = scenarioObject(JSON.parse(stored), ['version', 'drafts']);
            if (parsed.version !== 1 || !Array.isArray(parsed.drafts) || parsed.drafts.length > SCENARIO_LIMITS.drafts) throw new Error('Invalid draft recovery.');
            const recovered: Draft[] = parsed.drafts.map(value => {
                const v = scenarioObject(value, ['key', 'context', 'form', 'document', 'dirty', 'watermark', 'generation', 'used']);
                const context = parseScenarioContext(v.context), watermark = scenarioInteger(v.watermark), document = v.document === null ? null : parseDocument(v.document);
                if (typeof v.dirty !== 'boolean' || watermark < context.cursor || document && scope(document.context) !== scope(context)) throw new Error('Invalid draft recovery.');
                return { key: scenarioId(v.key), context, watermark, document, dirty: v.dirty, generation: scenarioInteger(v.generation), used: scenarioInteger(v.used), form: parseForm(v.form) };
            });
            if (new Set(recovered.map(item => item.key)).size !== recovered.length) throw new Error('Invalid draft recovery.');
            for (const draft of recovered) { drafts.set(draft.key, draft); sequence = Math.max(sequence, draft.used); }
            protect();
        }
    } catch { storageError = true; recoveryBlocked = true; message('Draft recovery is unavailable. Existing recovery data is preserved. Keep this window open and export your notes.'); }
    function visible(draft: Draft): boolean {
        return !!current && scope(draft.context) === scope(current) && draft.watermark <= current.cursor && draft.context.cutoff <= current.cutoff;
    }
    function make(context: ScenarioContext, value = emptyScenarioContent(), document: ScenarioDocument | null = null, dirty = false): Draft {
        if (drafts.size >= SCENARIO_LIMITS.drafts) throw new Error('Local draft capacity reached.');
        const draft: Draft = { key: uid(), context: clone(context), form: toForm(value), document, dirty, watermark: context.cursor, generation: 0, used: ++sequence };
        drafts.set(draft.key, draft); return draft;
    }
    function update(target: Draft): void {
        target.generation++; target.dirty = true; target.used = ++sequence; target.watermark = Math.max(target.watermark, current?.cursor ?? target.watermark); protect();
        saveButton.disabled = preparing || busy.has(target.key); archiveButton.disabled = true; message(storageError ? 'Draft recovery failed. Keep this window open and export your notes.' : 'Unsaved local draft. Click Save to persist this hypothesis.');
    }
    function action(label: string, run: () => void): HTMLButtonElement { const button = node('button', label); button.type = 'button'; button.addEventListener('click', () => { if (!closed) run(); }); toolbar.append(button); return button; }
    const newButton = action('New', () => {
        if (!current || preparing) return;
        try { active = make(current); protect(); render(); } catch { message('Local draft capacity reached. Export a draft before continuing.'); }
    });
    toolbar.append(saved, draftsSelect);
    const saveButton = action('Save', () => { void save(false); });
    const saveAsButton = action('Save as new', () => { void save(true); });
    const archiveButton = action('Archive', () => { void archive(); });
    const previewButton = action('Preview levels', () => {
        const target = active; if (!target || !visible(target) || preparing) return;
        try {
            const annotations = scenarioAnnotations(content(target.form));
            if (!annotations.length) { message('Enter a hypothesis level before previewing.'); return; }
            const capturedEpoch = epoch;
            void Promise.resolve(options.onPreview?.(annotations, clone(target.context))).then(() => {
                if (epoch === capturedEpoch && active === target) message('Hypothesis levels previewed. No order is placed.');
            }, () => { if (epoch === capturedEpoch && active === target) message('Could not preview levels. Your draft is preserved.'); });
        } catch { message('Use valid finite prices and UTC millisecond times before previewing.'); }
    });
    const exportButton = action('Export JSON', () => {
        if (!active || !visible(active)) return;
        try {
            const blob = new Blob([JSON.stringify({ format: 'vela-local-scenario', version: 1, hypothesis: true, context: active.context, content: content(active.form),
                ...(active.document ? { id: active.document.id, revision: active.document.revision } : {}) }, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob), anchor = node('a'); anchor.href = url; anchor.download = 'scenario.json'; anchor.click(); URL.revokeObjectURL(url);
            message('Exported standalone scenario JSON. Session exports do not include it.');
        } catch { message('Use valid text and finite levels before exporting JSON. Your draft is preserved.'); }
    });
    const linkButton = action('Link current candle', () => {
        if (!active || !current || preparing) return;
        if (active.form.evidence.some(ref => ref.sourceIndex === current!.cursor)) { message('This candle is already linked.'); return; }
        if (active.form.evidence.length >= SCENARIO_LIMITS.evidence) { message('A scenario can link at most 32 candles.'); return; }
        active.context = clone(current); active.form.evidence.push({ kind: 'candle', sourceIndex: current.cursor, time: current.cutoff, note: '' }); update(active); render();
    });
    const discardButton = action('Discard local draft', () => {
        if (!active || preparing || busy.has(active.key) || !window.confirm('Discard this local draft? Saved library records remain available.')) return;
        const key = active.key; drafts.delete(key); failures.delete(key); epoch++;
        active = [...drafts.values()].filter(visible).sort((a, b) => b.watermark - a.watermark || b.used - a.used)[0] ?? (current ? make(current) : null);
        protect(); render(); message('Discarded the selected local draft. Saved scenarios remain in the library.');
    });
    function selectOption(select: HTMLSelectElement, value: string, text: string): void { const option = node('option', text); option.value = value; select.append(option); }
    function renderLists(): void {
        saved.replaceChildren(); selectOption(saved, '', 'Open saved scenario…');
        for (const item of summaries) selectOption(saved, item.id, `${item.title} · r${item.revision}`);
        draftsSelect.replaceChildren(); selectOption(draftsSelect, '', 'Local drafts…');
        for (const draft of [...drafts.values()].filter(visible).sort((a, b) => b.used - a.used)) selectOption(draftsSelect, draft.key, `${draft.form.title || 'Untitled scenario'}${draft.dirty ? ' *' : ''}`);
        draftsSelect.value = active?.key ?? '';
    }
    function control(parent: HTMLElement, label: string, value: string, change: (value: string) => void, multiline = false, maxLength = 4000): void {
        const wrapper = node('label', label), input = multiline ? node('textarea') : node('input'); input.setAttribute('aria-label', label); input.value = value; input.maxLength = maxLength;
        input.disabled = preparing; input.addEventListener('input', () => { if (closed || preparing) return; change(input.value); }); wrapper.append(input); parent.append(wrapper);
    }
    function render(): void {
        if (closed) return;
        renderLists(); form.replaceChildren(); const target = active && visible(active) ? active : null;
        for (const button of [newButton, saveButton, saveAsButton, previewButton, linkButton, discardButton]) button.disabled = !target || preparing || busy.has(target.key);
        previewButton.disabled ||= !options.onPreview; exportButton.disabled = !target; saved.disabled = !current || preparing; draftsSelect.disabled = !current || preparing;
        archiveButton.disabled = !target?.document || target.dirty || target.document.archived || busy.has(target.key) || preparing;
        if (!target) { provenance.textContent = current ? 'No scenario draft is available at this replay cutoff.' : 'Open a replay session with a revealed candle to write a scenario.'; return; }
        const c = target.context;
        provenance.textContent = `Session ${c.sessionId} · dataset ${c.datasetId} · SHA-256 ${c.datasetChecksum} · source candle ${c.cursor} · ${new Date(c.cutoff).toISOString()}`;
        control(form, 'Scenario title', target.form.title, value => { target.form.title = value; update(target); }, false, 120);
        const cases = node('div', '', 'scenario-cases'); form.append(cases);
        for (const side of ['bull', 'bear'] as const) {
            const group = node('fieldset', '', `scenario-case scenario-${side}`), title = side === 'bull' ? 'Bull' : 'Bear'; group.append(node('legend', `${title} case`)); cases.append(group);
            for (const key of ['thesis', 'trigger', 'invalidation'] as const) control(group, `${title} ${key}`, target.form[side][key], value => { target.form[side][key] = value; update(target); }, true, key === 'thesis' ? 4000 : 2000);
            for (const key of ['triggerPrice', 'invalidationPrice', 'targetPrice', 'projectedTime'] as const) {
                const label = key === 'projectedTime' ? `${title} projected time (UTC ms)` : `${title} ${key.replace('Price', '')} price`;
                control(group, label, target.form[side][key], value => { target.form[side][key] = value; update(target); }, false, 128);
            }
        }
        control(form, 'Notes', target.form.notes, value => { target.form.notes = value; update(target); }, true, 8000);
        const refs = node('div', '', 'scenario-evidence'); refs.append(node('h4', 'Linked candle evidence'));
        if (!target.form.evidence.length) refs.append(node('p', 'No candles linked. Link the current replay candle to record observed evidence.'));
        target.form.evidence.forEach((ref, index) => {
            const row = node('div', '', 'scenario-evidence-row'); row.append(node('p', `Source candle ${ref.sourceIndex} · ${new Date(ref.time).toISOString()}`));
            control(row, `Evidence ${index + 1} note`, ref.note, value => { ref.note = value; update(target); }, false, 1000);
            const remove = node('button', 'Remove evidence'); remove.type = 'button'; remove.disabled = preparing;
            remove.addEventListener('click', () => { target.form.evidence.splice(index, 1); update(target); render(); }); row.append(remove); refs.append(row);
        });
        form.append(refs);
    }
    async function refresh(): Promise<void> {
        if (!current) return;
        const captured = clone(current), capturedEpoch = epoch, capturedRefresh = ++refreshSequence;
        try {
            const response = await options.api.get<unknown>(`/api/sessions/${captured.sessionId}/scenarios`);
            if (closed || epoch !== capturedEpoch || capturedRefresh !== refreshSequence) return;
            if (!Array.isArray(response) || response.length > SCENARIO_LIMITS.records) throw new Error('Invalid response.');
            summaries = response.map(parseSummary).filter(item => scope(item.context) === scope(captured) && item.context.cursor <= captured.cursor && item.context.cutoff <= captured.cutoff && !item.archived);
            renderLists();
        } catch { if (!closed && epoch === capturedEpoch && capturedRefresh === refreshSequence) message('Could not list scenarios. Your local draft is preserved. Later-cursor saves are unavailable after a rewind.'); }
    }
    saved.addEventListener('change', () => {
        if (closed || !current || !saved.value || preparing) return;
        const id = saved.value, capturedEpoch = ++epoch, target = active, generation = target?.generation;
        const captured = clone(current);
        void options.api.get<unknown>(`/api/sessions/${captured.sessionId}/scenarios/${scenarioId(id)}`).then(response => {
            if (closed || epoch !== capturedEpoch || active !== target || target?.generation !== generation) return;
            const document = parseDocument(response);
            if (document.id !== id || scope(document.context) !== scope(captured) || document.context.cursor > captured.cursor || document.context.cutoff > captured.cutoff) throw new Error('Unavailable evidence.');
            const existing = [...drafts.values()].find(draft => draft.document?.id === document.id && !draft.dirty && draft.document.revision === document.revision && visible(draft));
            active = existing ?? make(document.context, document.content, document); active.watermark = Math.max(active.watermark, captured.cursor); active.used = ++sequence; protect(); render();
            message(`Loaded revision ${document.revision}. Other local drafts remain in the draft selector.`);
        }).catch(() => { if (epoch === capturedEpoch) message('Scenario is unavailable at this replay cutoff, or could not be loaded. Your draft is preserved.'); });
    });
    draftsSelect.addEventListener('change', () => {
        const target = drafts.get(draftsSelect.value); if (closed || !target || !visible(target) || preparing) return; epoch++; active = target; target.used = ++sequence; protect(); render(); message(target.dirty ? 'Recovered unsaved local draft.' : 'Local scenario loaded.');
    });
    function track(action: () => Promise<void>, target: Draft): void {
        busy.add(target.key); failures.delete(target.key); render();
        const task = action().catch(error => {
            failures.add(target.key); if (!closed) protect();
            if (active === target && visible(target)) message(error instanceof ApiError && error.status === 409
                ? 'Scenario changed in another window. Your draft is preserved. Save as new to keep both versions.'
                : 'Scenario save failed. Your draft is preserved; retry explicitly or export it.');
        }).finally(() => { busy.delete(target.key); pending.delete(task); if (!closed) { protect(); render(); } });
        pending.add(task);
    }
    async function save(asNew: boolean): Promise<void> {
        if (!active || !current || !visible(active) || preparing || busy.has(active.key)) return;
        const sourceKey = active.key;
        let target = active, submitted: ScenarioContent;
        try {
            submitted = content(target.form);
            if (asNew) { target = make(target.context, submitted, null, true); active = target; target.watermark = current.cursor; protect(); render(); }
        } catch { message('Use a title, bounded text, finite prices and UTC millisecond times before saving.'); return; }
        const generation = target.generation, captured = clone(target.context), watermark = current.cursor;
        const input: SaveScenarioInput = { context: captured, content: submitted, ...(target.document ? { id: target.document.id, expectedRevision: target.document.revision } : {}) };
        track(async () => {
            const result = parseDocument(await options.api.post<unknown>(`/api/sessions/${captured.sessionId}/scenarios`, input));
            if (input.id && result.id !== input.id || !same(result.context, captured) || JSON.stringify(result.content) !== JSON.stringify(submitted)
                || result.revision !== (input.expectedRevision === undefined ? 0 : input.expectedRevision + 1)) throw new Error('Unexpected scenario response.');
            target.document = result; target.watermark = Math.max(target.watermark, watermark); target.dirty = target.generation !== generation; failures.delete(target.key); failures.delete(sourceKey);
            if (active === target && visible(target)) message(target.dirty ? 'Saved submitted revision. Newer typing remains an unsaved local draft.' : `Saved revision ${result.revision}.`);
            if (!closed && current && scope(current) === scope(captured)) void refresh();
        }, target);
    }
    async function archive(): Promise<void> {
        const target = active; if (!target?.document || target.dirty || busy.has(target.key) || preparing || !visible(target)) return;
        const previous = target.document;
        track(async () => {
            const result = parseDocument(await options.api.post<unknown>(`/api/sessions/${target.context.sessionId}/scenarios/${previous.id}/archive`, { expectedRevision: previous.revision }));
            if (result.id !== previous.id || !result.archived || result.revision !== previous.revision + 1 || !same(result.context, previous.context)) throw new Error('Unexpected scenario response.');
            target.document = result; failures.delete(target.key); if (active === target && visible(target)) message('Scenario archived. Export or Save as new to keep working from this local copy.'); void refresh();
        }, target);
    }
    const beforeUnload = (event: BeforeUnloadEvent) => { protect(); if (pending.size || storageError) { event.preventDefault(); event.returnValue = ''; } };
    const pageHide = () => { protect(); };
    window.addEventListener('beforeunload', beforeUnload); window.addEventListener('pagehide', pageHide); render();
    return {
        setContext(value) {
            if (closed) return;
            let next: ScenarioContext | null;
            try { next = value === null ? null : parseScenarioContext(value); } catch { next = null; }
            if (current && next && same(current, next)) return;
            protect(); epoch++; current = next; summaries = [];
            const available = [...drafts.values()].filter(visible).sort((a, b) => b.watermark - a.watermark || b.used - a.used);
            active = available[0] ?? null;
            if (current && !active) { try { active = make(current); } catch { message('Local draft capacity reached. Export a retained draft before continuing.'); } }
            if (active) active.used = ++sequence; protect(); render();
            if (!storageError) message(current ? 'Save scenarios explicitly. Saves captured after this replay candle are hidden.' : 'Choose a replay session.');
            void refresh();
        },
        propose(value) {
            if (!current || closed || preparing) return false;
            try {
                const next = parseScenarioContent(value);
                if (next.evidence.some(ref => ref.sourceIndex > current!.cursor || ref.time > current!.cutoff)) throw new Error('Unrevealed evidence.');
                active = make(current, next, null, true); epoch++; protect(); render(); message('Proposal draft. Review both cases and click Save to accept it.'); return true;
            } catch { message('Proposal could not be opened. Use bounded text and revealed evidence.'); return false; }
        },
        async prepare() {
            if (closed) return;
            preparing = true; render();
            try {
                while (pending.size) await Promise.all([...pending]);
                persist();
                if (failures.size) throw new Error('An explicit scenario save failed. Retry Save, Save as new, or discard the retained local draft before continuing.');
            } finally { preparing = false; render(); }
        },
        destroy() {
            if (closed) return; protect(); closed = true; epoch++;
            window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('pagehide', pageHide); root.remove();
        },
    };
}
