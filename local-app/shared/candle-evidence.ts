import { ANALYSIS_LIMITS, byteLength, type AnalysisDatasetIdentity, type AnalysisScopeSummary } from './chart-analysis';
import { nextTimeframeBucket, parseTimeframe, timeframeBucket, timeframeSupported } from './timeframes';
import type { Bar } from './types';

export const CANDLE_EVIDENCE_LIMITS = { rawBars: 10_000, displayedBars: 101, priorBars: 100, priorDefault: 20, responseBytes: 256 * 1024 } as const;

export interface CandleBarEnvelope {
    dataset: AnalysisDatasetIdentity;
    cursorTime: number;
    sourceCutoff: number;
    bars: readonly Bar[];
}

export type CandleTransform = { kind: 'none' } | { kind: 'heikinashi' } | { kind: 'other'; label: string };

export interface CandleEvidenceSnapshot {
    scope: AnalysisScopeSummary;
    selectedTime: number;
    /** Complete query coverage [from, to), including empty intervals; source-resolution, untransformed bars only. */
    raw: CandleBarEnvelope & { from: number; to: number };
    /** Actual displayed OHLCV at scope.chart.timeframe; never fabricate these from the raw series. */
    displayed: CandleBarEnvelope;
    transform: CandleTransform;
    priorLimit?: number;
    /** Recheck session, generation, cell, timeframe, transform, dataset and cursor against their captured values. */
    assertCurrent: () => void;
}

export interface CandleEvidenceRef {
    id: string;
    formula: string;
    provenance: string;
    inputs: { series: 'raw' | 'displayed'; bar: Bar }[];
    value: number | null;
    sampleCount: number;
}

export interface CandleFact { id: string; label: string; value: number | null; unit: 'price' | 'percent' | 'volume' | 'ratio'; evidenceIds: string[] }
export interface CandleStatement { id: string; text: string; evidenceIds: string[] }
export interface CandleEvidence {
    version: 1;
    scope: AnalysisScopeSummary;
    selectedTime: number;
    transform: CandleTransform;
    raw: Bar;
    displayed: Bar;
    forming: boolean;
    coverage: { rawBars: number; displayedBars: number; priorBars: number; from: number; to: number };
    facts: CandleFact[];
    statements: CandleStatement[];
    evidence: CandleEvidenceRef[];
    causes: { status: 'unavailable'; reason: string; evidenceIds: string[] };
}

function requireValue(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function text(value: unknown, max = 256): asserts value is string {
    requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value), 'Candle identity must be bounded plain text.');
}

function time(value: unknown): asserts value is number {
    requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= ANALYSIS_LIMITS.maxTime, 'Invalid candle evidence timestamp.');
}

function finite(value: unknown): asserts value is number {
    requireValue(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e100, 'Candle values must be finite and within ±1e100.');
}

function dataset(value: AnalysisDatasetIdentity): AnalysisDatasetIdentity {
    requireValue(value && typeof value === 'object', 'Missing candle dataset identity.');
    text(value.id); text(value.checksum); text(value.symbol, 100);
    requireValue(value.schema === 'ohlcv-1s' || value.schema === 'ohlcv-1m', 'Unsupported candle source schema.');
    requireValue(value.intervalMs === (value.schema === 'ohlcv-1s' ? 1000 : 60_000), 'Source interval does not match its schema.');
    return { id: value.id, checksum: value.checksum, symbol: value.symbol, schema: value.schema, intervalMs: value.intervalMs };
}

function bar(value: Bar): Bar {
    requireValue(value && typeof value === 'object', 'Missing candle values.'); time(value.time);
    for (const key of ['open', 'high', 'low', 'close', 'volume'] as const) finite(value[key]);
    requireValue(value.high >= Math.max(value.open, value.close) && value.low <= Math.min(value.open, value.close) && value.volume >= 0, 'Malformed OHLCV candle.');
    requireValue((value.instrumentId === undefined) === (value.contract === undefined), 'Source contract identity must be paired.');
    if (value.instrumentId !== undefined) { text(value.instrumentId, 100); text(value.contract, 100); }
    return { time: value.time, open: value.open, high: value.high, low: value.low, close: value.close, volume: value.volume,
        ...(value.instrumentId === undefined ? {} : { instrumentId: value.instrumentId, contract: value.contract }) };
}

