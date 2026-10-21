import type { LocalApi } from './api';
import type { HistoryJobSummary, HistoryRequest, HistorySymbol } from '../server/history-types';
import type { DatasetMeta } from '../shared/types';
import { mountDateTimePickers } from './date-time-picker';
import { escapeHtml as esc } from './util';
import './date-time-picker.css';
import './history-controls.css';

const earliest = Date.UTC(2020, 0, 1);
const minute = 60_000;
const jobIdPattern = /^history-[a-f0-9]{24}$/;
const hashPattern = /^[a-f0-9]{64}$/;
let nextMount = 0;
type Work = { kind: 'plan' | 'run' | 'import'; jobId?: string; abort: AbortController; promise: Promise<void> };
const utc = (value: string): string => value.replace('T', ' ').replace(/:00(?:\.000)?Z$/, ' UTC').replace(/Z$/, ' UTC');
const count = (value: number): string => value.toLocaleString('en-US');
const message = (error: unknown): string => error instanceof Error ? error.message : 'History request failed. Retry when local changes have finished.';
function importable(job: HistoryJobSummary): boolean {
    return job.state === 'ready' && job.totalChunks > 0 && job.totalChunks === job.chunks.length
        && job.completedChunks === job.totalChunks && job.chunks.every(chunk => chunk.state === 'complete'
            && [chunk.rawSha256, chunk.normalizedSha256, chunk.mappingSha256].every(hash => hashPattern.test(hash ?? '')));
}

