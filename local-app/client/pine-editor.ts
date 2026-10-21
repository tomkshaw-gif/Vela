import { basicSetup, EditorView } from 'codemirror';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { HighlightStyle, StreamLanguage, foldService, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { autocompletion, completeFromList } from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { ApiError, type LocalApi } from './api';
import type { ScriptDocument, ScriptSummary, ScriptVersion, ScriptVersionSummary } from '../shared/scripts';
import { PINE_EDITOR_STORAGE_KEY } from './editor-drafts';
import './pine-editor.css';

export interface PineEditorOptions {
    api: LocalApi;
    storageKey?: string;
    onRun: (source: string) => Promise<{ id: string; name: string; warnings?: string[] }>;
    onUpdate: (id: string, source: string) => Promise<void>;
    onBacktest: (source: string, document: ScriptDocument | null, context?: PineBacktestContext) => Promise<void>;
    onRemove?: (id: string) => Promise<void>;
    onClose: () => void;
    onDirty?: (dirty: boolean) => void;
}
export interface PineBacktestContext { instanceId: string | null }
export interface PineEditorOpenOptions { source?: string; id?: string; name?: string; instanceId?: string }
export interface PineEditor {
    /** False when a pending action or draft protection refused the request; document loads are asynchronous. */
    open(options?: PineEditorOpenOptions): boolean; flush(): Promise<void>; destroy(): void;
}

export { PINE_EDITOR_STORAGE_KEY };
const DRAFT_LIMIT = 250_000;
const SOURCE_LIMIT = 200_000;
export const PINE_INDICATOR_EXAMPLE = `//@version=6
indicator("Moving average", overlay = true)
length = input.int(20, "Length", minval = 1)
average = ta.sma(close, length)
plot(average, "Average", color = color.teal, linewidth = 2)
`;
export const PINE_STRATEGY_EXAMPLE = `//@version=6
strategy("Moving average crossover", overlay = true, initial_capital = 50000, default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 10, margin_short = 10)
fastLength = input.int(10, "Fast length", minval = 1)
slowLength = input.int(30, "Slow length", minval = 1)
fast = ta.sma(close, fastLength)
slow = ta.sma(close, slowLength)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Long")
plot(fast, "Fast", color = color.teal)
plot(slow, "Slow", color = color.orange)
`;

const keywords = 'if else for while switch break continue return import export method type var varip const simple series bool int float string color true false na and or not'.split(' ');
const builtins = 'indicator strategy library plot plotchar plotshape hline fill bgcolor barcolor alert alertcondition input.int input.float input.bool input.string input.source input.color input.timeframe ta.sma ta.ema ta.rma ta.rsi ta.atr ta.macd ta.crossover ta.crossunder ta.highest ta.lowest ta.stdev math.abs math.max math.min math.round math.sqrt str.tostring request.security strategy.entry strategy.exit strategy.close strategy.close_all strategy.long strategy.short strategy.position_size color.new color.rgb color.teal color.orange color.red color.green color.blue color.white color.gray close open high low volume time bar_index barstate.islast syminfo.tickerid timeframe.period'.split(' ');
const pineLanguage = StreamLanguage.define({
    token(stream) {
        if (stream.eatSpace()) return null;
        if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
        const quote = stream.peek();
        if (quote === '"' || quote === "'") {
            stream.next(); let escaped = false;
            while (!stream.eol()) { const next = stream.next(); if (next === quote && !escaped) break; escaped = next === '\\' && !escaped; }
            return 'string';
        }
        if (stream.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/) || stream.match(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?/)) return 'number';
        const word = stream.match(/^[A-Za-z_][\w.]*/);
        if (word) { const text = typeof word === 'object' ? word[0]! : ''; return keywords.includes(text) ? 'keyword' : builtins.includes(text) ? 'builtin' : 'variableName'; }
        if (stream.match(/^[+\-*/%=<>!?:]+/)) return 'operator';
        stream.next(); return null;
    },
    languageData: { commentTokens: { line: '//' }, closeBrackets: { brackets: ['(', '[', '"', "'"] } },
});