function scopeCopy(value: AnalysisScopeSummary, now: number): AnalysisScopeSummary {
    requireValue(value && typeof value === 'object' && value.target && value.clock && value.chart && value.region, 'A pinned analysis scope is required.');
    text(value.scopeId); text(value.target.clientId, 128); text(value.target.sessionId, 128);
    requireValue(Number.isSafeInteger(value.target.generation) && value.target.generation >= 0, 'Invalid chart generation.');
    if (value.target.cellId !== undefined) text(value.target.cellId, 128);
    time(now); time(value.createdAt); time(value.expiresAt); time(value.cursorTime);
    requireValue(value.createdAt <= now && value.expiresAt > now && value.expiresAt > value.createdAt && value.expiresAt - value.createdAt <= ANALYSIS_LIMITS.scopeTtlMs, 'The candle analysis scope is expired or has an invalid lifetime.');
    const identity = dataset(value.dataset);
    time(value.clock.sourceCutoff); time(value.clock.availableUntil); text(value.clock.label, 2000);
    requireValue(value.clock.sourceIntervalMs === identity.intervalMs && value.clock.availableUntil === value.clock.sourceCutoff + identity.intervalMs && value.clock.sourceCutoff <= value.cursorTime
        && value.cursorTime % identity.intervalMs === 0 && value.clock.sourceCutoff % identity.intervalMs === 0, 'The candle scope has an inconsistent source candle clock or cursor.');
    text(value.chart.symbol, 128); text(value.chart.timeframe, 8);
    const period = parseTimeframe(value.chart.timeframe);
    requireValue(period && timeframeSupported(value.chart.timeframe, identity.schema) && period.intervalMs === value.chart.intervalMs, 'Unsupported or inconsistent chart timeframe.');
    const { from, to, requestedFrom, requestedTo, clamped, origin, drawingId, priceLow, priceHigh } = value.region;
    for (const point of [from, to, requestedFrom, requestedTo]) time(point);
    requireValue(from <= to && requestedFrom <= requestedTo && from === requestedFrom && to === Math.min(requestedTo, value.cursorTime) && value.clock.sourceCutoff <= to
        && clamped === (to !== requestedTo) && ['range', 'visible', 'drawing'].includes(origin), 'Invalid pinned candle region.');
    if (drawingId !== undefined) text(drawingId, 128);
    if (priceLow !== undefined) finite(priceLow); if (priceHigh !== undefined) finite(priceHigh);
    requireValue(priceLow === undefined || priceHigh === undefined || priceLow <= priceHigh, 'Invalid region price bounds.');
    return {
        scopeId: value.scopeId, target: { clientId: value.target.clientId, sessionId: value.target.sessionId, generation: value.target.generation,
            ...(value.target.cellId === undefined ? {} : { cellId: value.target.cellId }) },
        createdAt: value.createdAt, expiresAt: value.expiresAt, cursorTime: value.cursorTime,
        clock: { sourceCutoff: value.clock.sourceCutoff, availableUntil: value.clock.availableUntil, sourceIntervalMs: value.clock.sourceIntervalMs, label: value.clock.label },
        chart: { symbol: value.chart.symbol, timeframe: value.chart.timeframe, intervalMs: value.chart.intervalMs }, dataset: identity,
        region: { from, to, requestedFrom, requestedTo, clamped, origin, ...(drawingId === undefined ? {} : { drawingId }),
            ...(priceLow === undefined ? {} : { priceLow }), ...(priceHigh === undefined ? {} : { priceHigh }) },
    };
}

function envelope(value: CandleBarEnvelope, scope: AnalysisScopeSummary, max: number): Bar[] {
    requireValue(value && typeof value === 'object', 'Missing candle series envelope.');
    requireValue(JSON.stringify(dataset(value.dataset)) === JSON.stringify(scope.dataset), 'Candle series has a mixed dataset identity.');
    requireValue(value.cursorTime === scope.cursorTime && value.sourceCutoff === scope.clock.sourceCutoff, 'Candle series belongs to a stale cursor or cutoff.');
    requireValue(Array.isArray(value.bars) && value.bars.length > 0 && value.bars.length <= max, `Candle series must contain 1–${max} bars.`);
    const bars = value.bars.map(bar);
    for (let i = 0; i < bars.length; i++) {
        requireValue(bars[i]!.time <= scope.clock.sourceCutoff, 'Future candles are unavailable at the pinned clock.');
        requireValue(i === 0 || bars[i]!.time > bars[i - 1]!.time, 'Candle times must be unique and strictly increasing.');
    }
    return bars;
}

