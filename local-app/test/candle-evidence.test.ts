import { describe, expect, it, vi } from 'vitest';
import { buildCandleEvidence, CANDLE_EVIDENCE_LIMITS, type CandleEvidenceSnapshot } from '../shared/candle-evidence';
import type { AnalysisScopeSummary } from '../shared/chart-analysis';
import type { Bar } from '../shared/types';

const NOW = 1_000_000;
function fixture(): CandleEvidenceSnapshot {
    const dataset = { id: 'cached', checksum: 'checksum', symbol: 'TEST', schema: 'ohlcv-1m' as const, intervalMs: 60_000 };
    const bars: Bar[] = [
        { time: 0, open: -10, high: -6, low: -12, close: -8, volume: 0 },
        { time: 60_000, open: -8, high: -4, low: -9, close: -5, volume: 10 },
        { time: 120_000, open: -5, high: 2, low: -7, close: 1, volume: 20 },
    ];
    const scope: AnalysisScopeSummary = {
        scopeId: 'scope', target: { clientId: 'client', sessionId: 'session', generation: 1, cellId: 'cell' },
        createdAt: NOW - 10, expiresAt: NOW + 299_990, cursorTime: 120_000,
        region: { from: 0, to: 120_000, requestedFrom: 0, requestedTo: 120_000, clamped: false, origin: 'range' },
        clock: { sourceCutoff: 120_000, availableUntil: 180_000, sourceIntervalMs: 60_000, label: 'Source-open clock' },
        chart: { symbol: 'TEST', timeframe: '1', intervalMs: 60_000 }, dataset,
    };
    const envelope = { dataset: { ...dataset }, cursorTime: 120_000, sourceCutoff: 120_000, bars };
    return { scope, selectedTime: 120_000, raw: { ...envelope, from: 0, to: 180_000 }, displayed: { ...envelope, bars: bars.map(bar => ({ ...bar })) }, transform: { kind: 'none' }, assertCurrent: vi.fn() };
}
const build = (snapshot = fixture()) => buildCandleEvidence(snapshot, { now: NOW });
const fact = (report: ReturnType<typeof build>, id: string) => report.facts.find(item => item.id === id)!;

