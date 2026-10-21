import './market-stats-page.css';
import type { MarketStatsCatalog, MarketStatsPageResponse, MarketStatsRequest } from '../shared/market-stats';
import type { LocalApi } from './api';
import { escapeHtml as e } from './util';
import { mountDesktopUpdates } from './desktop-updates';
import { mountDateTimePickers } from './date-time-picker';
import { parseWallTime } from './replay-time';
import './date-time-picker.css';
import type { getStatsPresetCatalog, BuiltStatsPreset } from '../server/stats-presets';
import type { StatsArtifactResponse } from '../server/market-stats/artifacts';
import { mountStatsSessionChart, type StatsSessionChart } from './stats-session-chart';
import { eventCalendars } from '@luxalgo/edge-stats/calendar-data';
import { mountEventComparison } from './event-comparison';
import type { EventComparisonResult } from '../shared/event-comparison';

type PresetCatalog = ReturnType<typeof getStatsPresetCatalog>;
type Preset = PresetCatalog['presets'][number];
type ArtifactResponse = StatsArtifactResponse & { selection: MarketStatsPageResponse['selection'] };

const pct = (value: number | null): string => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const interval = (value: [number, number] | null): string => value === null ? '—' : `${pct(value[0])} – ${pct(value[1])}`;
const dateTime = (value: number): string => new Date(value).toISOString().slice(0, 16);
const utc = (value: number): string => new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
let pageSequence = 0;