/** prepare() leaves this mount quiescent and drains its request, including an in-flight catalog callback. */
export function mountHistoryControls(host: HTMLElement, api: LocalApi, callbacks: { onImported(): Promise<void> | void }): { cancel(): void; destroy(): void; prepare(): Promise<void> } {
    const prefix = `history-controls-${++nextMount}`;
    const root = document.createElement('section'); root.className = 'history-controls'; root.setAttribute('aria-labelledby', `${prefix}-title`);
    root.innerHTML = `<h3 id="${prefix}-title">Continuous futures history</h3>
      <p>NQ and GC · volume front month · one-minute bars · unadjusted continuous prices.</p>
      <p class="history-note">At a contract roll, the simulator cancels working orders and flattens at the last old-contract close. Fees and slippage apply. History charts currently support 1m only.</p>
      <form class="history-plan" novalidate aria-label="Plan continuous history">
        <fieldset><legend>Contracts</legend><label class="history-check"><input type="checkbox" name="symbol" value="NQ.v.0" checked>NQ.v.0</label><label class="history-check"><input type="checkbox" name="symbol" value="GC.v.0" checked>GC.v.0</label></fieldset>
        <div class="history-dates"><div class="date-time-field"><span>Start · UTC</span><input id="${prefix}-start" name="start" type="datetime-local" hidden readonly data-date-time-picker data-zone="UTC" step="60" aria-label="History start UTC" value="2020-01-01T00:00"></div>
        <div class="date-time-field"><span>End · UTC (excluded)</span><input id="${prefix}-end" name="end" type="datetime-local" hidden readonly data-date-time-picker data-zone="UTC" step="60" aria-label="History end UTC, excluded" value="${new Date().toISOString().slice(0, 10)}T00:00"></div></div>
        <p class="history-note">Choose whole minutes (seconds 00) from 2020 onward. The default end is today at 00:00 UTC, including the full previous day. You can extend it to the provider's available end, no later than now. The request end is excluded.</p>
        <button type="submit" data-history-plan>Plan history</button>
      </form>
      <p class="history-note">Planning is local. Download/resume requires a separate click and a fresh exact $0 provider estimate before each pending month; a nonzero or unavailable estimate blocks it. This is not a guarantee of a zero invoice. Configure the provider key separately in Data &amp; settings.</p>
      <p class="history-note">Add each ready symbol to cached datasets separately. Import is atomic and re-verifies integrity; other local writes must finish first. Other writes can be temporarily unavailable during import. Cancellation remains available for this panel's pending request.</p>
      <div class="history-toolbar"><button type="button" data-history-refresh>Refresh jobs</button><button type="button" data-history-cancel hidden>Cancel this request</button></div>
      <p class="history-status" data-history-status role="status" aria-live="polite" aria-atomic="true">Loading persisted history jobs…</p>
      <p class="history-error" data-history-error role="alert" hidden></p>
      <div class="history-jobs" aria-label="Persisted history jobs"></div>`;
    host.append(root);
    const query = <T extends Element>(selector: string): T => root.querySelector<T>(selector)!;
    const form = query<HTMLFormElement>('form');
    const input = (name: string): HTMLInputElement => form.elements.namedItem(name) as HTMLInputElement;
    const status = query<HTMLElement>('[data-history-status]'); const errorHost = query<HTMLElement>('[data-history-error]');
    const jobsHost = query<HTMLElement>('.history-jobs'); const cancelButton = query<HTMLButtonElement>('[data-history-cancel]');
    let jobs: HistoryJobSummary[] = [], pending: Work | undefined;
    let destroyed = false, preparing = false;
    let readEpoch = 0, readAbort: AbortController | undefined;
    let readTimeout: ReturnType<typeof setTimeout> | undefined, pollTimer: ReturnType<typeof setTimeout> | undefined;
    const usable = (): boolean => !destroyed && !preparing;
    const pickers = mountDateTimePickers(form, { range: () => ({ start: earliest, end: Math.floor(Date.now() / minute) * minute, endInclusive: true }) });
    for (const name of ['start', 'end']) { input(name).min = '2020-01-01T00:00'; input(name).max = new Date().toISOString().slice(0, 16); }
    function clearError(): void { errorHost.hidden = true; errorHost.textContent = ''; }
    function showError(error: unknown): void { errorHost.textContent = message(error); errorHost.hidden = false; }
    function stopPoll(): void { clearTimeout(pollTimer); pollTimer = undefined; }
    function stopRead(): void {
        readEpoch++; readAbort?.abort(); readAbort = undefined; clearTimeout(readTimeout); readTimeout = undefined;
    }
    function updateControls(): void {
        const blocked = !usable() || !!pending;
        query<HTMLButtonElement>('[data-history-plan]').disabled = blocked;
        query<HTMLButtonElement>('[data-history-refresh]').disabled = !usable();
        root.setAttribute('aria-busy', String(!!pending));
        cancelButton.hidden = !pending || pending.kind === 'plan' || !usable();
        cancelButton.disabled = !!pending?.abort.signal.aborted;
        cancelButton.textContent = pending?.abort.signal.aborted ? 'Stopping this request…' : pending?.kind === 'import' ? 'Cancel this import' : 'Stop this download';
        jobsHost.querySelectorAll<HTMLButtonElement>('[data-history-run],[data-history-import]').forEach(button => {
            const job = jobs.find(item => item.jobId === button.dataset.jobId);
            button.disabled = blocked || !job || (button.hasAttribute('data-history-import') ? !importable(job) : importable(job));
        });
    }
    function renderJobs(): void {
        const focused = document.activeElement instanceof HTMLElement && jobsHost.contains(document.activeElement)
            ? document.activeElement.dataset.historyFocus : undefined;
        const focusJob = focused ? document.activeElement?.closest<HTMLElement>('.history-job')?.dataset.jobId : undefined;
        const expanded = new Set([...jobsHost.querySelectorAll<HTMLDetailsElement>('details[open]')].map(item => item.dataset.jobId));
        jobsHost.innerHTML = jobs.length ? jobs.map(job => {
            const ready = importable(job);
            const state = job.state === 'ready' ? ready ? 'Ready to add to cached datasets' : 'Incomplete integrity receipts; download/resume to verify' : job.state;
            return `<article class="history-job" data-job-id="${esc(job.jobId)}" aria-labelledby="${prefix}-${job.jobId}">
              <h4 id="${prefix}-${job.jobId}" tabindex="-1" data-history-focus="${job.jobId}-heading">${esc(job.request.symbols.join(' + '))} · ${esc(state)}</h4>
              <p class="history-id">${esc(job.jobId)}</p><p>${esc(utc(job.request.start))} → ${esc(utc(job.request.end))} (end excluded)</p>
              <p>${count(job.completedChunks)} / ${count(job.totalChunks)} symbol-months complete · ${count(job.rows)} staged rows</p>
              <progress max="${Math.max(1, job.totalChunks)}" value="${job.completedChunks}" aria-label="Completed symbol-months"></progress>
              <p class="history-note">Updated ${esc(utc(job.updatedAt))}. ${job.state === 'running' ? 'Recorded as running; refresh to check. Resume checks the server lock and is blocked while another process holds it. This panel can stop only requests it starts.' : ready ? 'Staging complete. SHA-256 receipts recorded; import re-verifies the staged files.' : 'Verified completed months are checked again on resume. Pending months remain staged separately from cached datasets.'}</p>
              ${job.error ? `<p class="history-error">${esc(job.error.code)}: ${esc(job.error.message)}</p>` : ''}
              <div class="history-actions"><button type="button" data-history-run data-job-id="${job.jobId}" data-history-focus="${job.jobId}-run">${job.state === 'planned' && !job.completedChunks ? 'Download' : 'Resume / verify download'}</button>
              ${ready ? job.request.symbols.filter(symbol => symbol === 'NQ.v.0' || symbol === 'GC.v.0').map(symbol => `<button type="button" data-history-import data-job-id="${job.jobId}" data-symbol="${symbol}" data-history-focus="${job.jobId}-${symbol}">Add to cached datasets · ${symbol}</button>`).join('') : ''}</div>
              <details data-job-id="${job.jobId}"${expanded.has(job.jobId) ? ' open' : ''}><summary data-history-focus="${job.jobId}-months">Monthly progress and integrity</summary>
              <div class="history-months" role="region" aria-label="Monthly history progress" tabindex="0"><table><thead><tr><th scope="col">Symbol / month</th><th scope="col">Request UTC (end excluded)</th><th scope="col">Rows</th><th scope="col">Completion / integrity</th></tr></thead><tbody>
              ${job.chunks.map(chunk => `<tr><th scope="row">${esc(chunk.key)}</th><td>${esc(utc(chunk.request.start))} → ${esc(utc(chunk.request.end))}</td><td>${count(chunk.rows)}</td><td>${chunk.state === 'complete' ? [chunk.rawSha256, chunk.normalizedSha256, chunk.mappingSha256].every(hash => hashPattern.test(hash ?? '')) ? 'Complete · SHA-256 receipts present' : 'Complete · missing integrity receipts' : 'Pending'}${chunk.quotedAt ? `<small>Provider check recorded ${esc(utc(chunk.quotedAt))}</small>` : ''}</td></tr>`).join('')}
              </tbody></table></div></details></article>`;
        }).join('') : '<p class="history-note">No persisted jobs. Plan history, then choose Download to stage it.</p>';
        updateControls();
        if (focused) {
            const elements = [...jobsHost.querySelectorAll<HTMLElement>('[data-history-focus]')];
            const target = elements.find(item => item.dataset.historyFocus === focused);
            const fallback = elements.find(item => item.dataset.historyFocus === `${focusJob}-heading`);
            (target?.matches(':disabled') ? fallback : target ?? fallback)?.focus({ preventScroll: true });
        }
    }
    function upsert(job: HistoryJobSummary): void {
        if (!jobIdPattern.test(job.jobId)) throw new Error('The server returned an invalid history job ID. Refresh jobs before retrying.');
        const index = jobs.findIndex(item => item.jobId === job.jobId);
        if (index === -1) jobs.unshift(job); else jobs[index] = job;
        renderJobs();
    }
    function schedulePoll(): void {
        stopPoll();
        if (!usable() || !pending?.jobId || pending.abort.signal.aborted) return;
        const work = pending;
        pollTimer = setTimeout(() => {
            pollTimer = undefined;
            if (usable() && pending === work && !work.abort.signal.aborted) void refresh(work.jobId);
        }, 1000);
    }
    async function refresh(jobId?: string): Promise<void> {
        if (!usable()) return;
        stopPoll(); stopRead();
        const epoch = readEpoch, abort = new AbortController(); readAbort = abort;
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, 10_000); readTimeout = timeout;
        try {
            if (jobId) {
                const job = await api.get<HistoryJobSummary>(`/api/history/${jobId}`, abort.signal);
                if (!usable() || epoch !== readEpoch || abort.signal.aborted) return;
                if (job.jobId !== jobId) throw new Error('The server returned a different history job. Refresh jobs before retrying.');
                upsert(job);
            } else {
                const list = await api.get<HistoryJobSummary[]>('/api/history', abort.signal);
                if (!usable() || epoch !== readEpoch || abort.signal.aborted) return;
                jobs = list.filter(job => jobIdPattern.test(job.jobId)); renderJobs();
                if (!pending) { clearError(); status.textContent = jobs.length ? 'Persisted jobs loaded. Choose a separate download/resume or import action.' : 'No persisted jobs. Choose contracts and UTC bounds to plan history.'; }
                if (jobs.length !== list.length) showError(new Error('Some jobs have invalid IDs and were omitted.'));
            }
        } catch (error) {
            if (usable() && epoch === readEpoch && (!abort.signal.aborted || timedOut)) {
                showError(timedOut ? new Error('History refresh timed out. Use Refresh jobs to retry.') : error);
                if (!pending) status.textContent = 'History jobs could not be refreshed. Your draft and displayed jobs are retained.';
            }
        } finally {
            clearTimeout(timeout);
            if (epoch === readEpoch) { readAbort = undefined; readTimeout = undefined; schedulePoll(); }
        }
    }
    function requestDraft(): HistoryRequest {
        const symbols = [...form.querySelectorAll<HTMLInputElement>('[name=symbol]:checked')].map(item => item.value as HistorySymbol);
        if (!symbols.length || symbols.some(symbol => symbol !== 'NQ.v.0' && symbol !== 'GC.v.0')) throw new Error('Choose NQ.v.0 and/or GC.v.0.');
        const parse = (value: string): number => {
            const time = Date.parse(`${value}Z`);
            if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::00)?$/.test(value) || !Number.isFinite(time) || time % minute || new Date(time).toISOString().slice(0, 16) !== value.slice(0, 16)) throw new Error('Choose valid UTC dates at whole-minute precision.');
            return time;
        };
        const start = parse(input('start').value), end = parse(input('end').value);
        if (start < earliest || end <= start || end > Date.now() || end - start > 10 * 366 * 86_400_000) throw new Error('Use a start from 2020 onward and a later end no later than now, within ten years. The end is excluded.');
        return { symbols, start: new Date(start).toISOString(), end: new Date(end).toISOString() };
    }
    function start(kind: Work['kind'], job?: HistoryJobSummary, symbol?: HistorySymbol): void {
        if (!usable() || pending) return;
        let draft: HistoryRequest | undefined;
        try { if (kind === 'plan') draft = requestDraft(); } catch (error) { showError(error); return; }
        if (kind !== 'plan' && (!job || !jobIdPattern.test(job.jobId))) return;
        // A persisted running state can survive a crash. The server's live lock decides whether resume is safe.
        if (kind === 'run' && importable(job!)) return;
        if (kind === 'import' && (!importable(job!) || !symbol || !job!.request.symbols.includes(symbol))) return;
        stopPoll(); stopRead(); clearError();
        const work: Work = { kind, jobId: job?.jobId, abort: new AbortController(), promise: Promise.resolve() };
        pending = work; updateControls();
        status.textContent = kind === 'plan' ? 'Planning locally; no provider download…' : kind === 'run' ? 'Downloading / verifying staged months. Cached datasets change only after a separate import.' : `Adding ${symbol} to cached datasets atomically. Waiting for local writes may require a retry.`;
        const current = (): boolean => usable() && pending === work && !work.abort.signal.aborted;
        // Install the owned promise before invoking either the API or the caller's callback.
        work.promise = Promise.resolve().then(async () => {
            try {
                if (!current()) return;
                if (kind === 'import') {
                    await api.post<DatasetMeta>(`/api/history/${job!.jobId}/import`, { symbol }, work.abort.signal);
                    if (!current()) return;
                    status.textContent = `${symbol} added to cached datasets. Refreshing the catalog…`;
                    try { await callbacks.onImported(); }
                    catch (error) { if (current()) { status.textContent = `${symbol} added to cached datasets; catalog refresh failed.`; showError(error); } return; }
                    if (current()) status.textContent = `${symbol} added to cached datasets. Catalog refreshed.`;
                } else {
                    const result = await api.post<HistoryJobSummary>(kind === 'plan' ? '/api/history' : `/api/history/${job!.jobId}/run`, kind === 'plan' ? draft : {}, work.abort.signal);
                    if (!current()) return;
                    if (job && result.jobId !== job.jobId) throw new Error('The server returned a different history job. Refresh jobs before retrying.');
                    stopRead(); upsert(result);
                    status.textContent = kind === 'plan' ? 'Plan saved. Choose Download to stage it; no automatic import.' : result.state === 'ready' ? 'History staged. Add each ready symbol to cached datasets with a separate click.' : `Download ${result.state}. Verified completed months can be resumed.`;
                    if (result.error) showError(new Error(`${result.error.code}: ${result.error.message}`));
                }
            } catch (error) {
                if (current()) { status.textContent = 'History request failed. Your plan draft is retained; see the error below.'; showError(error); }
            }
            finally {
                if (pending === work) {
                    const focusCancel = usable() && document.activeElement === cancelButton;
                    stopPoll(); stopRead(); pending = undefined;
                    if (!destroyed) {
                        updateControls();
                        if (usable() && work.abort.signal.aborted) status.textContent = 'This request has stopped. Refresh jobs and cached datasets to check persisted results. Verified completed months can be resumed.';
                        if (focusCancel) (jobsHost.querySelector<HTMLElement>(`#${prefix}-${work.jobId}`) ?? query<HTMLElement>('[data-history-refresh]')).focus({ preventScroll: true });
                    }
                }
            }
        });
        schedulePoll();
    }
    function cancel(): void {
        stopPoll(); stopRead();
        // Disconnecting the owned POST cancels that request on the server. A persisted job alone confers no cancellation authority.
        pending?.abort.abort();
        if (!destroyed) {
            updateControls();
            if (pending) status.textContent = 'Cancellation requested. Waiting for this request to settle; verified months remain staged. Refresh jobs to check persisted status.';
        }
    }
    const submit = (event: SubmitEvent): void => { event.preventDefault(); event.stopPropagation(); start('plan'); };
    const refreshClick = (): void => { if (usable()) void refresh(); };
    const jobClick = (event: MouseEvent): void => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest<HTMLButtonElement>('[data-history-run],[data-history-import]');
        if (!button || button.disabled || !jobsHost.contains(button)) return;
        const job = jobs.find(item => item.jobId === button.dataset.jobId); if (!job) return;
        const symbol = button.dataset.symbol;
        if (button.hasAttribute('data-history-import')) { if (symbol === 'NQ.v.0' || symbol === 'GC.v.0') start('import', job, symbol); }
        else start('run', job);
    };
    form.addEventListener('submit', submit); query('[data-history-refresh]').addEventListener('click', refreshClick);
    cancelButton.addEventListener('click', cancel); jobsHost.addEventListener('click', jobClick);
    void refresh();
    return {
        cancel,
        async prepare() { preparing = true; cancel(); await pending?.promise; },
        destroy() {
            if (destroyed) return;
            destroyed = true; cancel(); pickers.destroy();
            form.removeEventListener('submit', submit); query('[data-history-refresh]').removeEventListener('click', refreshClick);
            cancelButton.removeEventListener('click', cancel); jobsHost.removeEventListener('click', jobClick); root.remove();
        },
    };
}