function rounded(value: number): string { return Number.isFinite(value) ? String(Number(value.toPrecision(8))) : 'unavailable'; }
function numeric(value: number): number | null { return Number.isFinite(value) ? value === 0 ? 0 : value : null; }

/** Pure local arithmetic. The caller supplies authoritative scope/series and the live ownership guard. */
export function buildCandleEvidence(snapshot: CandleEvidenceSnapshot, options: { now?: number } = {}): CandleEvidence {
    requireValue(snapshot && typeof snapshot === 'object' && typeof snapshot.assertCurrent === 'function', 'A live candle ownership guard is required.');
    snapshot.assertCurrent();
    const scope = scopeCopy(snapshot.scope, options.now ?? Date.now());
    const { selectedTime } = snapshot; time(selectedTime);
    requireValue(selectedTime >= scope.region.from && selectedTime <= scope.region.to && selectedTime <= scope.clock.sourceCutoff, 'Selected candle is outside the pinned revealed region.');
    const priorLimit = snapshot.priorLimit ?? CANDLE_EVIDENCE_LIMITS.priorDefault;
    requireValue(Number.isInteger(priorLimit) && priorLimit >= 1 && priorLimit <= CANDLE_EVIDENCE_LIMITS.priorBars, 'Invalid prior candle comparison limit.');
    const transform = snapshot.transform;
    requireValue(transform && ['none', 'heikinashi', 'other'].includes(transform.kind), 'An explicit candle transform is required.');
    if (transform.kind === 'other') text(transform.label, 100);
    const chartSymbol = scope.chart.symbol.replace(/^replay:/, '');
    requireValue(chartSymbol === scope.dataset.symbol || transform.kind === 'heikinashi' && chartSymbol === `${scope.dataset.symbol};heikinashi`, 'Chart symbol does not match the candle dataset.');
    const raw = envelope(snapshot.raw, scope, CANDLE_EVIDENCE_LIMITS.rawBars);
    const displayed = envelope(snapshot.displayed, scope, CANDLE_EVIDENCE_LIMITS.displayedBars);
    time(snapshot.raw.from); time(snapshot.raw.to);
    requireValue(snapshot.raw.from < snapshot.raw.to && snapshot.raw.to <= scope.clock.availableUntil, 'Invalid raw source coverage.');
    requireValue(scope.clock.sourceCutoff < snapshot.raw.from || scope.clock.sourceCutoff >= snapshot.raw.to || raw.at(-1)!.time === scope.clock.sourceCutoff, 'Complete coverage omitted the known source cutoff candle.');
    const period = parseTimeframe(scope.chart.timeframe)!;
    const groups = new Map<number, { aggregate: Bar; sources: Bar[] }>();
    const contract = JSON.stringify([raw[0]!.instrumentId ?? null, raw[0]!.contract ?? null]);
    for (const source of raw) {
        requireValue(source.time % scope.dataset.intervalMs === 0 && source.time >= snapshot.raw.from && source.time + scope.dataset.intervalMs <= snapshot.raw.to, 'Source candle is outside the complete coverage bounds or resolution.');
        requireValue(JSON.stringify([source.instrumentId ?? null, source.contract ?? null]) === contract, 'Candle source window mixes contract identities.');
        const bucket = timeframeBucket(source.time, period); const group = groups.get(bucket);
        if (!group) groups.set(bucket, { aggregate: { ...source, time: bucket }, sources: [source] });
        else {
            group.aggregate.high = Math.max(group.aggregate.high, source.high); group.aggregate.low = Math.min(group.aggregate.low, source.low);
            group.aggregate.close = source.close; group.aggregate.volume += source.volume; group.sources.push(source);
        }
    }
    for (const item of displayed) {
        requireValue(timeframeBucket(item.time, period) === item.time, 'Displayed chart must preserve timeframe candle timestamps.');
        const group = groups.get(item.time);
        requireValue(group && snapshot.raw.from <= item.time && snapshot.raw.to >= Math.min(nextTimeframeBucket(item.time, period), scope.clock.availableUntil), 'Complete source coverage is required for every displayed candle.');
        requireValue(item.instrumentId === group.aggregate.instrumentId && item.contract === group.aggregate.contract, 'Displayed candle has a mixed contract identity.');
        if (transform.kind === 'none') {
            for (const key of ['open', 'high', 'low', 'close', 'volume'] as const) requireValue(item[key] === group.aggregate[key], 'Untransformed displayed candle differs from its revealed source aggregation.');
        }
    }
    const selected = displayed.find(item => item.time === selectedTime);
    requireValue(selected, 'No displayed candle matches the exact selected timestamp.');
    const own = groups.get(selectedTime)!;
    const before = displayed.filter(item => item.time < selectedTime).slice(-priorLimit).map(item => groups.get(item.time)!);
    const previous = before.at(-1);
    const current = own.aggregate;
    const forming = nextTimeframeBucket(selectedTime, period) > scope.clock.availableUntil;
    const evidence: CandleEvidenceRef[] = []; const facts: CandleFact[] = []; const statements: CandleStatement[] = [];
    const provenance = `dataset=${scope.dataset.id}; checksum=${scope.dataset.checksum}; symbol=${scope.dataset.symbol}; schema=${scope.dataset.schema}; sourceIntervalMs=${scope.dataset.intervalMs}; chartTimeframe=${scope.chart.timeframe}; scopeId=${scope.scopeId}; cursorTime=${scope.cursorTime}; sourceCutoff=${scope.clock.sourceCutoff}; availableUntil=${scope.clock.availableUntil}; coverage=[${snapshot.raw.from},${snapshot.raw.to}); transform=${transform.kind}${transform.kind === 'other' ? `:${transform.label}` : ''}`;
    const inputs = (sources: Bar[], series: 'raw' | 'displayed' = 'raw'): CandleEvidenceRef['inputs'] => sources.map(item => ({ series, bar: { ...item } }));
    const add = (id: string, label: string, value: number | null, unit: CandleFact['unit'], formula: string, sources = own.sources, sampleCount = 1): void => {
        evidence.push({ id, formula, provenance: `${provenance}; arithmetic=untransformed source OHLCV, never fills`, inputs: inputs(sources), value, sampleCount });
        facts.push({ id, label, value, unit, evidenceIds: [id] });
    };
    const aggregateFormula = 'Within the UTC timeframe bucket: O=first source.open; H=max(source.high); L=min(source.low); C=last source.close; V=sum(source.volume). Only fully revealed source bars in the attested query coverage are used.';
    for (const key of ['open', 'high', 'low', 'close', 'volume'] as const) add(key, key[0]!.toUpperCase() + key.slice(1), current[key], key === 'volume' ? 'volume' : 'price', `${aggregateFormula} Return ${key}.`);
    add('change', 'Open-to-close change', numeric(current.close - current.open), 'price', `${aggregateFormula} C - O; sign follows the price change.`);
    add('changePercent', 'Open-to-close change (%)', current.open === 0 ? null : numeric(100 * ((current.close - current.open) / Math.abs(current.open))), 'percent', `${aggregateFormula} 100 * (C - O) / abs(O); null if O=0 or arithmetic is nonfinite. The absolute denominator preserves change direction for negative prices.`);
    add('range', 'Range', numeric(current.high - current.low), 'price', `${aggregateFormula} H - L.`);
    add('body', 'Body', numeric(Math.abs(current.close - current.open)), 'price', `${aggregateFormula} abs(C - O).`);
    add('upperWick', 'Upper wick', numeric(current.high - Math.max(current.open, current.close)), 'price', `${aggregateFormula} H - max(O, C).`);
    add('lowerWick', 'Lower wick', numeric(Math.min(current.open, current.close) - current.low), 'price', `${aggregateFormula} min(O, C) - L.`);
    const priorInputs = before.flatMap(group => group.sources);
    const meanRange = before.length ? before.reduce((sum, group) => sum + (group.aggregate.high - group.aggregate.low) / before.length, 0) : null;
    const meanVolume = before.length ? before.reduce((sum, group) => sum + group.aggregate.volume / before.length, 0) : null;
    add('priorRangeMean', 'Prior mean range', meanRange, 'price', `${aggregateFormula} mean(H - L) for the last min(${priorLimit}, available) strictly earlier displayed candle times; null when sampleCount=0.`, priorInputs, before.length);
    add('priorVolumeMean', 'Prior mean volume', meanVolume, 'volume', `${aggregateFormula} mean(V) for the last min(${priorLimit}, available) strictly earlier displayed candle times; null when sampleCount=0.`, priorInputs, before.length);
    add('rangeRatio', 'Range / prior mean', meanRange === null || meanRange === 0 ? null : numeric((current.high - current.low) / meanRange), 'ratio', `${aggregateFormula} selected range / prior mean range; null with no prior sample or zero denominator.`, [...priorInputs, ...own.sources], before.length);
    add('volumeRatio', 'Volume / prior mean', meanVolume === null || meanVolume === 0 ? null : numeric(current.volume / meanVolume), 'ratio', `${aggregateFormula} selected V / prior mean V; null with no prior sample or zero denominator.`, [...priorInputs, ...own.sources], before.length);
    add('previousCloseChange', 'Change from prior close', previous ? numeric(current.close - previous.aggregate.close) : null, 'price', `${aggregateFormula} selected C - immediately preceding supplied candle C; null without a prior sample.`, [...(previous?.sources ?? []), ...own.sources], previous ? 1 : 0);
    const ref = (id: string) => facts.find(item => item.id === id)!;
    const shown = (id: string) => ref(id).value === null ? 'unavailable' : rounded(ref(id).value!);
    statements.push(
        { id: 'ohlcv', text: `Raw candle: Open ${shown('open')}, high ${shown('high')}, low ${shown('low')}, close ${shown('close')}, volume ${shown('volume')}.`, evidenceIds: ['open', 'high', 'low', 'close', 'volume'] },
        { id: 'movement', text: `Open-to-close change ${shown('change')} (${shown('changePercent')}%); range ${shown('range')}, body ${shown('body')}, upper wick ${shown('upperWick')}, lower wick ${shown('lowerWick')}.`, evidenceIds: ['change', 'changePercent', 'range', 'body', 'upperWick', 'lowerWick'] },
        { id: 'comparison', text: `Within ${before.length} strictly earlier supplied candles: mean range ${shown('priorRangeMean')}, mean volume ${shown('priorVolumeMean')}. This candle is ${shown('rangeRatio')} times that range and ${shown('volumeRatio')} times that volume. Comparisons describe this bounded sample only.`, evidenceIds: ['priorRangeMean', 'priorVolumeMean', 'rangeRatio', 'volumeRatio'] },
        { id: 'clock', text: `Candle opened ${new Date(selectedTime).toISOString()}; ${forming ? 'forming at the pinned replay cutoff; its final OHLCV is unavailable' : 'its timeframe boundary has passed at the pinned replay cutoff'}. Observations end ${new Date(scope.clock.availableUntil).toISOString()}. Empty source intervals are permitted; wall-clock completion does not prove feed completeness.`, evidenceIds: ['close'] },
    );
    if (transform.kind !== 'none') {
        const id = 'displayed';
        evidence.push({ id, formula: 'Actual displayed OHLCV supplied by the chart host; transform state/seed is owned by the chart. No inverse transform or execution price is inferred.', provenance, inputs: inputs([selected], 'displayed'), value: null, sampleCount: 1 });
        statements.push({ id, text: `${transform.kind === 'heikinashi' ? 'Heikin Ashi' : transform.label} displayed values: Open ${rounded(selected.open)}, high ${rounded(selected.high)}, low ${rounded(selected.low)}, close ${rounded(selected.close)}, volume ${rounded(selected.volume)}. These are transformed chart values, not raw execution prices. All arithmetic and prior comparisons above use untransformed source bars.`, evidenceIds: [id, 'open', 'close'] });
    }
    const reason = 'Causes unavailable: price and volume bars do not establish news, participants, order types or why a move happened. No causal explanation or probability is inferred.';
    statements.push({ id: 'causes', text: reason, evidenceIds: ['open', 'close', 'volume'] });
    const result: CandleEvidence = {
        version: 1, scope, selectedTime, transform: transform.kind === 'other' ? { kind: 'other', label: transform.label } : { kind: transform.kind },
        raw: { ...current }, displayed: { ...selected }, forming,
        coverage: { rawBars: raw.length, displayedBars: displayed.length, priorBars: before.length, from: snapshot.raw.from, to: snapshot.raw.to },
        facts, statements, evidence, causes: { status: 'unavailable', reason, evidenceIds: ['open', 'close', 'volume'] },
    };
    requireValue(byteLength(result) <= CANDLE_EVIDENCE_LIMITS.responseBytes, 'Candle evidence exceeds 256 KiB. Select a smaller covered window or timeframe.');
    snapshot.assertCurrent();
    return result;
}
