import type { AnalysisScopeSummary } from '../shared/chart-analysis';
import { buildCandleEvidence, type CandleEvidence, type CandleEvidenceSnapshot } from '../shared/candle-evidence';
import type { Bar } from '../shared/types';
import './candle-evidence.css';

export interface CandleQuestion {
    question: string;
    scope: AnalysisScopeSummary;
    selectedTime: number;
    evidence: CandleEvidence;
}
export interface CandleOwnership { signal: AbortSignal; assertCurrent: () => void }
export interface CandleEvidenceOptions {
    /** Queue through the existing external-AI flow; call ownership.assertCurrent immediately before committing the queue. */
    prepareQuestion?: (request: CandleQuestion, ownership: CandleOwnership) => Promise<unknown>;
    now?: () => number;
}
export interface CandleEvidencePanel {
    update(snapshot: CandleEvidenceSnapshot | null): CandleEvidence | null;
    prepare(load: (ownership: CandleOwnership) => Promise<CandleEvidenceSnapshot>): Promise<CandleEvidence | null>;
    getEvidence(): CandleEvidence | null;
    destroy(): void;
}

let panelSequence = 0;

export function mountCandleEvidence(host: HTMLElement, options: CandleEvidenceOptions = {}): CandleEvidencePanel {
    const doc = host.ownerDocument;
    const root = doc.createElement('section'); root.className = 'candle-evidence'; root.setAttribute('aria-label', 'Candle explanation');
    const title = doc.createElement('h2'); title.textContent = 'Explain this candle';
    const content = doc.createElement('div');
    const status = doc.createElement('p'); status.className = 'candle-evidence-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    root.append(title, content, status); host.replaceChildren(root);
    const panelId = `candle-evidence-${++panelSequence}`;
    const now = options.now ?? Date.now;
    let destroyed = false; let revision = 0;
    let stored: CandleEvidenceSnapshot | null = null;
    let loadController = new AbortController(); let questionController: AbortController | null = null;
    let asking = false;
    let details: HTMLDetailsElement | null = null;
    const refTargets = new Map<string, HTMLElement>();

    function open(): void { if (destroyed) throw new Error('Candle evidence panel was destroyed.'); }
    function cancel(): CandleOwnership {
        open(); revision += 1; loadController.abort(); questionController?.abort(); questionController = null;
        loadController = new AbortController(); asking = false; stored = null;
        const current = revision; const controller = loadController;
        return { signal: controller.signal, assertCurrent: () => {
            if (destroyed || current !== revision || controller.signal.aborted) throw new Error('Candle selection changed or panel was destroyed.');
        } };
    }
    function message(value: string): void {
        details = null; refTargets.clear(); content.replaceChildren();
        const note = doc.createElement('p'); note.textContent = value; content.append(note);
    }
    function errorText(error: unknown): string { return error instanceof Error ? error.message.slice(0, 500) : 'Could not prepare candle evidence.'; }
    function cloneBar(item: Bar): Bar {
        return { time: item.time, open: item.open, high: item.high, low: item.low, close: item.close, volume: item.volume,
            ...(item.instrumentId === undefined ? {} : { instrumentId: item.instrumentId, contract: item.contract }) };
    }
    function remember(input: CandleEvidenceSnapshot, report: CandleEvidence): void {
        stored = {
            scope: structuredClone(report.scope), selectedTime: input.selectedTime, transform: { ...report.transform }, priorLimit: input.priorLimit,
            raw: { dataset: { ...input.raw.dataset }, cursorTime: input.raw.cursorTime, sourceCutoff: input.raw.sourceCutoff,
                from: input.raw.from, to: input.raw.to, bars: input.raw.bars.map(cloneBar) },
            displayed: { dataset: { ...input.displayed.dataset }, cursorTime: input.displayed.cursorTime, sourceCutoff: input.displayed.sourceCutoff, bars: input.displayed.bars.map(cloneBar) },
            assertCurrent: input.assertCurrent,
        };
    }
    function evidenceButton(id: string, label: string): HTMLButtonElement {
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'candle-evidence-ref';
        button.dataset.evidenceId = id; button.textContent = `[${id}]`; button.setAttribute('aria-label', `Show evidence for ${label}`);
        button.setAttribute('aria-controls', `${panelId}-${id}`); return button;
    }
    function render(report: CandleEvidence): void {
        content.replaceChildren(); refTargets.clear();
        const subtitle = doc.createElement('p'); subtitle.className = 'candle-evidence-pin';
        subtitle.textContent = `${report.scope.dataset.symbol} · ${report.scope.chart.timeframe} · ${new Date(report.selectedTime).toISOString()} · ${report.forming ? 'Forming' : 'Boundary passed'}`;
        content.append(subtitle);
        for (const statement of report.statements) {
            const paragraph = doc.createElement('p'); paragraph.textContent = statement.text;
            const refs = doc.createElement('span'); refs.className = 'candle-evidence-refs';
            for (const id of statement.evidenceIds) refs.append(evidenceButton(id, statement.id));
            paragraph.append(refs); content.append(paragraph);
        }
        const table = doc.createElement('table'); table.className = 'candle-evidence-facts';
        const caption = doc.createElement('caption'); caption.textContent = 'Untransformed candle facts'; table.append(caption);
        const head = doc.createElement('thead'); const header = doc.createElement('tr');
        for (const label of ['Fact', 'Value', 'Sample candles / evidence']) {
            const th = doc.createElement('th'); th.scope = 'col'; th.textContent = label; header.append(th);
        }
        head.append(header); table.append(head); const body = doc.createElement('tbody');
        for (const fact of report.facts) {
            const row = doc.createElement('tr'); const label = doc.createElement('th'); label.scope = 'row'; label.textContent = fact.label;
            const value = doc.createElement('td'); value.textContent = fact.value === null ? 'Unavailable' : `${fact.value}${fact.unit === 'percent' ? '%' : fact.unit === 'ratio' ? '×' : ''}`;
            const refs = doc.createElement('td');
            for (const id of fact.evidenceIds) {
                const item = report.evidence.find(entry => entry.id === id)!;
                refs.append(doc.createTextNode(`N=${item.sampleCount} `), evidenceButton(id, fact.label));
            }
            row.append(label, value, refs); body.append(row);
        }
        table.append(body); content.append(table);
        const ask = doc.createElement('button'); ask.type = 'button'; ask.dataset.action = 'ask-candle';
        ask.textContent = 'Ask connected AI about this candle'; ask.disabled = !options.prepareQuestion;
        content.append(ask);
        if (!options.prepareQuestion) {
            const note = doc.createElement('p'); note.textContent = 'The chart host must connect its existing external-AI question handoff to enable this button.'; content.append(note);
        }
        details = doc.createElement('details'); details.className = 'candle-evidence-details';
        const summary = doc.createElement('summary'); summary.textContent = 'Evidence: exact bars, formulas and provenance'; details.append(summary);
        const note = doc.createElement('p'); note.textContent = 'Raw inputs are the revealed source candles. Displayed inputs retain the chart transform. Evidence IDs resolve within this exact pinned report.'; details.append(note);
        for (const item of report.evidence) {
            const section = doc.createElement('section'); section.id = `${panelId}-${item.id}`; section.tabIndex = -1;
            const heading = doc.createElement('h3'); heading.textContent = item.id;
            const formula = doc.createElement('p'); formula.textContent = item.formula;
            const provenance = doc.createElement('p'); provenance.textContent = item.provenance;
            const values = doc.createElement('pre'); values.textContent = JSON.stringify({ sampleCount: item.sampleCount, value: item.value, inputs: item.inputs }, null, 2);
            section.append(heading, formula, provenance, values); refTargets.set(item.id, section); details.append(section);
        }
        content.append(details); status.textContent = 'Local candle evidence ready. Causes remain unavailable from price-only bars.';
    }
    function getEvidence(): CandleEvidence | null {
        if (destroyed || !stored) return null;
        return buildCandleEvidence(stored, { now: now() });
    }
    function apply(input: CandleEvidenceSnapshot): CandleEvidence {
        const report = buildCandleEvidence(input, { now: now() }); remember(input, report); render(report); return report;
    }
    async function askQuestion(): Promise<void> {
        if (destroyed || asking || !options.prepareQuestion || !stored) return;
        const current = revision; const pinned = stored;
        const controller = new AbortController(); questionController = controller;
        const owns = (): boolean => !destroyed && current === revision && stored === pinned && !controller.signal.aborted;
        const ownership: CandleOwnership = { signal: controller.signal, assertCurrent: () => {
            if (!owns()) throw new Error('Candle question no longer owns this selection.');
            pinned.assertCurrent(); if (now() >= pinned.scope.expiresAt) throw new Error('Candle analysis scope expired. Prepare it again.');
        } };
        const button = content.querySelector<HTMLButtonElement>('[data-action="ask-candle"]')!;
        asking = true; button.disabled = true; status.textContent = 'Preparing this pinned candle question…';
        try {
            ownership.assertCurrent(); const report = getEvidence()!;
            const question = `Explain the exact ${report.scope.dataset.symbol} candle opened at ${new Date(report.selectedTime).toISOString()} on timeframe ${report.scope.chart.timeframe}. Use this pinned candle evidence and cite its evidence IDs. Separate observed facts from unavailable causes. Do not advance replay.`;
            await options.prepareQuestion({ question, scope: structuredClone(report.scope), selectedTime: report.selectedTime, evidence: report }, ownership);
            ownership.assertCurrent(); status.textContent = 'Candle question prepared for your connected AI.';
        } catch (error) {
            if (owns()) { message(errorText(error)); status.textContent = 'Prepare this candle again before asking your connected AI.'; }
        } finally {
            if (owns()) { asking = false; button.disabled = false; questionController = null; }
        }
    }
    function click(event: MouseEvent): void {
        const target = event.target;
        if (!(target instanceof doc.defaultView!.Element)) return;
        const button = target.closest<HTMLButtonElement>('button'); if (!button || !root.contains(button) || button.disabled) return;
        const id = button.dataset.evidenceId;
        if (id && details) { details.open = true; refTargets.get(id)?.focus(); }
        else if (button.dataset.action === 'ask-candle') void askQuestion();
    }
    root.addEventListener('click', click);
    message('Select a candle to inspect its revealed price and volume evidence.');
    return {
        update(input) {
            cancel(); status.textContent = '';
            if (input === null) { message('Select a candle to inspect its revealed price and volume evidence.'); return null; }
            try { return apply(input); }
            catch (error) { stored = null; message(errorText(error)); status.textContent = 'Candle evidence unavailable.'; throw error; }
        },
        async prepare(load) {
            const ownership = cancel(); message('Loading the selected revealed candle…'); status.textContent = 'Preparing local candle evidence…';
            try {
                const input = await load(ownership);
                if (ownership.signal.aborted || destroyed) return null;
                ownership.assertCurrent(); return apply(input);
            } catch (error) {
                if (ownership.signal.aborted || destroyed) return null;
                stored = null; message(errorText(error)); status.textContent = 'Candle evidence unavailable.'; throw error;
            }
        },
        getEvidence,
        destroy() {
            if (destroyed) return;
            destroyed = true; revision += 1; loadController.abort(); questionController?.abort(); stored = null;
            root.removeEventListener('click', click); refTargets.clear(); details = null; root.remove();
        },
    };
}