export function mountMarketStatsPage(host: HTMLElement, api: LocalApi, callbacks: { onHome(): void; onData(): void }) {
    const instance = `ms-${++pageSequence}`;
    host.innerHTML = `<div class="ms-page"><aside class="ms-sidebar"><strong class="ms-brand">Vela</strong>
      <button type="button" data-stats-home>← Backtesting</button><div class="ms-current">Market Stats</div>
      <button type="button" data-stats-data>Data &amp; settings</button><div class="ms-update"></div></aside>
      <main class="ms-main"><header class="ms-heading"><div><p class="ms-eyebrow">RESEARCH YOUR CACHED MARKET DATA</p><h1>Market Stats</h1>
      <p>Historical setup frequencies, with sample sizes and confidence intervals.</p></div><a href="https://github.com/LuxAlgo/edge-stats" target="_blank" rel="noreferrer">Powered by Edge Stats ↗</a></header>
      <p class="ms-status" role="status" aria-live="polite">Loading cached sources…</p>
      <form class="ms-form"><section class="ms-panel"><h2>1. Choose your source</h2><div class="ms-fields">
      <label>Cached market data<select name="datasetId" required></select></label>
      <label>History scope<select name="sourceMode"><option value="cache">Selected cached history</option><option value="replay">Only a saved replay’s revealed history</option></select></label>
      <label class="ms-replay" hidden>Replay snapshot<select name="replayId"></select></label>
      <div class="date-time-field"><span>From · UTC</span><input id="${instance}-from" aria-label="From · UTC" name="from" type="datetime-local" step="60" required data-date-time-picker data-zone="UTC"></div>
      <div class="date-time-field"><span>Until · UTC, excluded</span><input id="${instance}-until" aria-label="Until · UTC, excluded" name="until" type="datetime-local" step="60" required data-date-time-picker data-zone="UTC"></div></div>
      <p class="ms-coverage"></p><p class="ms-muted">The selected history is independent of your trading account. Maximum 250,000 one-minute bars per query.</p></section>
      <section class="ms-panel"><h2>2. Define the session</h2><div class="ms-fields">
      <label>Schedule<select name="schedule"><option value="regular">US regular hours</option><option value="utc">Full UTC day</option><option value="custom">Custom hours</option></select></label>
      <label>Time zone<input name="zone" value="America/New_York" required maxlength="80" list="${instance}-timezones"></label>
      <datalist id="${instance}-timezones"><option value="America/New_York"><option value="America/Chicago"><option value="Europe/London"><option value="UTC"></datalist>
      <label>Session open · 24h<input name="open" value="09:30" required pattern="[0-2][0-9]:[0-5][0-9]" maxlength="5"></label>
      <label>Session close · 24h<input name="close" value="16:00" required pattern="[0-2][0-9]:[0-5][0-9]" maxlength="5"></label>
      <label class="ms-check"><input name="overnight" type="checkbox">Opens on the previous calendar day</label></div>
      <p class="ms-warning">Schedule only: exchange holidays and early closes are not supplied. Results are not an exchange-verified calendar.</p></section>
      <section class="ms-panel ms-events"><label class="ms-check"><input name="eventCalendar" type="checkbox">Enable bundled CPI, NFP, FOMC and OPEX dates</label>
      <p class="ms-muted">Optional, versioned dates with limited coverage. FOMC covers scheduled statement days only; OPEX describes monthly equity option expiry, not futures expiry. These dates do not apply an exchange holiday calendar or a CME profile to gold. Event eligibility is limited to the supplied date coverage.</p></section>
      <section class="ms-panel"><h2>3. Ask a question</h2><div class="ms-examples"></div>
      <section class="ms-presets" aria-label="Official research templates"><div class="ms-preset-heading"><div><h3>Official research templates</h3><p class="ms-preset-count"></p></div><button type="button" data-presets-refresh>Reload templates</button></div>
      <div class="ms-fields"><label>Search templates<input data-preset-search type="search" form="${instance}-preset-draft" placeholder="Gap fill, opening range, FOMC…"></label>
      <label>Category<select data-preset-category form="${instance}-preset-draft"><option value="">All categories</option></select></label></div>
      <p class="ms-preset-status" role="status" aria-live="polite">Loading official templates…</p><div class="ms-preset-browser"><div class="ms-preset-list" aria-label="Research templates"></div><div class="ms-preset-detail"></div></div>
      <p class="ms-muted">Compose places the official normalized query in your editable draft. Run statistics separately when your source and schedule are ready.</p><code data-preset-normalized></code></section>
      <label>Query<textarea name="dsl" rows="3" maxlength="2000" required spellcheck="false">closeGreen</textarea></label>
      <div class="ms-fields"><label>Group results<select name="groupBy"><option value="">No grouping</option></select></label>
      <label>Trade dates from<input name="since" type="date"></label><label>Trade dates through<input name="through" type="date"></label></div>
      <details class="ms-query-help"><summary>Available outcomes and conditions</summary><div class="ms-registry"></div></details>
      <div class="ms-run"><button data-stats-run type="submit" disabled>Run statistics</button><button data-stats-cancel type="button" hidden>Cancel</button><button data-stats-refresh type="button">Refresh sources</button></div>
      <p class="ms-muted">Only complete sessions are counted. Estimates are withheld below 10 samples; fewer than 30 carry a low-sample warning.</p></section></form>
      <section class="ms-results" tabindex="-1" aria-label="Market statistics result" hidden></section>
      <section class="ms-event-comparison" hidden></section></main></div>`;
    const query = <T extends Element>(selector: string) => host.querySelector<T>(selector)!;
    const form = query<HTMLFormElement>('form'); const status = query<HTMLElement>('.ms-status');
    const resultHost = query<HTMLElement>('.ms-results'); const runButton = query<HTMLButtonElement>('[data-stats-run]');
    const comparisonHost = query<HTMLElement>('.ms-event-comparison');
    const cancelButton = query<HTMLButtonElement>('[data-stats-cancel]');
    const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    const select = (name: string) => form.elements.namedItem(name) as HTMLSelectElement;
    const removeUpdates = mountDesktopUpdates(query<HTMLElement>('.ms-update'));
    const presetStatus = query<HTMLElement>('.ms-preset-status');
    let presets: PresetCatalog | null = null, selectedPreset = '', presetGeneration = 0, composeGeneration = 0, artifactGeneration = 0;
    let presetController: AbortController | null = null, composeController: AbortController | null = null, artifactController: AbortController | null = null;
    let latestRequest: MarketStatsRequest | null = null, inspectionIndex = -1, artifactBusy = false, comparisonBusy = false;
    let sessionChart: StatsSessionChart | null = null;
    let catalog: MarketStatsCatalog | null = null; let controller: AbortController | null = null; let loadController: AbortController | null = null;
    let disposed = false, loading = false, preparing = false, generation = 0; let loadGeneration = 0; let latest: MarketStatsPageResponse | null = null;
    const pending = new Set<Promise<unknown>>();
    let preparation: Promise<void> | null = null;
    function track<T>(work: Promise<T>): Promise<T> {
        pending.add(work);
        void work.then(() => pending.delete(work), () => pending.delete(work));
        return work;
    }
    const comparison = mountEventComparison(comparisonHost, {
        async compare(request, signal) {
            if (disposed || preparing || comparisonBusy || artifactBusy || controller || !latestRequest || latestRequest.eventCalendar !== 'bundled') {
                throw new Error('Wait for the current statistics operation or run a query with the explicit bundled event calendar.');
            }
            comparisonBusy = true; busy(false); artifactButtons();
            try { return await track(api.post<EventComparisonResult>('/api/market-stats/event-comparison', request, signal)); }
            finally { comparisonBusy = false; if (!disposed) { busy(!!controller); artifactButtons(); } }
        },
    });
    const preset = (): Preset | undefined => presets?.presets.find(item => item.id === selectedPreset);
    function composeEnabled(): void {
        const button = host.querySelector<HTMLButtonElement>('[data-preset-compose]');
        if (button) button.disabled = disposed || preparing || !!presetController || !!composeController || !preset()?.availability.available;
    }
    function stopCompose(): void { composeGeneration++; if (composeController) { composeController.abort(); presetStatus.textContent = 'Composition cancelled. Current query draft preserved.'; } composeController = null; composeEnabled(); }
    function artifactButtons(): void {
        for (const button of resultHost.querySelectorAll<HTMLButtonElement>('[data-stats-download],[data-session-index]')) button.disabled = disposed || preparing || artifactBusy || comparisonBusy || !latestRequest;
        const previous = resultHost.querySelector<HTMLButtonElement>('[data-session-prev]'), next = resultHost.querySelector<HTMLButtonElement>('[data-session-next]');
        if (previous) previous.disabled = disposed || preparing || artifactBusy || comparisonBusy || inspectionIndex <= 0;
        if (next) next.disabled = disposed || preparing || artifactBusy || comparisonBusy || inspectionIndex < 0 || inspectionIndex >= (latest?.result.sessions.length ?? 0) - 1;
        const cancel = resultHost.querySelector<HTMLButtonElement>('[data-artifact-cancel]'); if (cancel) cancel.hidden = !artifactBusy;
    }
    function stopArtifact(): void {
        artifactGeneration++; artifactController?.abort(); artifactController = null; artifactBusy = false;
        sessionChart?.destroy(); sessionChart = null;
        const viewer = resultHost.querySelector<HTMLElement>('.ms-session-view'); if (viewer) viewer.hidden = true;
        artifactButtons();
    }
    function renderPresetList(): void {
        if (!presets) return;
        const search = query<HTMLInputElement>('[data-preset-search]').value.trim().toLowerCase(), category = query<HTMLSelectElement>('[data-preset-category]').value;
        const matches = presets.presets.filter(item => (!category || item.category === category) && (!search || [item.id, item.title, item.category, item.summary, item.outcome, ...item.params.map(param => param.doc)].join(' ').toLowerCase().includes(search)));
        query<HTMLElement>('.ms-preset-count').textContent = `${presets.total} reports · ${presets.categories.length} categories · ${presets.namedVariants} named variants · ${matches.length} shown`;
        query<HTMLElement>('.ms-preset-list').innerHTML = matches.map(item => `<button type="button" class="ms-preset-card" data-preset-id="${e(item.id)}" aria-pressed="${item.id === selectedPreset}"><strong>${e(item.title)}</strong><span>${e(item.category)} · v${item.version}${item.groupBy ? ` · grouped by ${e(item.groupBy)}` : ''}</span><p>${e(item.summary)}</p>${item.availability.available ? '' : `<small class="ms-unavailable">Unavailable: ${e(item.availability.reason ?? 'Required input is unavailable.')}</small>`}</button>`).join('') || '<p class="ms-muted">No matching templates. Change the search or category.</p>';
    }
    function renderPresetDetail(saved?: Map<string, string>, grouping?: string): void {
        const item = preset(); if (!item || !presets) return;
        query<HTMLElement>('.ms-preset-detail').innerHTML = `<h3>${e(item.title)}</h3><p class="ms-muted">${e(item.id)} · version ${item.version} · ${item.namedVariants} named variants</p><p>${e(item.summary)}</p><dl><dt>Outcome</dt><dd><code>${e(item.outcome)}</code></dd>${item.where ? `<dt>Base condition</dt><dd><code>${e(item.where)}</code></dd>` : ''}<dt>Default grouping</dt><dd>${e(item.groupBy ?? 'None')}${item.groupByValues.length ? ` · ${item.groupByValues.map(e).join(', ')}` : ''}</dd></dl>
          ${item.availability.available ? '' : `<p class="ms-warning">${e(item.availability.reason ?? 'Required input is unavailable.')}</p>`}
          ${item.availability.requiredEvents.length ? `<p class="ms-muted">Required event dates: ${item.availability.requiredEvents.map(e).join(', ')}. Uncovered dates and unknown trading neighbors are excluded.</p>${item.availability.coverage.map(calendar => `<p class="ms-muted">${e(calendar.event)} · version ${e(calendar.version)} · ${e(calendar.coverage.from)} to ${e(calendar.coverage.to)} · ${calendar.dates} supplied dates</p>`).join('')}` : ''}
          <div class="ms-preset-params">${item.params.map(param => {
            const value = saved?.get(param.name) ?? String(param.default ?? '');
            const attrs = `data-preset-param="${e(param.name)}" form="${instance}-preset-draft"`;
            return `<label>${e(param.name)} <small>${e(param.type)}${param.default === undefined ? ' · optional' : ` · default ${e(String(param.default))}`}</small>${param.type === 'enum'
                ? `<select ${attrs}>${param.default === undefined ? '<option value="">Any / unset</option>' : ''}${(param.values ?? []).map(option => `<option value="${e(option)}" ${option === value ? 'selected' : ''}>${e(option)}</option>`).join('')}</select>`
                : `<input ${attrs} value="${e(value)}" type="${param.type === 'number' || param.type === 'duration' ? 'number' : 'text'}" ${param.type === 'duration' ? `min="1" max="${presets!.limits.windowMinutes}" step="1"` : param.type === 'number' ? 'step="any"' : 'maxlength="128"'}>`}<span class="ms-param-doc">${e(param.doc)}</span></label>`;
          }).join('') || '<p class="ms-muted">This template has no parameters.</p>'}</div>
          <p class="ms-muted">Duration limit: 1–${presets.limits.windowMinutes} whole minutes. Derived opening-range windows: ${presets.orWindows.join(', ')} minutes.</p>
          <label>Template grouping<select data-preset-group form="${instance}-preset-draft"><option value="__default__">Template default${item.groupBy ? ` · ${e(item.groupBy)}` : ' · none'}</option>${presets.groupableFields.map(name => `<option value="${e(name)}">${e(name)}</option>`).join('')}</select></label>
          ${item.deltas.length ? `<details><summary>Research options</summary><ul>${item.deltas.map(delta => `<li>${e(delta)}</li>`).join('')}</ul></details>` : ''}
          <div class="ms-library-links">${item.library.map(reference => /^https:\/\/www\.luxalgo\.com\/library\//.test(reference.url) ? `<a href="${e(reference.url)}" target="_blank" rel="noreferrer">${e(reference.kind)} · ${e(reference.slug)} ↗</a>` : '').join('') || '<span class="ms-muted">No Library reference is supplied for this official template.</span>'}</div>
          <details><summary>Official definition and provenance</summary><p>Edge Stats ${e(presets.source.version)} · ${e(presets.source.commit)}</p><pre>${e(JSON.stringify(item, null, 2))}</pre></details>
          <button type="button" data-preset-compose>Compose query draft</button>`;
        if (grouping && Array.from(query<HTMLSelectElement>('[data-preset-group]').options).some(option => option.value === grouping)) query<HTMLSelectElement>('[data-preset-group]').value = grouping;
        composeEnabled();
    }
    async function loadPresets(): Promise<void> {
        if (disposed || preparing) return;
        const request = ++presetGeneration; presetController?.abort(); const abort = new AbortController(); presetController = abort; stopCompose();
        presetStatus.textContent = 'Loading official templates…';
        try {
            const next = await api.get<PresetCatalog>(`/api/market-stats/presets${input('eventCalendar').checked ? '?events=bundled' : ''}`, abort.signal);
            if (disposed || request !== presetGeneration) return;
            if (!Array.isArray(next.presets) || !Array.isArray(next.categories)) throw new Error('The official template catalog is unavailable. Retry loading templates.');
            const values = new Map(Array.from(host.querySelectorAll<HTMLInputElement>('[data-preset-param]'), control => [control.dataset.presetParam!, control.value]));
            const group = host.querySelector<HTMLSelectElement>('[data-preset-group]')?.value;
            const category = query<HTMLSelectElement>('[data-preset-category]').value;
            presets = next; if (!preset()) selectedPreset = next.presets.find(item => item.id === 'gap-fill')?.id ?? next.presets[0]?.id ?? '';
            query<HTMLSelectElement>('[data-preset-category]').innerHTML = '<option value="">All categories</option>' + next.categories.map(item => `<option value="${e(item.id)}">${e(item.title)} · ${item.count}</option>`).join('');
            query<HTMLSelectElement>('[data-preset-category]').value = category;
            renderPresetList(); renderPresetDetail(values, group); presetStatus.textContent = `${next.total} official templates loaded. Select a template to inspect its definition and parameters.`;
        } catch (error) { if (!disposed && request === presetGeneration) presetStatus.textContent = error instanceof Error ? error.message : 'Templates could not be loaded.'; }
        finally { if (request === presetGeneration) { presetController = null; composeEnabled(); } }
    }
    function draftStamp(): string { return JSON.stringify(Array.from(form.querySelectorAll<HTMLInputElement>('input,select,textarea'), field => [field.name, field.dataset.presetParam, field.value, field.checked])); }
    async function compose(): Promise<void> {
        const item = preset(); if (disposed || preparing || !item?.availability.available || !presets || presetController) return;
        stopCompose(); const token = composeGeneration, params: Record<string, number | string> = {};
        try {
            for (const spec of item.params) {
                const control = host.querySelector<HTMLInputElement>(`[data-preset-param="${spec.name}"]`)!;
                if (!control.value.trim()) continue;
                if (spec.type === 'duration' && (!Number.isInteger(Number(control.value)) || Number(control.value) < 1 || Number(control.value) > presets.limits.windowMinutes)) throw new RangeError(`Preset durations must be whole minutes from 1 to ${presets.limits.windowMinutes}.`);
                if (!control.checkValidity()) throw new RangeError(`Choose a valid ${spec.name} parameter.`);
                const value = spec.type === 'number' || spec.type === 'duration' ? Number(control.value) : control.value;
                if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError(`Choose a finite ${spec.name}.`);
                params[spec.name] = value;
            }
        } catch (error) { presetStatus.textContent = error instanceof Error ? error.message : 'Choose valid template parameters.'; return; }
        const group = query<HTMLSelectElement>('[data-preset-group]').value, stamp = draftStamp();
        const abort = new AbortController(); composeController = abort; composeEnabled(); presetStatus.textContent = 'Composing through the official query engine…';
        try {
            const built = await api.post<BuiltStatsPreset>('/api/market-stats/preset', { id: item.id, params, ...(group !== '__default__' ? { groupBy: group } : {}), ...(input('eventCalendar').checked ? { eventCalendar: 'bundled' } : {}) }, abort.signal);
            if (disposed || token !== composeGeneration || selectedPreset !== item.id) return;
            if (stamp !== draftStamp()) { presetStatus.textContent = 'The draft changed while composing. Compose again when ready.'; return; }
            if (typeof built.dsl !== 'string' || built.dsl.length > presets.limits.dslLength || built.preset.id !== item.id) throw new Error('The template returned an invalid composed query.');
            invalidate(); input('dsl').value = built.dsl;
            if (built.groupBy && !Array.from(select('groupBy').options).some(option => option.value === built.groupBy)) select('groupBy').add(new Option(built.groupBy, built.groupBy));
            select('groupBy').value = built.groupBy ?? '';
            query<HTMLElement>('[data-preset-normalized]').textContent = built.dsl;
            presetStatus.textContent = `${built.preset.title} v${built.preset.version} composed. Review the query, then run statistics.`;
            status.textContent = 'Query draft composed. Run statistics to compute a new result.';
        } catch (error) { if (!disposed && token === composeGeneration) presetStatus.textContent = error instanceof Error ? error.message : 'The template could not be composed.'; }
        finally { if (token === composeGeneration) { composeController = null; composeEnabled(); } }
    }
    const source = () => catalog?.datasets.find(dataset => dataset.id === select('datasetId').value);
    const replaySource = () => catalog?.sessions.find(item => item.id === select('replayId').value && item.datasetId === source()?.id);
    function bounds(): { start: number; end: number } | undefined {
        const dataset = source(); if (!dataset) return;
        const replay = select('sourceMode').value === 'replay' ? replaySource() : undefined;
        if (select('sourceMode').value === 'replay' && !replay) return;
        return { start: Math.max(dataset.start, replay?.startTime ?? dataset.start), end: Math.min(dataset.end, replay?.endTime ?? dataset.end) };
    }
    const pickers = mountDateTimePickers(form, { range: input => {
        const range = bounds(); if (!range) return { start: 0, end: 0, endInclusive: false };
        return { start: range.start + (input.name === 'until' ? 60_000 : 0), end: range.end, endInclusive: input.name === 'until' };
    } });
    function busy(value: boolean): void { runButton.disabled = disposed || preparing || loading || value || comparisonBusy || !bounds() || source()?.schema !== 'ohlcv-1m' || source()?.intervalMs !== 60_000;
        cancelButton.hidden = !value; form.setAttribute('aria-busy', String(value)); }
    function cancel(): void { generation++; if (controller) { controller.abort(); status.textContent = 'Statistics cancelled.'; } controller = null;
        comparison.update(null); comparisonHost.hidden = true; stopCompose(); stopArtifact(); busy(false); }
    function invalidate(): void { cancel(); latest = null; latestRequest = null; inspectionIndex = -1; resultHost.hidden = true; }
    function sourceInfo(resetDates = false): void {
        const dataset = source(); const replay = select('sourceMode').value === 'replay'; query<HTMLElement>('.ms-replay').hidden = !replay;
        const currentReplay = select('replayId').value;
        select('replayId').innerHTML = (catalog?.sessions.filter(item => item.datasetId === dataset?.id) ?? []).map(item => `<option value="${e(item.id)}">${e(item.name)} · revision ${item.revision}</option>`).join('');
        if (Array.from(select('replayId').options).some(option => option.value === currentReplay)) select('replayId').value = currentReplay;
        const range = bounds();
        if (dataset && range) {
            for (const name of ['from', 'until']) { input(name).disabled = false; input(name).min = dateTime(range.start); input(name).max = dateTime(range.end); }
            if (resetDates || !input('from').value || !input('until').value) {
                input('from').value = dateTime(Math.max(range.start, range.end - 180 * 86_400_000)); input('until').value = dateTime(range.end);
            }
            query<HTMLElement>('.ms-coverage').textContent = `${dataset.symbol} · ${dataset.barCount.toLocaleString('en-US')} cached bars · ${utc(range.start)} to ${utc(range.end)} (excluded).${replay ? ' The server caps this range at the saved replay’s revealed bars; no future bars are used.' : ''}${dataset.continuous ? ' Unadjusted continuous history: mixed or partial contract sessions are omitted. Contract rolls reset prior-session features. Maximum 250,000 one-minute bars per query; choose a shorter range for larger caches.' : ''}`;
        } else {
            for (const name of ['from', 'until']) input(name).disabled = true;
            query<HTMLElement>('.ms-coverage').textContent = dataset && replay ? 'No saved replay is available for this dataset. Choose cached history or save a replay first.' : 'Import or download one-minute contract data in Data & settings to begin.';
        }
        pickers.sync();
        busy(false);
    }
    function refresh(): Promise<void> { return track(Promise.all([loadSources(), loadPresets()]).then(() => undefined)); }
    async function loadSources(): Promise<void> {
        if (disposed || preparing) return;
        const request = ++loadGeneration; loadController?.abort(); const abort = new AbortController(); loadController = abort;
        loading = true; invalidate();
        status.textContent = 'Loading cached sources…';
        try {
            const next = await api.get<MarketStatsCatalog>('/api/market-stats', abort.signal);
            if (disposed || request !== loadGeneration) return;
            const selected = select('datasetId').value, group = select('groupBy').value;
            catalog = next;
            select('datasetId').innerHTML = next.datasets.map(dataset => `<option value="${e(dataset.id)}" ${dataset.intervalMs !== 60_000 || dataset.schema !== 'ohlcv-1m' ? 'disabled' : ''}>${e(dataset.name)} · ${e(dataset.symbol)}${dataset.intervalMs !== 60_000 || dataset.schema !== 'ohlcv-1m' ? ' · one-minute data required' : dataset.continuous ? ' · unadjusted continuous' : ''}</option>`).join('');
            const available = next.datasets.filter(dataset => dataset.intervalMs === 60_000 && dataset.schema === 'ohlcv-1m');
            select('datasetId').value = available.some(item => item.id === selected) ? selected : available[0]?.id ?? '';
            select('groupBy').innerHTML = '<option value="">No grouping</option>' + next.registry.filter(entry => entry.groupable).map(entry => `<option value="${e(entry.name)}">${e(entry.title)}</option>`).join('');
            if (Array.from(select('groupBy').options).some(option => option.value === group)) select('groupBy').value = group;
            query<HTMLElement>('.ms-examples').innerHTML = next.registry.filter(entry => entry.kind === 'outcome' && ['closeGreen', 'gapFill', 'orbBreak', 'ibSingleBreak'].includes(entry.name))
                .map(entry => `<button type="button" data-query="${e(entry.name === 'closeGreen' ? entry.name : entry.examples?.[0] ?? entry.name)}">${e(entry.title)}</button>`).join('');
            query<HTMLElement>('.ms-registry').innerHTML = next.registry.map(entry => `<div><strong>${e(entry.name)}</strong> <span>${e(entry.kind)}</span><p>${e(entry.doc)}</p>${entry.examples?.length ? `<code>${e(entry.examples[0])}</code>` : ''}</div>`).join('');
            sourceInfo(selected !== select('datasetId').value); status.textContent = available.length ? 'Ready. Select an explicit history range and session schedule.' : 'No supported one-minute source. Open Data & settings to add one.';
        } catch (error) { if (!disposed && request === loadGeneration) status.textContent = error instanceof Error ? error.message : 'Cached sources could not be loaded.'; }
        finally { if (!disposed && request === loadGeneration) { loading = false; loadController = null; busy(false); } }
    }
    const number = (value: number | null | undefined): string => value === null || value === undefined ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 4 });
    function render(response: MarketStatsPageResponse): void {
        const r = response.result; latest = response; resultHost.hidden = false;
        const table = (headers: string[], rows: string[][], inspect = false): string => `<div class="ms-table-scroll"><table><thead><tr>${headers.map(value => `<th>${e(value)}</th>`).join('')}${inspect ? '<th>Inspect</th>' : ''}</tr></thead><tbody>${rows.map((row, index) => `<tr>${row.map(value => `<td>${e(value)}</td>`).join('')}${inspect ? `<td><button type="button" data-session-index="${index}">View session</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
        resultHost.innerHTML = `<div class="ms-result-heading"><div><p class="ms-eyebrow">HISTORICAL CONDITIONAL FREQUENCY</p><h2>${e(r.query.outcome)}</h2><code>${e(r.query.dsl)}</code></div><div class="ms-report-actions"><button type="button" data-stats-export>Download result JSON</button><button type="button" data-stats-download="csv">Matched rows · CSV</button><button type="button" data-stats-download="parquet">Matched rows · Parquet</button><button type="button" data-artifact-cancel hidden>Cancel inspection/export</button></div></div>
          <p>${e(response.selection.symbol)} · ${e(r.query.sessionKey)} · ${e(utc(response.selection.from))} – ${e(utc(response.selection.until))} (excluded)${response.selection.replay ? ` · saved replay revision ${response.selection.replay.revision}` : ' · cached history'}</p>
          ${response.warnings.map(warning => `<p class="ms-warning">${e(warning)}</p>`).join('')}
          ${r.guards.refused ? '<p class="ms-warning">Insufficient sample: estimate withheld. At least 10 eligible completed sessions are required.</p>' : r.guards.lowSample ? '<p class="ms-warning">Low sample: fewer than 30 eligible sessions. Treat this estimate cautiously.</p>' : ''}
          <div class="ms-metrics"><article><span>Estimate</span><strong>${pct(r.estimate)}</strong></article><article><span>95% confidence interval</span><strong>${interval(r.ci95)}</strong></article><article><span>Eligible sessions · N</span><strong>${number(r.n)}</strong></article><article><span>Observed successes</span><strong>${number(r.successes)}</strong></article></div>
          <h3>Stability and recent history</h3>${r.stability ? table(['Period', 'N', 'Successes', 'Estimate', '95% interval'], [[ 'First half', number(r.stability.firstHalf.n), number(r.stability.firstHalf.k), pct(r.stability.firstHalf.estimate), interval(r.stability.firstHalf.ci95)], ['Second half', number(r.stability.secondHalf.n), number(r.stability.secondHalf.k), pct(r.stability.secondHalf.estimate), interval(r.stability.secondHalf.ci95)]]) : '<p>No stability split available.</p>'}
          <p>Half-period intervals ${r.stability?.agree === null || !r.stability ? 'cannot be compared yet' : r.stability.agree ? 'overlap' : 'do not overlap'}.</p>
          ${r.recency ? table(['Recent window', 'N', 'Successes', 'Estimate', '95% interval'], [[`Last ${r.recency.window} sessions`, number(r.recency.n), number(r.recency.successes), pct(r.recency.estimate), interval(r.recency.ci95)]]) : ''}
          <h3>By year</h3>${table(['Year', 'N', 'Successes', 'Estimate'], r.perYear.map(row => [String(row.year), number(row.n), number(row.successes), pct(row.estimate)]))}
          ${r.groups ? `<h3>Grouped results</h3>${table(['Group', 'N', 'Successes', 'Estimate', '95% interval', 'Sample'], r.groups.map(row => [row.group, number(row.n), number(row.successes), pct(row.estimate), interval(row.ci95), row.lowSample ? 'Low sample' : '']))}` : ''}
          ${r.distribution ? `<h3>Outcome distribution · ${e(r.distribution.unit)}</h3>${table(['N', 'Mean', 'Minimum', '25th', 'Median', '75th', '90th', 'Maximum'], [[number(r.distribution.count), number(r.distribution.mean), number(r.distribution.min), number(r.distribution.p25), number(r.distribution.median), number(r.distribution.p75), number(r.distribution.p90), number(r.distribution.max)]])}` : ''}
          <h3>Counted sessions</h3><p class="ms-muted">Showing ${r.sessions.length} matching sessions, capped at 100. This is a sample listing; N above is the full eligible count.</p>
          ${table(['Trade date', 'Outcome', 'Value', 'Source session ID'], r.sessions.map(row => [row.tradeDate, row.success ? 'Occurred' : 'Did not occur', number(row.value), row.sessionId]), true)}
          <p class="ms-muted">CSV and Parquet contain the full matched feature rows, including outcome columns, within the 8 MB export limit. Session navigation uses the matching sessions listed above.</p>
          <p class="ms-artifact-status" role="status" aria-live="polite"></p><section class="ms-session-view" aria-label="Matched session inspection" hidden></section>
          <details><summary>Source and reproducibility</summary><p>Edge Stats ${e(response.source.version)} · ${e(response.source.commit)}</p><p>Dataset checksum: <code>${e(response.selection.checksum)}</code></p><p>Input: ${response.coverage.eligibleBarCount.toLocaleString('en-US')} fully closed bars · fingerprint <code>${e(response.coverage.fingerprint)}</code></p><p>Store: <code>${e(r.engine.storeFingerprint)}</code> · calendar: <code>${e(r.engine.calendarVersion)}</code></p></details>
          <p class="ms-disclaimer">${e(r.disclaimer)}</p>`;
    }
    function download(blob: Blob, filename: string): void {
        const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename;
        try { link.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
    }
    async function artifact(kind: 'session' | 'csv' | 'parquet', index = inspectionIndex): Promise<void> {
        if (disposed || preparing || artifactBusy || comparisonBusy || !latest || !latestRequest) return;
        const owner = latest, request = structuredClone(latestRequest);
        const match = owner.result.sessions[index]; if (kind === 'session' && !match) return;
        const context = Number(resultHost.querySelector<HTMLInputElement>('[data-session-context]')?.value ?? 30);
        if (kind === 'session' && (!Number.isInteger(context) || context < 0 || context > 240)) { query<HTMLElement>('.ms-artifact-status').textContent = 'Context must be a whole number from 0 to 240 bars.'; return; }
        stopArtifact(); const token = artifactGeneration, abort = new AbortController(); artifactController = abort; artifactBusy = true;
        const current = (): boolean => !disposed && !abort.signal.aborted && token === artifactGeneration && latest === owner;
        const message = query<HTMLElement>('.ms-artifact-status'); message.textContent = kind === 'session' ? 'Loading matched one-minute session…' : `Preparing full matched ${kind.toUpperCase()} rows…`; artifactButtons();
        try {
            const response = await api.post<ArtifactResponse>(`/api/market-stats/${kind === 'session' ? 'session' : 'export'}`, kind === 'session'
                ? { request, sessionId: match!.sessionId, contextBars: context } : { request, format: kind }, abort.signal);
            if (!current()) return;
            if (kind === 'session') {
                if (response.kind !== 'session' || response.session.sessionId !== match!.sessionId) throw new Error('The returned session does not match the selected result.');
                const s = response.session; inspectionIndex = index;
                const viewer = query<HTMLElement>('.ms-session-view'); viewer.hidden = false;
                viewer.innerHTML = `<div class="ms-session-heading"><div><h3>${e(s.tradeDate)} · ${e(s.symbol)} · one-minute candles</h3><p>Matched session ${index + 1} of ${owner.result.sessions.length} listed · ${e(s.sessionKey)} · ${e(s.tz)}${s.isRollDay ? ' · contract roll day' : ''}${s.isHalfDay ? ' · half day' : ''}</p></div><div class="ms-report-actions"><button type="button" data-session-prev>← Previous matched</button><button type="button" data-session-next>Next matched →</button><button type="button" data-session-close>Close chart</button></div></div>
                  <p class="ms-muted">Query: <code>${e(owner.result.query.dsl)}</code> · ${e(response.selection.symbol)} · checksum ${e(response.selection.checksum)}${response.selection.replay ? ` · saved replay revision ${response.selection.replay.revision}` : ''}</p>
                  <label class="ms-context-control">Pre-session context bars · 0–240<input data-session-context type="number" min="0" max="240" step="1" value="${context}"></label><p class="ms-muted">${e(s.context.kind)} · ${e(s.context.note)} · ${s.context.bars.length} context bars</p>
                  <div class="ms-session-chart" aria-label="Offline matched session candles"></div><p class="ms-muted">Prior high/low/close and session open are lines; the gap is shaded. Opening-range levels and event times come from this session’s returned feature row.</p>
                  <dl class="ms-session-levels">${[['Prior high', s.levels.prevHigh], ['Prior low', s.levels.prevLow], ['Prior close', s.levels.prevClose], ['Session open', s.levels.open], ['Gap', s.levels.gapAbs], ...s.levels.openingRanges.flatMap(range => [[`OR ${range.window}m high`, range.high], [`OR ${range.window}m low`, range.low]])].map(([label, value]) => `<div><dt>${e(String(label))}</dt><dd>${number(value as number | null)}</dd></div>`).join('')}</dl>
                  <p class="ms-muted">${e(s.disclaimer)} · Input fingerprint ${e(response.coverage.fingerprint)}</p>`;
                const mounted = await mountStatsSessionChart(viewer.querySelector<HTMLElement>('.ms-session-chart')!, s, abort.signal);
                if (!current()) { mounted?.destroy(); return; }
                sessionChart = mounted;
                message.textContent = `${s.bars.length} one-minute candles loaded for ${s.tradeDate}. Query and source remain pinned to the displayed result.`;
            } else {
                if (response.kind !== 'export' || response.format !== kind || !Number.isSafeInteger(response.bytes) || response.bytes < 0 || response.bytes > 8_000_000
                    || typeof response.data !== 'string' || response.data.length > 10_666_668 || !/^[a-f0-9]{64}$/.test(response.sha256)) throw new Error('The export response exceeds its bounds or has invalid metadata.');
                const bytes = Uint8Array.from(atob(response.data), character => character.charCodeAt(0));
                if (bytes.length !== response.bytes) throw new Error('The export byte count does not match its response.');
                const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
                if (!current()) return;
                if (hash !== response.sha256) throw new Error('The export SHA-256 does not match its response.');
                download(new Blob([bytes], { type: kind === 'csv' ? 'text/csv;charset=utf-8' : 'application/vnd.apache.parquet' }), `vela-market-stats-${response.selection.symbol.replace(/[^A-Za-z0-9._-]/g, '_')}.${kind}`);
                message.textContent = `${response.rows.toLocaleString('en-US')} full matched feature rows · ${response.bytes.toLocaleString('en-US')} bytes · ${kind.toUpperCase()} · SHA-256 ${response.sha256} · Query: ${owner.result.query.dsl} · ${response.selection.symbol} · checksum ${response.selection.checksum}`;
            }
        } catch (error) { if (current()) message.textContent = error instanceof Error ? error.message : 'Statistics inspection could not complete.'; }
        finally { if (current()) { artifactBusy = false; artifactButtons(); } }
    }
    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault(); event.stopPropagation(); if (disposed || preparing || !form.reportValidity() || !catalog || !source() || runButton.disabled) return;
        let from: number, until: number;
        try {
            from = parseWallTime(input('from').value, 'UTC'); until = parseWallTime(input('until').value, 'UTC');
            const range = bounds();
            if (from % 60_000 || until % 60_000) throw new RangeError('Choose whole-minute times for one-minute source bars.');
            if (from >= until) throw new RangeError('The start must be before the excluded end.');
            if (!range || from < range.start || until > range.end) throw new RangeError('Choose times inside the available source range.');
            if (until - from > catalog.limits.spanMs) throw new RangeError('Choose a shorter history range within the query limit.');
        } catch (error) { status.textContent = error instanceof Error ? error.message : 'Choose a valid UTC date range.'; return; }
        cancel(); latest = null; latestRequest = null; const request = generation; const dataset = source()!; const abort = new AbortController(); controller = abort; busy(true);
        status.textContent = 'Computing complete sessions locally…'; resultHost.hidden = true;
        const sourceMode = select('sourceMode').value as 'cache' | 'replay';
        const replay = catalog.sessions.find(item => item.id === select('replayId').value);
        const payload: MarketStatsRequest = { datasetId: dataset.id, sourceMode, from, until,
            ...(sourceMode === 'replay' && replay ? { replay: { id: replay.id, revision: replay.revision } } : {}),
            session: { key: 'selected', start: input('open').value, end: input('close').value, tz: input('zone').value, overnight: input('overnight').checked }, calendar: null,
            ...(input('eventCalendar').checked ? { eventCalendar: 'bundled' as const } : {}),
            query: { dsl: input('dsl').value, sessionsLimit: 100, ...(input('since').value ? { since: input('since').value } : {}),
                ...(input('through').value ? { until: input('through').value } : {}), ...(select('groupBy').value ? { groupBy: select('groupBy').value } : {}) } };
        try {
            const response = await api.post<MarketStatsPageResponse>('/api/market-stats/query', payload, abort.signal);
            if (disposed || request !== generation) return;
            latestRequest = structuredClone(payload); render(response);
            comparison.update(payload.eventCalendar === 'bundled' ? { request: payload, result: response, calendars: eventCalendars } : null);
            comparisonHost.hidden = payload.eventCalendar !== 'bundled';
            status.textContent = 'Statistics complete. The sample count and source coverage are shown below.';
        } catch (error) {
            if (!disposed && request === generation) status.textContent = abort.signal.aborted ? 'Statistics cancelled.' : error instanceof Error ? error.message : 'Statistics could not be computed.';
        } finally { if (!disposed && request === generation) { controller = null; busy(false); } }
    }
    const change = (event: Event): void => {
        if ((event.target as Element).closest('.date-time-picker')) return;
        const target = event.target as HTMLInputElement;
        if (target.closest('.ms-presets')) {
            if (target.matches('[data-preset-search],[data-preset-category]')) renderPresetList();
            else { stopCompose(); query<HTMLElement>('[data-preset-normalized]').textContent = ''; presetStatus.textContent = 'Template parameters changed. Compose again to update the query draft.'; }
            return;
        }
        invalidate(); status.textContent = 'Query changed. Run statistics again for this draft.';
        const name = target.name;
        if (name === 'eventCalendar' && event.type === 'change') void track(loadPresets());
        if (name === 'datasetId' || name === 'sourceMode' || name === 'replayId') sourceInfo(true);
        if (name === 'schedule') {
            const full = select('schedule').value === 'utc';
            if (select('schedule').value !== 'custom') { input('open').value = full ? '00:00' : '09:30'; input('close').value = full ? '24:00' : '16:00'; input('zone').value = full ? 'UTC' : 'America/New_York'; input('overnight').checked = false; }
        }
    };
    const click = (event: MouseEvent): void => {
        const target = (event.target as Element).closest<HTMLButtonElement>('button'); if (!target) return;
        if (target.hasAttribute('data-stats-home')) callbacks.onHome();
        if (target.hasAttribute('data-stats-data')) callbacks.onData();
        if (target.hasAttribute('data-stats-cancel')) { cancel(); status.textContent = 'Statistics cancelled.'; }
        if (target.hasAttribute('data-stats-refresh')) void refresh();
        if (target.hasAttribute('data-presets-refresh')) void track(loadPresets());
        if (target.dataset.presetId) {
            stopCompose(); selectedPreset = target.dataset.presetId; renderPresetList(); renderPresetDetail();
            query<HTMLElement>('[data-preset-normalized]').textContent = ''; presetStatus.textContent = preset()?.availability.reason ?? 'Review parameters and compose when ready.';
        }
        if (target.hasAttribute('data-preset-compose')) void track(compose());
        if (target.dataset.sessionIndex !== undefined) void track(artifact('session', Number(target.dataset.sessionIndex)));
        if (target.hasAttribute('data-session-prev')) void track(artifact('session', inspectionIndex - 1));
        if (target.hasAttribute('data-session-next')) void track(artifact('session', inspectionIndex + 1));
        if (target.hasAttribute('data-session-close')) stopArtifact();
        if (target.hasAttribute('data-artifact-cancel')) { stopArtifact(); query<HTMLElement>('.ms-artifact-status').textContent = 'Inspection/export cancelled. Displayed statistics are unchanged.'; }
        if (target.dataset.statsDownload === 'csv' || target.dataset.statsDownload === 'parquet') void track(artifact(target.dataset.statsDownload));
        if (target.dataset.query) { invalidate(); input('dsl').value = target.dataset.query; input('dsl').focus(); }
        if (target.hasAttribute('data-stats-export') && latest) {
            download(new Blob([JSON.stringify(latest, null, 2) + '\n'], { type: 'application/json' }), 'vela-market-stats.json');
        }
    };
    const onSubmit = (event: SubmitEvent): void => { void track(submit(event)); };
    function prepare(): Promise<void> {
        if (preparation) return preparation;
        preparing = true; loadGeneration++; presetGeneration++; presetController?.abort(); presetController = null; loadController?.abort(); loadController = null; loading = false; cancel();
        track(comparison.prepareToLeave());
        preparation = (async () => {
            try { while (pending.size) await Promise.allSettled([...pending]); }
            finally { preparing = false; preparation = null; busy(false); composeEnabled(); artifactButtons(); }
        })();
        return preparation;
    }
    const contextChanged = (event: Event): void => { if ((event.target as Element).matches('[data-session-context]')) void track(artifact('session')); };
    host.addEventListener('change', contextChanged);
    form.addEventListener('submit', onSubmit); form.addEventListener('input', change); form.addEventListener('change', change); host.addEventListener('click', click);
    void refresh();
    return { refresh, cancel, prepare, destroy(): void { if (disposed) return; disposed = true; loadGeneration++; presetGeneration++; presetController?.abort(); presetController = null; loadController?.abort(); loadController = null; cancel();
        track(comparison.destroy()); pickers.destroy(); removeUpdates(); form.removeEventListener('submit', onSubmit); form.removeEventListener('input', change); form.removeEventListener('change', change); host.removeEventListener('change', contextChanged); host.removeEventListener('click', click); host.replaceChildren(); } };
}
