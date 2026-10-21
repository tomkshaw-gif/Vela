/** Local user hypotheses. Times are UTC milliseconds, never execution instructions. */
export interface ScenarioContext {
    sessionId: string; datasetId: string; datasetChecksum: string; cursor: number; cutoff: number;
}
export interface ScenarioEvidence { kind: 'candle'; sourceIndex: number; time: number; note: string }
export interface ScenarioCase {
    thesis: string; trigger: string; invalidation: string;
    triggerPrice: number | null; invalidationPrice: number | null; targetPrice: number | null; projectedTime: number | null;
}
export interface ScenarioContent { title: string; bull: ScenarioCase; bear: ScenarioCase; notes: string; evidence: ScenarioEvidence[] }
export interface SaveScenarioInput { id?: string; expectedRevision?: number; context: ScenarioContext; content: ScenarioContent }
export interface ScenarioSummary {
    id: string; title: string; revision: number; createdAt: string; updatedAt: string; archived: boolean; context: ScenarioContext;
}
export interface ScenarioDocument extends ScenarioSummary { content: ScenarioContent }
export interface ScenarioAnnotation {
    case: 'bull' | 'bear'; kind: 'trigger' | 'invalidation' | 'target'; price: number; time: number | null; label: string;
}
export const SCENARIO_LIMITS = Object.freeze({ records: 250, bytes: 65_536, storedBytes: 8 * 1024 * 1024, evidence: 32, drafts: 40 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TIME = 8_640_000_000_000_000;

export function scenarioId(value: unknown): string {
    if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid scenario identifier.');
    return value;
}
/** Inspect descriptors before values: even trusted-side callers may pass accessor objects. */
export function scenarioObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Expected plain scenario JSON.');
    const own = Reflect.ownKeys(value);
    if (own.length > keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key)
        || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw new Error('Invalid scenario fields.');
    return value as Record<string, unknown>;
}
function string(value: unknown, limit: number, required = false): string {
    if (typeof value !== 'string' || value.length > limit || required && !value.trim()
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
        || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) throw new Error('Invalid scenario text.');
    return value;
}
export function scenarioInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('Invalid scenario number.');
    return value;
}
export function parseScenarioContext(value: unknown): ScenarioContext {
    const v = scenarioObject(value, ['sessionId', 'datasetId', 'datasetChecksum', 'cursor', 'cutoff']);
    if (typeof v.datasetChecksum !== 'string' || !/^[0-9a-f]{64}$/i.test(v.datasetChecksum)) throw new Error('Invalid dataset checksum.');
    return { sessionId: scenarioId(v.sessionId), datasetId: scenarioId(v.datasetId), datasetChecksum: v.datasetChecksum,
        cursor: scenarioInteger(v.cursor), cutoff: scenarioInteger(v.cutoff, MAX_TIME) };
}
function price(value: unknown): number | null {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12) throw new Error('Invalid scenario price.');
    return value;
}
function parseCase(value: unknown): ScenarioCase {
    const v = scenarioObject(value, ['thesis', 'trigger', 'invalidation', 'triggerPrice', 'invalidationPrice', 'targetPrice', 'projectedTime']);
    return { thesis: string(v.thesis, 4000), trigger: string(v.trigger, 2000), invalidation: string(v.invalidation, 2000),
        triggerPrice: price(v.triggerPrice), invalidationPrice: price(v.invalidationPrice), targetPrice: price(v.targetPrice),
        projectedTime: v.projectedTime === null ? null : scenarioInteger(v.projectedTime, MAX_TIME) };
}
export function parseScenarioContent(value: unknown): ScenarioContent {
    const v = scenarioObject(value, ['title', 'bull', 'bear', 'notes', 'evidence']);
    const refs = v.evidence;
    if (!Array.isArray(refs) || Object.getPrototypeOf(refs) !== Array.prototype || refs.length > SCENARIO_LIMITS.evidence
        || Reflect.ownKeys(refs).length !== refs.length + 1) throw new Error('Invalid scenario evidence list.');
    const evidence: ScenarioEvidence[] = [];
    for (let i = 0; i < refs.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(refs, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('Invalid scenario evidence list.');
        const ref = scenarioObject(descriptor.value, ['kind', 'sourceIndex', 'time', 'note']);
        if (ref.kind !== 'candle') throw new Error('Invalid scenario evidence kind.');
        evidence.push({ kind: 'candle', sourceIndex: scenarioInteger(ref.sourceIndex), time: scenarioInteger(ref.time, MAX_TIME), note: string(ref.note, 1000) });
    }
    const content = { title: string(v.title, 120, true), bull: parseCase(v.bull), bear: parseCase(v.bear), notes: string(v.notes, 8000), evidence };
    if (new TextEncoder().encode(JSON.stringify(content)).length > SCENARIO_LIMITS.bytes) throw new Error('Scenario exceeds the size limit.');
    return content;
}
export function parseSaveScenario(value: unknown): SaveScenarioInput {
    const v = scenarioObject(value, ['id', 'expectedRevision', 'context', 'content']);
    if (Object.hasOwn(v, 'id') !== Object.hasOwn(v, 'expectedRevision')) throw new Error('Updates require an identifier and exact revision.');
    return { ...(Object.hasOwn(v, 'id') ? { id: scenarioId(v.id), expectedRevision: scenarioInteger(v.expectedRevision) } : {}),
        context: parseScenarioContext(v.context), content: parseScenarioContent(v.content) };
}
export function emptyScenarioContent(): ScenarioContent {
    const empty = (): ScenarioCase => ({ thesis: '', trigger: '', invalidation: '', triggerPrice: null, invalidationPrice: null, targetPrice: null, projectedTime: null });
    return { title: 'Untitled scenario', bull: empty(), bear: empty(), notes: '', evidence: [] };
}
export function scenarioAnnotations(value: ScenarioContent): ScenarioAnnotation[] {
    const content = parseScenarioContent(value);
    return (['bull', 'bear'] as const).flatMap(side => (['trigger', 'invalidation', 'target'] as const).flatMap(kind => {
        const price = content[side][`${kind}Price`];
        return price === null ? [] : [{ case: side, kind, price, time: content[side].projectedTime, label: `${side === 'bull' ? 'Bull' : 'Bear'} hypothesis: ${kind}` }];
    }));
}