describe('bounded candle evidence', () => {
    it('preserves the actual replay provider symbol while verifying its exact dataset identity', () => {
        const input = fixture(); input.scope.chart.symbol = 'replay:TEST';
        const result = build(input);
        expect(result.scope.chart.symbol).toBe('replay:TEST'); expect(result.scope.dataset.symbol).toBe('TEST');
        for (const symbol of ['replay:OTHER', 'other:TEST', 'replay:replay:TEST']) {
            input.scope.chart.symbol = symbol; expect(() => build(input)).toThrow('symbol');
        }
    });
    it('explains the exact selected candle with signed arithmetic and auditable actual source values', () => {
        const input = fixture(); const result = build(input);
        expect(result.raw.time).toBe(120_000);
        expect(fact(result, 'change').value).toBe(6);
        expect(fact(result, 'changePercent').value).toBe(120);
        expect(fact(result, 'range').value).toBe(9);
        expect(fact(result, 'body').value).toBe(6);
        expect(fact(result, 'upperWick').value).toBe(1);
        expect(fact(result, 'lowerWick').value).toBe(2);
        expect(fact(result, 'priorRangeMean').value).toBe(5.5);
        expect(fact(result, 'priorVolumeMean').value).toBe(5);
        expect(fact(result, 'volumeRatio').value).toBe(4);
        for (const statement of result.statements) {
            expect(statement.evidenceIds.length).toBeGreaterThan(0);
            for (const id of statement.evidenceIds) {
                const evidence = result.evidence.find(item => item.id === id)!;
                expect(evidence.formula).toBeTruthy(); expect(evidence.provenance).toBeTruthy();
                expect(evidence.inputs.length).toBeGreaterThan(0);
                expect(evidence.inputs.every(item => item.bar.time <= input.selectedTime)).toBe(true);
            }
        }
        expect(result.causes.status).toBe('unavailable');
        expect(JSON.stringify(result)).not.toMatch(/buying pressure|selling pressure|likely|bullish|bearish|market orders/i);
        expect(input.assertCurrent).toHaveBeenCalled();
        expect(build(input)).toEqual(result);
    });
    it('keeps timestamp zero, negative prices, zero volume and insufficient samples without inventing estimates', () => {
        const input = fixture(); input.selectedTime = 0; const result = build(input);
        expect(result.raw.time).toBe(0); expect(fact(result, 'volume').value).toBe(0);
        expect(fact(result, 'changePercent').value).toBe(20);
        expect(fact(result, 'priorRangeMean').value).toBeNull();
        expect(fact(result, 'volumeRatio').value).toBeNull();
        expect(result.evidence.find(item => item.id === 'priorRangeMean')!.sampleCount).toBe(0);
        input.raw.bars = [{ ...input.raw.bars[0]!, open: 0, close: 0, high: 0, low: 0, volume: 0 }];
        input.raw.to = 60_000;
        input.displayed.bars = [...input.raw.bars];
        expect(fact(build(input), 'changePercent').value).toBeNull();
    });
    it('compares only strictly earlier candles in a bounded sample, with independent counts', () => {
        const input = fixture(); input.priorLimit = 1; const result = build(input);
        expect(fact(result, 'priorVolumeMean').value).toBe(10);
        expect(result.evidence.find(item => item.id === 'priorVolumeMean')!.sampleCount).toBe(1);
        expect(result.evidence.find(item => item.id === 'priorRangeMean')!.inputs.map(item => item.bar.time)).toEqual([60_000]);
    });
    it('builds a forming higher-timeframe raw candle from revealed source bars and distinguishes transformed prices', () => {
        const input = fixture(); input.scope.chart = { symbol: 'TEST', timeframe: '5', intervalMs: 300_000 }; input.selectedTime = 0;
        input.displayed.bars = [{ time: 0, open: -10, high: 2, low: -12, close: 1, volume: 30 }];
        const result = build(input); expect(result.forming).toBe(true); expect(result.raw.close).toBe(1);
        expect(result.evidence.find(item => item.id === 'close')!.inputs.map(item => item.bar.time)).toEqual([0, 60_000, 120_000]);
        input.transform = { kind: 'heikinashi' }; input.displayed.bars = [{ time: 0, open: -9, high: 2, low: -12, close: -4.75, volume: 30 }];
        const transformed = build(input); expect(transformed.displayed.close).toBe(-4.75); expect(transformed.raw.close).toBe(1);
        expect(transformed.statements.map(item => item.text).join(' ')).toContain('not raw execution prices');
        expect(transformed.statements.map(item => item.text).join(' ')).toContain('forming');
    });
    it.each([
        ['expired scope', (s: CandleEvidenceSnapshot) => { s.scope.expiresAt = NOW; }],
        ['future scope', (s: CandleEvidenceSnapshot) => { s.scope.createdAt = NOW + 1; }],
        ['future selection', (s: CandleEvidenceSnapshot) => { s.selectedTime = 180_000; }],
        ['missing exact selection', (s: CandleEvidenceSnapshot) => { s.selectedTime = 1; }],
        ['future raw', (s: CandleEvidenceSnapshot) => { s.raw.bars = [...s.raw.bars, { ...s.raw.bars[0]!, time: 180_000 }]; }],
        ['future displayed', (s: CandleEvidenceSnapshot) => { s.displayed.bars = [...s.displayed.bars, { ...s.displayed.bars[0]!, time: 180_000 }]; }],
        ['mixed dataset', (s: CandleEvidenceSnapshot) => { s.raw.dataset = { ...s.raw.dataset, checksum: 'other' }; }],
        ['mixed display identity', (s: CandleEvidenceSnapshot) => { s.displayed.dataset = { ...s.displayed.dataset, id: 'other' }; }],
        ['stale envelope', (s: CandleEvidenceSnapshot) => { s.displayed.cursorTime = 0; }],
        ['stale cutoff', (s: CandleEvidenceSnapshot) => { s.raw.sourceCutoff = 0; }],
        ['malformed ohlc', (s: CandleEvidenceSnapshot) => { s.raw.bars = [{ ...s.raw.bars[0]!, high: -100 }]; }],
        ['nan', (s: CandleEvidenceSnapshot) => { s.displayed.bars = [{ ...s.displayed.bars[0]!, close: NaN }]; }],
        ['negative volume', (s: CandleEvidenceSnapshot) => { s.raw.bars = [{ ...s.raw.bars[0]!, volume: -1 }]; }],
        ['duplicates', (s: CandleEvidenceSnapshot) => { s.raw.bars = [s.raw.bars[0]!, s.raw.bars[0]!]; }],
        ['unsorted', (s: CandleEvidenceSnapshot) => { s.displayed.bars = [...s.displayed.bars].reverse(); }],
        ['incomplete bucket coverage', (s: CandleEvidenceSnapshot) => { s.raw.from = 120_001; }],
        ['forged untransformed display', (s: CandleEvidenceSnapshot) => { s.displayed.bars = s.displayed.bars.map(b => ({ ...b, high: b.high + 1 })); }],
        ['too many bars', (s: CandleEvidenceSnapshot) => { s.raw.bars = Array(CANDLE_EVIDENCE_LIMITS.rawBars + 1).fill(s.raw.bars[0]); }],
        ['too many comparisons', (s: CandleEvidenceSnapshot) => { s.priorLimit = CANDLE_EVIDENCE_LIMITS.priorBars + 1; }],
    ])('rejects %s', (_name, mutate) => { const input = fixture(); mutate(input); expect(() => build(input)).toThrow(); });
    it('rejects stale ownership and returns isolated JSON instead of mutable input aliases', () => {
        const input = fixture(); input.assertCurrent = () => { throw new Error('Chart changed'); };
        expect(() => build(input)).toThrow('Chart changed');
        const fresh = fixture(); const result = build(fresh); fresh.scope.dataset.checksum = 'changed';
        expect(result.scope.dataset.checksum).toBe('checksum'); expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    });
    it('rejects a cursor or source cutoff that cannot be a source candle open', () => {
        const cursor = fixture(); cursor.scope.cursorTime += 1; cursor.raw.cursorTime += 1; cursor.displayed.cursorTime += 1;
        expect(() => build(cursor)).toThrow(/clock|cursor|source/i);
        const cutoff = fixture(); cutoff.scope.cursorTime += 1; cutoff.raw.cursorTime += 1; cutoff.displayed.cursorTime += 1;
        cutoff.scope.clock.sourceCutoff += 1; cutoff.scope.clock.availableUntil += 1;
        cutoff.raw.sourceCutoff += 1; cutoff.displayed.sourceCutoff += 1;
        cutoff.scope.region.to += 1; cutoff.scope.region.requestedTo += 1;
        expect(() => build(cutoff)).toThrow(/clock|cursor|source/i);
    });
    it('uses null ratios for zero prior range/volume while retaining each independent sample count', () => {
        const input = fixture(); input.raw.bars = input.raw.bars.map((b, index) => index < 2 ? { ...b, open: 1, high: 1, low: 1, close: 1, volume: 0 } : b);
        input.displayed.bars = [...input.raw.bars]; const result = build(input);
        expect(fact(result, 'rangeRatio').value).toBeNull(); expect(fact(result, 'volumeRatio').value).toBeNull();
        expect(result.evidence.find(item => item.id === 'priorRangeMean')!.sampleCount).toBe(2);
        expect(result.evidence.find(item => item.id === 'priorVolumeMean')!.sampleCount).toBe(2);
    });
    it('handles calendar boundaries and gaps without extending the pinned forming candle into future history', () => {
        const input = fixture(); const start = Date.UTC(2024, 1, 1); const cutoff = Date.UTC(2024, 1, 29, 23, 59);
        input.scope.cursorTime = cutoff; input.scope.clock = { ...input.scope.clock, sourceCutoff: cutoff, availableUntil: cutoff + 60_000 };
        input.scope.region = { ...input.scope.region, from: start, to: cutoff, requestedFrom: start, requestedTo: cutoff };
        input.scope.chart = { ...input.scope.chart, timeframe: 'M', intervalMs: null }; input.selectedTime = start;
        const bars = [{ time: start, open: 10, high: 11, low: 9, close: 10, volume: 1 }, { time: cutoff, open: 10, high: 12, low: 10, close: 12, volume: 2 }];
        input.raw = { ...input.raw, from: start, to: cutoff + 60_000, sourceCutoff: cutoff, cursorTime: cutoff, bars };
        input.displayed = { ...input.displayed, sourceCutoff: cutoff, cursorTime: cutoff, bars: [{ time: start, open: 10, high: 12, low: 9, close: 12, volume: 3 }] };
        expect(build(input).forming).toBe(false);
        input.scope.clock.availableUntil = cutoff; input.scope.clock.sourceCutoff -= 60_000; input.raw.sourceCutoff -= 60_000; input.displayed.sourceCutoff -= 60_000;
        input.raw.to = cutoff; input.raw.bars = [bars[0]!, { ...bars[0]!, time: cutoff - 60_000 }]; input.displayed.bars = [{ ...bars[0]!, time: start, volume: 2 }];
        expect(build(input).forming).toBe(true);
    });
    it('rejects mixed contract identity, incomplete query coverage and oversized audited responses', () => {
        const mixed = fixture(); mixed.raw.bars = mixed.raw.bars.map((b, index) => ({ ...b, instrumentId: `instrument-${index}`, contract: 'TEST' }));
        expect(() => build(mixed)).toThrow(/contract/i);
        const missing = fixture(); missing.raw.to = 120_000;
        expect(() => build(missing)).toThrow(/coverage/i);
        const large = fixture(); const cutoff = 999 * 60_000;
        large.scope.cursorTime = cutoff; large.scope.clock.sourceCutoff = cutoff; large.scope.clock.availableUntil = cutoff + 60_000;
        large.scope.region = { ...large.scope.region, to: cutoff, requestedTo: cutoff }; large.scope.chart = { ...large.scope.chart, timeframe: 'D', intervalMs: 86_400_000 };
        large.raw = { ...large.raw, from: 0, to: cutoff + 60_000, sourceCutoff: cutoff, cursorTime: cutoff,
            bars: Array.from({ length: 1000 }, (_, index) => ({ time: index * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 })) };
        large.displayed = { ...large.displayed, sourceCutoff: cutoff, cursorTime: cutoff, bars: [{ time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1000 }] }; large.selectedTime = 0;
        expect(() => build(large)).toThrow(/256 KiB/i);
    });
    it('rejects a claimed complete window that omits the known source cutoff candle', () => {
        const input = fixture(); input.raw.bars = input.raw.bars.slice(0, 2); input.displayed.bars = input.displayed.bars.slice(0, 2); input.selectedTime = 60_000;
        expect(() => build(input)).toThrow(/cutoff|coverage/i);
    });
});