interface Draft {
    key: string; name: string; source: string; document: ScriptDocument | null;
    dirty: boolean; updatedAt: number; baselineMissing?: boolean;
    view?: DraftView;
}
interface DraftView { anchor: number; head: number; scrollTop: number; scrollLeft: number }
interface DocumentView { id: string; revision: number; sourceLength: number; view: DraftView }
interface StoredEditor { version: 1; activeKey: string; drafts: Draft[]; favorites: string[]; recent: string[]; documentViews?: DocumentView[] }
interface LogEntry { message: string; level: 'info' | 'error' | 'warning'; line?: number; column?: number }

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
function draftKey(): string { return globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function draftView(value: unknown, length: number): DraftView {
    const item = value && typeof value === 'object' ? value as Partial<DraftView> : {};
    const position = (offset: unknown): number => typeof offset === 'number' && Number.isFinite(offset) ? Math.max(0, Math.min(length, Math.trunc(offset))) : 0;
    const scroll = (offset: unknown): number => typeof offset === 'number' && Number.isFinite(offset) ? Math.max(0, Math.min(10_000_000, offset)) : 0;
    return { anchor: position(item.anchor), head: position(item.head), scrollTop: scroll(item.scrollTop), scrollLeft: scroll(item.scrollLeft) };
}
function readStorage(key = PINE_EDITOR_STORAGE_KEY): StoredEditor | null {
    try {
        let raw = localStorage.getItem(key);
        if (raw === null && key !== PINE_EDITOR_STORAGE_KEY) raw = localStorage.getItem(PINE_EDITOR_STORAGE_KEY);
        if (!raw || raw.length > DRAFT_LIMIT * 8) return null;
        const stored = JSON.parse(raw) as StoredEditor;
        if (stored.version !== 1 || !Array.isArray(stored.drafts) || stored.drafts.length > 100) return null;
        let length = 0;
        for (const draft of stored.drafts) {
            if (!draft || typeof draft.key !== 'string' || typeof draft.name !== 'string' || draft.name.length > 200
                || typeof draft.source !== 'string' || typeof draft.dirty !== 'boolean' || !Number.isFinite(draft.updatedAt)) return null;
            length += draft.source.length;
            draft.view = draftView(draft.view, draft.source.length);
            if (draft.document && (typeof draft.document.id !== 'string' || typeof draft.document.source !== 'string'
                || typeof draft.document.name !== 'string' || !Number.isSafeInteger(draft.document.revision) || draft.document.revision < 0)) return null;
            if (draft.document && draft.baselineMissing && !draft.dirty) {
                draft.document.source = draft.source; draft.baselineMissing = false;
            }
        }
        if (length > DRAFT_LIMIT) return null;
        stored.favorites = Array.isArray(stored.favorites) ? stored.favorites.filter(id => typeof id === 'string').slice(0, 500) : [];
        stored.recent = Array.isArray(stored.recent) ? stored.recent.filter(id => typeof id === 'string').slice(0, 30) : [];
        stored.documentViews = Array.isArray(stored.documentViews) ? stored.documentViews.slice(-100).filter(item => item && typeof item.id === 'string' && item.id.length <= 128
            && Number.isSafeInteger(item.revision) && item.revision >= 0 && Number.isSafeInteger(item.sourceLength) && item.sourceLength >= 0 && item.sourceLength <= SOURCE_LIMIT)
            .map(item => ({ id: item.id, revision: item.revision, sourceLength: item.sourceLength, view: draftView(item.view, item.sourceLength) })) : [];
        return stored;
    } catch { return null; }
}
function errorLog(error: unknown): LogEntry {
    const item = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const location = item.location ?? item.loc;
    const nested = location && typeof location === 'object' ? location as Record<string, unknown> : {};
    const start = nested.start && typeof nested.start === 'object' ? nested.start as Record<string, unknown> : nested;
    const message = error instanceof Error ? error.message : typeof item.message === 'string' ? item.message : String(error);
    const position = /(?:line\s+|\b)(\d+)(?:\s*[:,]\s*|\s*,?\s*col(?:umn)?\s+)(\d+)/i.exec(message) ?? /\bline\s+(\d+)/i.exec(message);
    const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
    return { level: 'error', message: message.slice(0, 8_000),
        line: positive(item.line ?? item.lineNumber ?? start.line) ?? (position ? Number(position[1]) : undefined),
        column: positive(item.column ?? item.columnNumber ?? start.column) ?? (position?.[2] ? Number(position[2]) : undefined) };
}

/** The editor owns text and local drafts. Compilation and chart instances belong to the host. */
export function mountPineEditor(host: HTMLElement, options: PineEditorOptions): PineEditor {
    const storageKey = options.storageKey ?? PINE_EDITOR_STORAGE_KEY;
    const restored = readStorage(storageKey);
    let drafts = restored?.drafts ?? [];
    let current: Draft = drafts.find(draft => draft.key === restored?.activeKey) ?? {
        key: draftKey(), name: 'Moving average', source: PINE_INDICATOR_EXAMPLE, document: null, dirty: false, updatedAt: Date.now(),
    };
    let favorites = restored?.favorites ?? [];
    let recent = restored?.recent ?? [];
    let documentViews = restored?.documentViews ?? [];
    let instanceId: string | null = null;
    let appliedSource: string | null = null;
    let editSerial = 0; let session = 0; let librarySerial = 0; let panelSerial = 0; let loadSerial = 0;
    let destroyed = false; let replacing = false; let pending = false; let loading = false;
    let nameDialog: { dialog: HTMLDialogElement; cancel: () => void } | undefined;
    let status = restored && current.dirty ? 'Draft recovered' : 'Ready';
    let library: ScriptSummary[] = [];
    let libraryFilter = 'all';
    let sideMode: 'library' | 'versions' | 'help' | null = null;
    const logs: LogEntry[] = [];
    let storageFailed = false;
    const root = element('section', 'pine-editor'); root.setAttribute('aria-label', 'Pine editor');
    const resize = element('div', 'pine-editor-resize'); resize.tabIndex = 0; resize.setAttribute('role', 'separator');
    resize.setAttribute('aria-label', 'Resize Pine editor'); resize.setAttribute('aria-orientation', 'horizontal');
    const toolbar = element('div', 'pine-editor-toolbar'); toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', 'Pine editor actions');
    const title = element('button', 'pine-editor-title'); title.type = 'button'; title.title = 'Open script library';
    const badge = element('span', 'pine-editor-badge');
    const actions = element('div', 'pine-editor-actions');
    const body = element('div', 'pine-editor-body');
    const sidebar = element('aside', 'pine-editor-sidebar'); sidebar.hidden = true;
    const codeHost = element('div', 'pine-editor-code');
    const logPanel = element('div', 'pine-editor-logs'); logPanel.hidden = true; logPanel.setAttribute('aria-label', 'Pine logs');
    const logHeader = element('div', 'pine-editor-log-header');
    const logBody = element('div', 'pine-editor-log-body'); logBody.setAttribute('aria-live', 'polite');
    const footer = element('div', 'pine-editor-footer');
    const stateLabel = element('span', 'pine-editor-status'); stateLabel.setAttribute('role', 'status');
    const position = element('span', 'pine-editor-position');
    const fileInput = element('input'); fileInput.type = 'file'; fileInput.accept = '.pine,.txt,text/plain'; fileInput.hidden = true;
    host.classList.add('pine-editor-host'); host.append(root);
    root.append(resize, toolbar, body, logPanel, footer, fileInput); toolbar.append(title, badge, actions);
    body.append(sidebar, codeHost); logPanel.append(logHeader, logBody); footer.append(stateLabel, position);

    function button(label: string, handler: () => void, className = ''): HTMLButtonElement {
        const node = element('button', `pine-editor-button ${className}`, label); node.type = 'button';
        node.addEventListener('click', handler); return node;
    }
    function requestName(heading: string, initial: string): Promise<string | null> {
        if (nameDialog || destroyed) return Promise.resolve(null);
        return new Promise((resolve) => {
            const dialog = element('dialog', 'pine-name-dialog');
            const form = element('form', 'pine-name-form');
            const title = element('h2', '', heading); title.id = `pine-name-${draftKey()}`;
            dialog.setAttribute('aria-labelledby', title.id);
            const label = element('label', '', 'Script name');
            const input = element('input'); input.name = 'name'; input.maxLength = 200; input.required = true;
            input.value = initial.slice(0, 200); input.autocomplete = 'off'; label.append(input);
            const actions = element('div', 'pine-name-actions');
            const cancel = element('button', 'pine-editor-button', 'Cancel'); cancel.type = 'button';
            const save = element('button', 'pine-editor-button pine-name-save', 'Save'); save.type = 'submit';
            actions.append(cancel, save); form.append(title, label, actions); dialog.append(form); root.append(dialog);
            let settled = false;
            const finish = (value: string | null): void => {
                if (settled) return; settled = true;
                if (nameDialog?.dialog === dialog) nameDialog = undefined;
                if (dialog.open) dialog.close(); dialog.remove(); resolve(value);
            };
            nameDialog = { dialog, cancel: () => finish(null) };
            form.addEventListener('submit', (event) => {
                event.preventDefault(); event.stopPropagation();
                const value = input.value.trim();
                input.setCustomValidity(value ? '' : 'Use a script name between 1 and 200 characters.');
                if (input.reportValidity()) finish(value);
            });
            input.addEventListener('input', () => input.setCustomValidity(''));
            cancel.addEventListener('click', (event) => { event.stopPropagation(); finish(null); });
            dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
            dialog.addEventListener('close', () => finish(null));
            try { dialog.showModal(); input.focus(); input.select(); }
            catch { finish(null); failure(new Error('Could not open the script naming dialog. Your draft is kept.')); }
        });
    }
    function source(): string { return view.state.doc.toString(); }
    function dirty(): boolean { return current.document ? Boolean(current.baselineMissing) || source() !== current.document.source || current.name !== current.document.name : current.dirty; }
    function syncDraft(): void {
        current.source = source(); current.dirty = dirty(); current.updatedAt = Date.now();
        const selection = view.state.selection.main;
        current.view = draftView({ anchor: selection.anchor, head: selection.head, scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft }, current.source.length);
        if (current.document && !current.dirty) {
            documentViews = [...documentViews.filter(item => item.id !== current.document!.id),
                { id: current.document.id, revision: current.document.revision, sourceLength: current.source.length, view: current.view }].slice(-100);
        }
        drafts = drafts.filter(draft => draft.key !== current.key && draft.dirty);
        drafts.push(current);
    }
    function persist(): boolean {
        if (destroyed) return false;
        syncDraft();
        try {
            const storedDrafts = drafts.map(draft => ({ ...draft,
                baselineMissing: Boolean(draft.document),
                document: draft.document ? { id: draft.document.id, name: draft.document.name,
                    revision: draft.document.revision, versions: draft.document.versions, archived: draft.document.archived,
                    createdAt: draft.document.createdAt, updatedAt: draft.document.updatedAt, source: '' } : null,
            }));
            localStorage.setItem(storageKey, JSON.stringify({ version: 1, activeKey: current.key, drafts: storedDrafts, favorites, recent, documentViews } satisfies StoredEditor));
            storageFailed = false; return true;
        } catch {
            if (!storageFailed) { storageFailed = true; addLog({ level: 'warning', message: 'Local draft storage is unavailable. Keep this tab open and save or export your code before reloading.' }); }
            return false;
        }
    }
    function render(): void {
        if (destroyed) return;
        const changed = dirty();
        title.textContent = `${current.name}${changed ? ' •' : ''} ▾`;
        badge.textContent = current.document?.archived ? 'Archived' : current.document ? `v${current.document.versions}` : 'Draft';
        runButton.textContent = instanceId ? 'Update' : 'Run';
        runButton.disabled = pending || loading || !source().trim() || Boolean(instanceId && appliedSource === source());
        addButton.hidden = !instanceId; addButton.disabled = pending || loading;
        removeButton.hidden = !options.onRemove || !instanceId; removeButton.disabled = pending || loading;
        saveButton.disabled = pending || loading || Boolean(current.document?.archived);
        backtestButton.disabled = pending || loading || !source().trim();
        stateLabel.textContent = `${status}${changed ? ' · Unsaved' : ''}${storageFailed ? ' · Draft storage unavailable' : ''}`;
        const cursor = view.state.doc.lineAt(view.state.selection.main.head);
        position.textContent = `Ln ${cursor.number}, Col ${view.state.selection.main.head - cursor.from + 1} · Pine v6`;
        options.onDirty?.(changed);
    }
    function addLog(entry: LogEntry): void {
        logs.push(entry); if (logs.length > 100) logs.shift();
        logPanel.hidden = false; logBody.replaceChildren();
        for (const log of logs) {
            const row = log.line ? button(`${log.line}:${log.column ?? 1}  ${log.message}`, () => jump(log.line!, log.column), 'pine-editor-log-line') : element('div', 'pine-editor-log-line', log.message);
            row.classList.add(`pine-editor-log-${log.level}`); logBody.append(row);
        }
        logBody.scrollTop = logBody.scrollHeight;
    }
    function jump(line: number, column = 1): void {
        const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
        const offset = Math.min(target.to, target.from + Math.max(0, column - 1));
        view.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: 'center' }) }); view.focus();
    }
    function failure(error: unknown, highlight = true): void {
        if (destroyed) return;
        status = error instanceof ApiError && error.status === 409 ? 'Save conflict — draft kept' : 'Error';
        const entry = errorLog(error);
        if (error instanceof ApiError && error.status === 409) entry.message += ' Your draft is unchanged. Save as a new script, or reopen the saved script from Library to review the latest version.';
        addLog(entry);
        if (highlight && entry.line && entry.line <= view.state.doc.lines) {
            const line = view.state.doc.line(entry.line); const from = Math.min(line.to, line.from + Math.max(0, (entry.column ?? 1) - 1));
            const diagnostic: Diagnostic = { from, to: Math.min(view.state.doc.length, from + 1), severity: 'error', message: entry.message };
            view.dispatch(setDiagnostics(view.state, [diagnostic]));
        }
        persist(); render();
    }
    function reserved(): number { return drafts.filter(draft => draft.key !== current.key && draft.dirty).reduce((sum, draft) => sum + draft.source.length, 0); }
    const extensions: Extension[] = [
        basicSetup, pineLanguage, indentUnit.of('    '),
        syntaxHighlighting(HighlightStyle.define([
            { tag: tags.keyword, color: '#c792ea' }, { tag: tags.string, color: '#a5ce98' },
            { tag: tags.number, color: '#e5b180' }, { tag: tags.comment, color: '#778491', fontStyle: 'italic' },
            { tag: tags.standard(tags.variableName), color: '#7ec4d3' }, { tag: tags.operator, color: '#a7b9d0' },
        ])),
        autocompletion({ override: [completeFromList([
            ...keywords.map(label => ({ label, type: 'keyword' })), ...builtins.map(label => ({ label, type: label.includes('.') ? 'function' : 'variable' })),
        ])] }),
        foldService.of((state, from, to) => {
            const first = state.doc.lineAt(from); if (!first.text.trim()) return null;
            const indentation = first.text.search(/\S/); let end = to;
            for (let n = first.number + 1; n <= state.doc.lines; n++) { const line = state.doc.line(n); if (!line.text.trim()) continue; if (line.text.search(/\S/) <= indentation) break; end = line.to; }
            return end > to ? { from: to, to: end } : null;
        }),
        Prec.high(keymap.of([{ key: 'Mod-Enter', run: () => { void execute('run'); return true; } },
            { key: 'Mod-s', run: () => { void save(); return true; }, preventDefault: true },
            { key: 'F1', run: () => { showHelp(); return true; }, preventDefault: true }, indentWithTab])),
        EditorView.contentAttributes.of({ 'aria-label': 'Pine source', spellcheck: 'false' }),
        EditorState.transactionFilter.of(transaction => {
            if (transaction.docChanged && !replacing && transaction.newDoc.length + reserved() > DRAFT_LIMIT) {
                queueMicrotask(() => { if (!destroyed) failure(new Error('Local drafts are limited to 250,000 characters in total. Save or export a draft before adding more code.')); });
                return [];
            }
            return transaction;
        }),
        EditorView.updateListener.of(update => {
            if (update.docChanged && !replacing) {
                editSerial++; current.dirty = true; status = 'Ready'; persist();
            }
            if (update.docChanged || update.selectionSet) render();
        }),
    ];
    function editorState(draft: Draft): EditorState {
        const selection = draftView(draft.view, draft.source.length);
        return EditorState.create({ doc: draft.source, selection: { anchor: selection.anchor, head: selection.head }, extensions });
    }
    function restoreScroll(draft: Draft): void {
        const saved = draftView(draft.view, draft.source.length);
        view.scrollDOM.scrollTop = saved.scrollTop; view.scrollDOM.scrollLeft = saved.scrollLeft;
    }
    const view = new EditorView({ parent: codeHost, state: editorState(current) });
    restoreScroll(current);

    async function execute(action: 'run' | 'add' | 'backtest' | 'remove'): Promise<void> {
        if (pending || loading || destroyed) return;
        persist(); const code = source(); const capturedSession = session; const linked = instanceId;
        if (action === 'run' && linked && appliedSource === code) return;
        pending = true; status = action === 'backtest' ? 'Backtesting…' : action === 'remove' ? 'Removing…' : 'Running…';
        view.dispatch(setDiagnostics(view.state, [])); render();
        try {
            if (action === 'backtest') await options.onBacktest(code, current.document && code === current.document.source ? { ...current.document } : null, { instanceId: linked });
            else if (action === 'remove') { if (linked && options.onRemove) await options.onRemove(linked); }
            else if (action === 'run' && linked) await options.onUpdate(linked, code);
            else {
                const result = await options.onRun(code);
                if (!destroyed && capturedSession === session) { instanceId = result.id; for (const warning of result.warnings ?? []) addLog({ level: 'warning', message: warning.slice(0, 8_000) }); }
            }
            if (!destroyed && capturedSession === session) {
                if (action === 'remove') { instanceId = null; appliedSource = null; }
                else if (action !== 'backtest') appliedSource = code;
                status = action === 'backtest' ? 'Backtest ready' : action === 'remove' ? 'Removed from chart' : 'Running on chart';
                addLog({ level: 'info', message: action === 'backtest' ? 'Backtest completed.' : action === 'remove' ? 'Script removed from chart.' : 'Script applied to the active chart.' });
            }
        } catch (error) { if (capturedSession === session) failure(error, source() === code); }
        finally { pending = false; if (!destroyed) { persist(); render(); } }
    }
    async function save(asNew = false, rename = false): Promise<void> {
        if (pending || loading || destroyed) return;
        let name = current.name;
        if (asNew || rename || !current.document) {
            const origin = session;
            const answer = await requestName(asNew ? 'Save as a new script' : rename ? 'Rename script' : 'Save script', asNew ? `${name} copy` : name);
            if (answer === null || destroyed || origin !== session) return; name = answer;
        }
        if (!name || name.length > 200) { failure(new Error('Use a script name between 1 and 200 characters.')); return; }
        if (source().length > SOURCE_LIMIT) { failure(new Error('Saved scripts are limited to 200,000 characters. Your local draft is kept; export it before shortening it.')); return; }
        if (current.document?.archived && !asNew) { failure(new Error('Restore the script before saving, or use Save as.')); return; }
        const code = source(); const target = current; const capturedSession = session;
        pending = true; status = 'Saving…'; persist(); render();
        try {
            const saved = await options.api.post<ScriptDocument>('/api/scripts', { name, source: code,
                ...(!asNew && target.document ? { id: target.document.id, expectedRevision: target.document.revision } : {}) });
            if (!destroyed && capturedSession === session) {
                target.document = saved; target.name = saved.name; target.baselineMissing = false;
                target.dirty = source() !== saved.source; touchRecent(saved.id);
                status = target.dirty ? 'Saved · newer edits kept' : 'Saved'; persist();
                void refreshLibrary();
            }
        } catch (error) { if (capturedSession === session) failure(error); }
        finally { pending = false; if (!destroyed) render(); }
    }
    function touchRecent(id: string): void { recent = [id, ...recent.filter(item => item !== id)].slice(0, 30); }
    function canSwitch(nextSource: string, targetKey?: string): boolean {
        syncDraft();
        const retained = drafts.filter(draft => draft.dirty && draft.key !== targetKey).reduce((sum, draft) => sum + draft.source.length, 0);
        if (retained + nextSource.length > DRAFT_LIMIT || drafts.filter(draft => draft.dirty).length >= 99 && !targetKey) {
            failure(new Error('Save an existing draft before opening another script. All current drafts are kept within the 250,000-character local limit.')); return false;
        }
        if (!persist() && dirty() && !window.confirm('Local draft storage is unavailable. Export this code before switching. Switch anyway?')) return false;
        return true;
    }
    function replace(next: Draft, linked?: string): void {
        session++; editSerial++; loadSerial++; loading = false; current = next; instanceId = linked ?? null; appliedSource = linked ? next.source : null;
        replacing = true;
        view.setState(editorState(next)); restoreScroll(next);
        replacing = false;
        status = next.dirty ? 'Draft restored' : 'Ready'; sideMode = null; sidebar.hidden = true; panelSerial++;
        persist(); render(); view.focus();
    }
    function newScript(strategy: boolean): void {
        if (pending || loading) return;
        const code = strategy ? PINE_STRATEGY_EXAMPLE : PINE_INDICATOR_EXAMPLE;
        if (!canSwitch(code)) return;
        replace({ key: draftKey(), name: strategy ? 'Moving average crossover' : 'Moving average', source: code, document: null, dirty: true, updatedAt: Date.now() });
    }
    async function loadScript(id: string, input?: PineEditorOpenOptions, savedOnly = false): Promise<void> {
        if (pending || destroyed) return;
        persist(); const token = ++session; const loadToken = ++loadSerial; const edits = editSerial; loading = true; status = 'Opening…'; render();
        try {
            const saved = await options.api.get<ScriptDocument>(`/api/scripts/${encodeURIComponent(id)}`);
            if (destroyed || session !== token || edits !== editSerial) return;
            const existing = savedOnly ? undefined : drafts.find(draft => draft.document?.id === id && draft.dirty);
            const reusable = existing && (input?.source === undefined || input.source === existing.source)
                && (input?.name === undefined || input.name === existing.name) ? existing : undefined;
            const code = input?.source ?? reusable?.source ?? saved.source;
            if (!canSwitch(code, reusable?.key)) return;
            replace({ key: reusable?.key ?? draftKey(), name: (input?.name ?? reusable?.name ?? saved.name).slice(0, 200), source: code,
                document: reusable?.document ?? saved, baselineMissing: reusable?.baselineMissing,
                view: reusable?.view ?? (code === saved.source ? documentViews.find(item => item.id === id && item.revision === saved.revision && item.sourceLength === code.length)?.view : undefined),
                dirty: code !== saved.source || Boolean(reusable?.dirty), updatedAt: Date.now() }, input?.instanceId);
            if (input?.instanceId && input.source === undefined) { appliedSource = null; render(); }
            touchRecent(id); persist();
        } catch (error) { if (session === token) failure(error); }
        finally { if (!destroyed && loadSerial === loadToken) { loading = false; if (status === 'Opening…') status = 'Ready'; render(); } }
    }
    async function refreshLibrary(): Promise<void> {
        const token = ++librarySerial;
        try {
            const result = await options.api.get<ScriptSummary[]>('/api/scripts?includeArchived=true');
            if (!destroyed && token === librarySerial) { library = result; if (sideMode === 'library') renderLibrary(); }
        } catch (error) { if (!destroyed && token === librarySerial) failure(error); }
    }
    function panelHeader(label: string): void {
        sidebar.hidden = false; sidebar.replaceChildren();
        const row = element('div', 'pine-editor-side-heading'); row.append(element('strong', '', label), button('×', () => { sideMode = null; sidebar.hidden = true; panelSerial++; }, 'pine-editor-icon'));
        sidebar.append(row);
    }
    function showLibrary(): void { sideMode = 'library'; panelSerial++; renderLibrary(); void refreshLibrary(); }
    function renderLibrary(): void {
        const previousSearch = sidebar.querySelector<HTMLInputElement>('input[type="search"]');
        const query = previousSearch?.value ?? ''; const hadFocus = document.activeElement === previousSearch;
        panelHeader('Scripts');
        const search = element('input'); search.type = 'search'; search.placeholder = 'Search scripts'; search.setAttribute('aria-label', 'Search scripts'); search.value = query;
        const filters = element('select'); filters.setAttribute('aria-label', 'Script library filter');
        for (const [value, label] of [['all', 'All scripts'], ['recent', 'Recent'], ['favorites', 'Favorites'], ['drafts', 'Local drafts'], ['archived', 'Archived']]) {
            const option = element('option', '', label); option.value = value!; filters.append(option);
        }
        filters.value = libraryFilter; const list = element('div', 'pine-editor-script-list');
        sidebar.append(search, filters, list);
        const populate = (): void => {
            list.replaceChildren(); const term = search.value.toLocaleLowerCase();
            if (libraryFilter === 'drafts') {
                syncDraft();
                for (const draft of [...drafts].filter(item => item.dirty && item.name.toLocaleLowerCase().includes(term)).sort((a, b) => b.updatedAt - a.updatedAt)) {
                    list.append(button(`${draft.name} · local draft`, () => { if (!pending && !loading && canSwitch(draft.source, draft.key)) replace(draft); }, 'pine-editor-script-open'));
                }
            } else {
                let matches = library.filter(script => script.name.toLocaleLowerCase().includes(term)
                    && (libraryFilter === 'archived' ? script.archived : !script.archived)
                    && (libraryFilter !== 'favorites' || favorites.includes(script.id)) && (libraryFilter !== 'recent' || recent.includes(script.id)));
                if (libraryFilter === 'recent') matches = matches.sort((a, b) => recent.indexOf(a.id) - recent.indexOf(b.id));
                for (const script of matches) {
                    const row = element('div', 'pine-editor-script-row');
                    const star = button(favorites.includes(script.id) ? '★' : '☆', () => { favorites = favorites.includes(script.id) ? favorites.filter(id => id !== script.id) : [...favorites, script.id].slice(-500); persist(); populate(); }, 'pine-editor-icon');
                    star.setAttribute('aria-label', `Favorite ${script.name}`); star.setAttribute('aria-pressed', String(favorites.includes(script.id)));
                    const open = button(script.name, () => { void loadScript(script.id, undefined, true); }, 'pine-editor-script-open');
                    open.title = `${script.name} · ${script.versions} versions · ${new Date(script.updatedAt).toLocaleString()}`;
                    row.append(star, open, element('small', '', `v${script.versions}`)); list.append(row);
                }
            }
            if (!list.childElementCount) list.append(element('p', 'pine-editor-empty', 'No scripts in this view.'));
        };
        search.addEventListener('input', populate); filters.addEventListener('change', () => { libraryFilter = filters.value; populate(); }); populate();
        if (hadFocus) search.focus();
    }
    async function showVersions(): Promise<void> {
        const saved = current.document; if (!saved) { addLog({ level: 'info', message: 'Save your script to start its version history.' }); return; }
        sideMode = 'versions'; const token = ++panelSerial; const capturedSession = session;
        panelHeader('Version history'); sidebar.append(element('p', 'pine-editor-empty', 'Loading versions…'));
        try {
            const versions = await options.api.get<ScriptVersionSummary[]>(`/api/scripts/${encodeURIComponent(saved.id)}/versions`);
            if (destroyed || token !== panelSerial || capturedSession !== session) return;
            panelHeader('Version history');
            sidebar.append(element('p', 'pine-editor-empty', 'Open a version to inspect or edit it. Save creates the next version; Save as creates a separate script.'));
            for (const version of versions) sidebar.append(button(`v${version.version} · ${version.name} · ${new Date(version.createdAt).toLocaleString()}`, () => { void loadVersion(saved, version.version); }, 'pine-editor-version'));
        } catch (error) { if (capturedSession === session && token === panelSerial) failure(error); }
    }
    async function loadVersion(saved: ScriptDocument, number: number): Promise<void> {
        if (pending || loading) return;
        const capturedSession = session; const edits = editSerial; const token = ++panelSerial; const loadToken = ++loadSerial;
        loading = true; status = 'Opening version…'; render();
        try {
            const version = await options.api.get<ScriptVersion>(`/api/scripts/${encodeURIComponent(saved.id)}/versions/${number}`);
            if (destroyed || capturedSession !== session || token !== panelSerial || edits !== editSerial) return;
            if (!canSwitch(version.source)) return;
            const linked = instanceId; const applied = appliedSource;
            replace({ key: draftKey(), name: version.name, source: version.source, document: saved, dirty: true, updatedAt: Date.now() }, linked ?? undefined);
            appliedSource = applied; status = `Viewing version ${number}`; render();
        } catch (error) { if (capturedSession === session) failure(error); }
        finally { if (!destroyed && loadSerial === loadToken) { loading = false; if (status === 'Opening version…') status = 'Ready'; render(); } }
    }
    async function archiveOrRestore(): Promise<void> {
        const saved = current.document; if (!saved || pending || loading) return;
        if (!saved.archived && !window.confirm(`Archive “${saved.name}”? You can restore it from the library.`)) return;
        pending = true; persist(); render(); const capturedSession = session;
        try {
            const result = await options.api.post<ScriptDocument>(`/api/scripts/${encodeURIComponent(saved.id)}/${saved.archived ? 'restore' : 'archive'}`, { expectedRevision: saved.revision });
            if (!destroyed && capturedSession === session) { current.document = result; current.baselineMissing = false; status = result.archived ? 'Archived' : 'Restored'; persist(); void refreshLibrary(); }
        } catch (error) { if (capturedSession === session) failure(error); }
        finally { pending = false; if (!destroyed) render(); }
    }
    async function clone(): Promise<void> {
        const saved = current.document; if (!saved || pending || loading) return;
        const origin = session;
        const name = await requestName('Clone saved script', `${saved.name} copy`);
        if (name === null || destroyed || origin !== session) return;
        if (!name.trim() || name.trim().length > 200) { failure(new Error('Use a script name between 1 and 200 characters.')); return; }
        pending = true; const capturedSession = session; const edits = editSerial; persist(); render();
        try {
            const result = await options.api.post<ScriptDocument>(`/api/scripts/${encodeURIComponent(saved.id)}/clone`, { name: name.trim() });
            if (!destroyed && capturedSession === session) {
                if (edits === editSerial && canSwitch(result.source)) replace({ key: draftKey(), name: result.name, source: result.source, document: result, dirty: false, updatedAt: Date.now() });
                else addLog({ level: 'info', message: `Created “${result.name}” in the library. Your current edits are kept.` });
                void refreshLibrary();
            }
        } catch (error) { if (capturedSession === session) failure(error); }
        finally { pending = false; if (!destroyed) render(); }
    }
    function exportSource(): void {
        const blob = new Blob([source()], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob);
        const link = element('a'); link.href = url; link.download = `${current.name.replace(/[^\w .-]/g, '_').slice(0, 120) || 'script'}.pine`;
        root.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }
    function showHelp(): void {
        sideMode = 'help'; panelSerial++; panelHeader('Pine editor help');
        for (const text of ['Ctrl/⌘+Enter — Run or update the linked chart script.', 'Ctrl/⌘+S — Save a reusable script.', 'Ctrl/⌘+F — Find; use the search panel to replace.', 'Ctrl/⌘+Z / Shift+Ctrl/⌘+Z — Undo / redo.', 'Tab / Shift+Tab — Indent / outdent. Ctrl+Space — Complete.', 'F1 — This help. Fold indented blocks from the gutter.', 'Run adds a script to the active chart. Update replaces the linked instance. Add to chart makes a separate copy.', 'Local drafts survive reloads and switching scripts. Find them in Library → Local drafts. Saved scripts keep numbered versions.', 'Compilation, supported Pine features, and backtests are provided by the connected script engine.']) sidebar.append(element('p', 'pine-editor-help', text));
    }
    const runButton = button('Run', () => { void execute('run'); }, 'pine-editor-run'); runButton.title = 'Run / update · Ctrl+Enter';
    const addButton = button('Add to chart', () => { void execute('add'); });
    const backtestButton = button('Backtest', () => { void execute('backtest'); });
    const saveButton = button('Save', () => { void save(); }); saveButton.title = 'Save · Ctrl+S';
    const removeButton = button('Remove', () => { void execute('remove'); });
    const more = element('details', 'pine-editor-more');
    const moreTrigger = element('summary', 'pine-editor-button', 'More ▾'); moreTrigger.setAttribute('aria-label', 'More editor actions');
    const menu = element('div', 'pine-editor-menu'); more.append(moreTrigger, menu);
    const menuAction = (label: string, callback: () => void): void => { menu.append(button(label, () => { more.open = false; callback(); })); };
    menuAction('New indicator', () => newScript(false)); menuAction('New strategy', () => newScript(true));
    menuAction('Save as…', () => { void save(true); }); menuAction('Rename…', () => { void save(false, true); });
    menuAction('Clone saved script…', () => { if (current.document) void clone(); else addLog({ level: 'info', message: 'Save the script before cloning, or use Save as.' }); });
    menuAction('Archive / restore', () => { if (current.document) void archiveOrRestore(); else addLog({ level: 'info', message: 'This is a local draft. Save it before archiving.' }); });
    menuAction('Import Pine / text…', () => { if (!pending && !loading) fileInput.click(); }); menuAction('Export Pine', exportSource);
    menuAction('Copy code', () => {
        if (!navigator.clipboard?.writeText) { failure(new Error('Clipboard access is unavailable. Use Export Pine to keep a plain text copy.')); return; }
        void navigator.clipboard.writeText(source()).then(() => { if (!destroyed) { status = 'Code copied'; render(); } }).catch(error => failure(error));
    });
    menuAction('Find / replace', () => { openSearchPanel(view); }); menuAction('Help · F1', showHelp);
    actions.append(runButton, addButton, backtestButton, saveButton, button('Library', showLibrary), button('History', () => { void showVersions(); }), removeButton, more);
    const maximize = button('⤢', () => { const expanded = host.classList.toggle('pine-editor-maximized'); maximize.setAttribute('aria-pressed', String(expanded)); maximize.title = expanded ? 'Restore editor size' : 'Maximize editor'; view.requestMeasure(); }, 'pine-editor-icon');
    maximize.setAttribute('aria-label', 'Maximize editor'); maximize.setAttribute('aria-pressed', 'false');
    actions.append(maximize, button('×', () => { persist(); host.hidden = true; options.onClose(); }, 'pine-editor-icon'));
    actions.lastElementChild!.setAttribute('aria-label', 'Close Pine editor');
    title.addEventListener('click', showLibrary);
    logHeader.append(element('strong', '', 'Logs'), button('Clear', () => { logs.length = 0; logBody.replaceChildren(); view.dispatch(setDiagnostics(view.state, [])); }), button('Collapse', () => { logPanel.hidden = true; }));
    footer.append(button('Logs', () => { logPanel.hidden = !logPanel.hidden; }));
    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0]; fileInput.value = ''; if (!file || pending || loading) return;
        if (file.size > DRAFT_LIMIT * 4) { failure(new Error('Import exceeds the local draft limit.')); return; }
        const capturedSession = session; const edits = editSerial;
        void file.text().then(code => {
            if (destroyed || capturedSession !== session || edits !== editSerial) { if (!destroyed) addLog({ level: 'info', message: 'Import cancelled because the editor changed. Import the file again when ready.' }); return; }
            if (code.includes('\u0000')) throw new Error('Import a plain Pine or text file.');
            if (canSwitch(code)) replace({ key: draftKey(), name: file.name.replace(/\.(?:pine|txt)$/i, '').slice(0, 200) || 'Imported script', source: code, document: null, dirty: true, updatedAt: Date.now() });
        }).catch(failure);
    });
    let dragCleanup: (() => void) | null = null;
    resize.addEventListener('pointerdown', event => {
        if (event.button !== 0 || host.classList.contains('pine-editor-maximized')) return;
        event.preventDefault(); dragCleanup?.();
        const start = event.clientY; const height = host.getBoundingClientRect().height;
        const move = (next: PointerEvent): void => { host.style.height = `${Math.max(180, Math.min(window.innerHeight - 60, height + start - next.clientY))}px`; view.requestMeasure(); };
        const end = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); dragCleanup = null; };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end); dragCleanup = end;
    });
    resize.addEventListener('keydown', event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); host.style.height = `${Math.max(180, Math.min(window.innerHeight - 60, host.getBoundingClientRect().height + (event.key === 'ArrowUp' ? 24 : -24)))}px`; view.requestMeasure(); } });
    const flushNow = (): void => { persist(); };
    window.addEventListener('pagehide', flushNow); window.addEventListener('beforeunload', flushNow);
    const visibility = (): void => { if (document.visibilityState === 'hidden') persist(); };
    document.addEventListener('visibilitychange', visibility);
    render(); persist();
    return {
        open(input) {
            if (destroyed) return false; host.hidden = false; root.hidden = false; view.requestMeasure();
            if (!input || input.id === undefined && input.source === undefined) { view.focus(); return true; }
            if (input.id) { if (pending) return false; void loadScript(input.id, input); return true; }
            if (pending || loading) return false;
            const code = input.source ?? PINE_INDICATOR_EXAMPLE;
            if (!canSwitch(code)) return false;
            replace({ key: draftKey(), name: (input.name ?? 'Untitled script').slice(0, 200), source: code, document: null, dirty: true, updatedAt: Date.now() }, input.instanceId);
            return true;
        },
        async flush() { nameDialog?.cancel(); if (!persist() && !destroyed) throw new Error('Unable to persist the Pine editor draft. Save or export your code before reloading.'); },
        destroy() {
            if (destroyed) return; nameDialog?.cancel(); persist(); destroyed = true; session++; panelSerial++; librarySerial++;
            dragCleanup?.(); window.removeEventListener('pagehide', flushNow); window.removeEventListener('beforeunload', flushNow); document.removeEventListener('visibilitychange', visibility);
            view.destroy(); root.remove(); host.classList.remove('pine-editor-host', 'pine-editor-maximized');
        },
    };
}
