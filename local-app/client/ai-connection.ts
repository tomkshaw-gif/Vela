export interface AnalysisQuestion { question: string; drawingId?: string }

/** A local question handoff; the connected AI host owns model execution. */
export function mountAiConnection(host: HTMLElement, prepare: (value: AnalysisQuestion) => Promise<unknown>): () => void {
    const doc = host.ownerDocument;
    const title = doc.createElement('h2'); title.textContent = 'Ask about this chart';
    const note = doc.createElement('p'); note.textContent = 'Keep replay paused. Your connected AI can inspect this region, calculate other indicators, and draw on the chart.';
    const label = doc.createElement('label'); label.textContent = 'Question';
    const question = doc.createElement('textarea'); question.maxLength = 2000; question.rows = 5; question.placeholder = 'Analyse this price action and compare momentum across timeframes.'; label.append(question);
    const drawingLabel = doc.createElement('label'); drawingLabel.textContent = 'Drawing ID (optional)';
    const drawing = doc.createElement('input'); drawing.maxLength = 128; drawing.placeholder = 'Leave blank to use the visible chart'; drawingLabel.append(drawing);
    const prepareButton = doc.createElement('button'); prepareButton.type = 'button'; prepareButton.textContent = 'Prepare question';
    const copyButton = doc.createElement('button'); copyButton.type = 'button'; copyButton.textContent = 'Copy AI prompt'; copyButton.hidden = true;
    const status = doc.createElement('p'); status.setAttribute('role', 'status');
    const details = doc.createElement('details'); const summary = doc.createElement('summary'); summary.textContent = 'Connection';
    const connection = doc.createElement('p'); connection.textContent = 'Connect vela-local-chart in your AI app. That app handles model sign-in and usage. Preparing a question here makes no model or data-provider call.'; details.append(summary, connection);
    host.replaceChildren(title, note, label, drawingLabel, prepareButton, copyButton, status, details);
    let disposed = false; let prompt = '';
    const submit = async (): Promise<void> => {
        prepareButton.disabled = true; copyButton.hidden = true; status.textContent = 'Capturing chart region…';
        try {
            const result = await prepare({ question: question.value, ...(drawing.value.trim() ? { drawingId: drawing.value.trim() } : {}) });
            if (disposed) return;
            prompt = `Analyse the chart question I prepared in Vela. Read vela_workspaces and vela_read_analysis_request using this exact target and scope. Do not advance replay.\n${JSON.stringify(result)}`;
            copyButton.hidden = false; status.textContent = 'Ready for your connected AI. Copy the prompt into its chat. Changing replay or timeframe requires preparing it again.';
        } catch (error) { if (!disposed) status.textContent = error instanceof Error ? error.message : 'Could not prepare this question.'; }
        finally { if (!disposed) prepareButton.disabled = false; }
    };
    const copy = async (): Promise<void> => {
        try { await navigator.clipboard.writeText(prompt); if (!disposed) status.textContent = 'AI prompt copied.'; }
        catch { if (!disposed) status.textContent = 'Clipboard unavailable. Your connected AI can read the question with vela_read_analysis_request.'; }
    };
    const click = (): void => { void submit(); }; const copyClick = (): void => { void copy(); };
    prepareButton.addEventListener('click', click); copyButton.addEventListener('click', copyClick);
    return () => { disposed = true; prepareButton.removeEventListener('click', click); copyButton.removeEventListener('click', copyClick); host.replaceChildren(); };
}
