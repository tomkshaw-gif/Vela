import { randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors';
import { CHART_AGENT_OPERATIONS } from '../shared/chart-agent';
import { parseScenarioContent, parseScenarioContext, type ScenarioContext, type ScenarioEvidence } from '../shared/scenarios';
import type {
    ChartAgentCall, ChartAgentClient, ChartAgentCompletion, ChartAgentExchangeInput,
    ChartAgentExchangeResult, ChartAgentOperation, ChartAgentOutcome, ChartAgentTarget, ChartAgentTask,
} from '../shared/chart-agent';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const LEASE_MS = 8000;
const DEADLINE_MS = 10_000;
const MAX_CLIENTS = 16;
const MAX_PENDING = 8;
const MAX_RECEIPTS = 64;
const RECEIPT_MS = 5 * 60_000;
const ARGUMENT_BYTES = 64 * 1024;
const RESULT_BYTES = 256 * 1024;
const SCREENSHOT_BYTES = 1536 * 1024;
const PRIVATE_KEY = /^(?:__proto__|constructor|prototype|api[_-]?key|authorization|cookie|password|secret|token|credentials?)$/i;

function invalid(): never { throw new AppError(400, 'Invalid chart assistant request.', 'INVALID_CHART_ASSISTANT_REQUEST'); }
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], required: string[] = allowed): void {
    if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid();
}
function uuid(value: unknown): string {
    if (typeof value !== 'string' || !UUID.test(value)) return invalid();
    return value;
}
function label(value: unknown, maximum = 128): string {
    if (typeof value !== 'string' || !value.length || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
    return value;
}
function generation(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
    return value as number;
}

/** Copy only bounded JSON data; browser tools cannot return executable or private objects. */
function json(value: unknown, maximum: number): unknown {
    let count = 0;
    const ancestors = new Set<object>();
    function inspect(current: unknown, depth: number): void {
        if (++count > 20_000 || depth > 12) invalid();
        if (current === null || typeof current === 'boolean' || typeof current === 'string') return;
        if (typeof current === 'number') { if (!Number.isFinite(current)) invalid(); return; }
        if (typeof current !== 'object') return invalid();
        if (ancestors.has(current)) return invalid();
        ancestors.add(current);
        if (Array.isArray(current)) {
            if (current.length > 10_000) invalid();
            for (const item of current) inspect(item, depth + 1);
        } else {
            const record = object(current);
            const entries = Object.entries(Object.getOwnPropertyDescriptors(record));
            if (entries.length > 128) invalid();
            for (const [key, descriptor] of entries) {
                if (key.length > 128 || PRIVATE_KEY.test(key) || !('value' in descriptor) || !descriptor.enumerable) invalid();
                inspect(descriptor.value, depth + 1);
            }
        }
        ancestors.delete(current);
    }
    inspect(value, 0);
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, 'utf8') > maximum) invalid();
    return JSON.parse(encoded) as unknown;
}

function target(value: unknown): ChartAgentTarget {
    const input = object(value); keys(input, ['clientId', 'sessionId', 'generation', 'cellId'], ['clientId', 'sessionId', 'generation']);
    return {
        clientId: uuid(input.clientId), sessionId: uuid(input.sessionId), generation: generation(input.generation),
        ...(input.cellId === undefined ? {} : { cellId: label(input.cellId) }),
    };
}
function call(value: unknown): ChartAgentCall {
    const input = object(value); keys(input, ['operation', 'target', 'args', 'requestId'], ['operation', 'target', 'args']);
    if (typeof input.operation !== 'string' || !CHART_AGENT_OPERATIONS.includes(input.operation as ChartAgentOperation)) invalid();
    const destination = target(input.target);
    if (input.operation !== 'list_drawing_tools' && input.operation !== 'read_operation' && destination.cellId === undefined) invalid();
    object(input.args);
    return { operation: input.operation as ChartAgentOperation, target: destination, args: json(input.args, ARGUMENT_BYTES) as Record<string, unknown>,
        ...(input.requestId === undefined ? {} : { requestId: uuid(input.requestId).toLowerCase() }) };
}
function chart(value: unknown): Omit<ChartAgentClient, 'clientId'> {
    const input = object(value); keys(input, ['sessionId', 'generation', 'symbol', 'timeframe', 'cells', 'cursorTime']);
    if (!Array.isArray(input.cells) || !input.cells.length || input.cells.length > 16) invalid();
    const cells = input.cells.map(value => {
        const cell = object(value); keys(cell, ['id', 'timeframe']);
        return { id: label(cell.id), timeframe: label(cell.timeframe, 32) };
    });
    if (new Set(cells.map(cell => cell.id)).size !== cells.length) invalid();
    if (input.cursorTime !== null && (!Number.isSafeInteger(input.cursorTime) || (input.cursorTime as number) < 0)) invalid();
    return {
        sessionId: uuid(input.sessionId), generation: generation(input.generation), symbol: label(input.symbol),
        timeframe: label(input.timeframe, 32), cells, cursorTime: input.cursorTime as number | null,
    };
}
function completion(value: unknown): ChartAgentCompletion {
    const input = object(value);
    if (input.success === true) {
        keys(input, ['requestId', 'success', 'value']);
        return { requestId: uuid(input.requestId).toLowerCase(), success: true, value: input.value };
    }
    if (input.success === false) {
        keys(input, ['requestId', 'success', 'error']);
        return { requestId: uuid(input.requestId).toLowerCase(), success: false, error: label(input.error, 2000) };
    }
    return invalid();
}
function exchange(value: unknown): ChartAgentExchangeInput {
    const input = object(value);
    if (input.action === 'release') {
        keys(input, ['action', 'clientId', 'clientToken']);
        return { action: 'release', clientId: uuid(input.clientId), clientToken: uuid(input.clientToken) };
    }
    if (input.action === 'heartbeat') {
        keys(input, ['action', 'clientId', 'clientToken', 'chart', 'requestId'], ['action', 'clientId', 'clientToken', 'chart']);
        return { action: 'heartbeat', clientId: uuid(input.clientId), clientToken: uuid(input.clientToken), chart: chart(input.chart),
            ...(input.requestId === undefined ? {} : { requestId: uuid(input.requestId).toLowerCase() }) };
    }
    if (input.action === 'validate_proposal' || input.action === 'commit_proposal') {
        keys(input, ['action', 'clientId', 'clientToken', 'chart', 'requestId', 'context', 'revision']);
        let context: ScenarioContext;
        try { context = parseScenarioContext(input.context); } catch { return invalid(); }
        return { action: input.action, clientId: uuid(input.clientId), clientToken: uuid(input.clientToken), chart: chart(input.chart),
            requestId: uuid(input.requestId).toLowerCase(), context, revision: generation(input.revision) };
    }
    if (input.action !== 'poll') invalid();
    keys(input, ['action', 'clientId', 'clientToken', 'chart', 'completion'], ['action', 'clientId', 'clientToken', 'chart']);
    return {
        action: 'poll', clientId: uuid(input.clientId), clientToken: uuid(input.clientToken), chart: chart(input.chart),
        ...(input.completion === undefined ? {} : { completion: completion(input.completion) }),
    };
}

interface ClientLease { chart: ChartAgentClient; token: string; expiresAt: number }
interface Pending {
    task: ChartAgentTask;
    delivered: boolean;
    resolve(value: unknown): void;
    reject(reason: AppError): void;
}
interface Receipt {
    outcome: ChartAgentOutcome;
    token?: string;
    acceptsCompletion: boolean;
    proposal?: { context: ScenarioContext; revision: number; granted: boolean };
}

export type ValidateChartProposal = (input: { task: ChartAgentTask; context: ScenarioContext; revision: number; evidence: ScenarioEvidence[] }) => void;

function sameTarget(one: ChartAgentTarget, two: ChartAgentTarget): boolean {
    return one.clientId === two.clientId && one.sessionId === two.sessionId && one.generation === two.generation && one.cellId === two.cellId;
}
function sameChart(one: ChartAgentClient, clientId: string, two: Omit<ChartAgentClient, 'clientId'>): boolean {
    return one.clientId === clientId && one.sessionId === two.sessionId && one.generation === two.generation
        && one.symbol === two.symbol && one.timeframe === two.timeframe && one.cursorTime === two.cursorTime
        && one.cells.length === two.cells.length && one.cells.every((cell, index) => cell.id === two.cells[index]!.id && cell.timeframe === two.cells[index]!.timeframe);
}

/** Memory-only, single-delivery handoff to a specifically identified chart window. */
export class ChartAgentBroker {
    private readonly clients = new Map<string, ClientLease>();
    private readonly pending = new Map<string, Pending>();
    private readonly receipts = new Map<string, Receipt>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private closed = false;

    constructor(private readonly now: () => number = Date.now) {}

    list(): ChartAgentClient[] {
        this.prune();
        return [...this.clients.values()].map(lease => structuredClone(lease.chart));
    }

    exchange(value: unknown, validateProposal?: ValidateChartProposal): ChartAgentExchangeResult {
        this.ensureOpen();
        const input = exchange(value);
        this.prune();
        const existing = this.clients.get(input.clientId);
        if (existing && !timingSafeEqual(Buffer.from(existing.token), Buffer.from(input.clientToken))) throw new AppError(403, 'The chart window token does not match.', 'CHART_CLIENT_TOKEN');
        if (input.action === 'heartbeat') {
            if (!existing) throw new AppError(409, 'The chart window is not registered.', 'CHART_CLIENT_NOT_REGISTERED');
            if (!sameChart(existing.chart, input.clientId, input.chart)) throw new AppError(409, 'The chart heartbeat registration is no longer current.', 'CHART_TARGET_CHANGED');
            existing.expiresAt = this.now() + LEASE_MS;
            this.schedule();
            const pending = input.requestId === undefined ? undefined : this.pending.get(input.requestId);
            return { request: null, ...(input.requestId === undefined ? {} : { operation: { requestId: input.requestId,
                active: !!pending && pending.delivered && pending.task.target.clientId === input.clientId } }) };
        }
        if (input.action === 'validate_proposal' || input.action === 'commit_proposal') {
            const pending = this.pending.get(input.requestId), receipt = this.receipts.get(input.requestId);
            if (!existing || !sameChart(existing.chart, input.clientId, input.chart) || !pending?.delivered || pending.task.operation !== 'propose_scenario'
                || pending.task.target.clientId !== input.clientId || !receipt || receipt.proposal?.granted || !validateProposal) {
                throw new AppError(409, 'The scenario proposal no longer has commit authority.', 'CHART_PROPOSAL_CANCELLED');
            }
            this.assertTarget(pending.task.target, existing.chart);
            if (input.context.sessionId !== input.chart.sessionId || input.context.cutoff !== input.chart.cursorTime) throw new AppError(409, 'The scenario proposal context changed.', 'CHART_PROPOSAL_CONTEXT');
            const pin = { context: input.context, revision: input.revision, granted: false };
            if (receipt.proposal && (receipt.proposal.revision !== input.revision || JSON.stringify(receipt.proposal.context) !== JSON.stringify(input.context))) throw new AppError(409, 'The scenario proposal context changed.', 'CHART_PROPOSAL_CONTEXT');
            if (input.action === 'commit_proposal' && !receipt.proposal) throw new AppError(409, 'Validate the scenario proposal before committing its draft.', 'CHART_PROPOSAL_NOT_VALIDATED');
            let content;
            try { content = parseScenarioContent(pending.task.args.content); } catch { return invalid(); }
            validateProposal({ task: structuredClone(pending.task), context: { ...input.context }, revision: input.revision, evidence: content.evidence });
            receipt.proposal = pin;
            // The synchronous authority grant is the commit boundary; later cancellation cannot promise rollback.
            if (input.action === 'commit_proposal') receipt.proposal.granted = true;
            return { request: null, proposal: { requestId: input.requestId, authorized: true } };
        }
        if (input.action === 'release') {
            this.removeClient(input.clientId, new AppError(409, 'The chart window disconnected.', 'CHART_CLIENT_DISCONNECTED'));
            this.schedule();
            return { request: null };
        }
        if (input.action !== 'poll') return invalid();
        if (!existing && input.completion) {
            const receipt = this.receipts.get(input.completion.requestId);
            if (!receipt?.acceptsCompletion || receipt.outcome.dispatchedAt === undefined || receipt.outcome.target.clientId !== input.clientId) throw new AppError(409, 'Register the chart window before completing a request.', 'CHART_CLIENT_NOT_REGISTERED');
            if (!receipt.token || !timingSafeEqual(Buffer.from(receipt.token), Buffer.from(input.clientToken))) throw new AppError(403, 'The chart window token does not match.', 'CHART_CLIENT_TOKEN');
            this.assertTarget(receipt.outcome.target, { clientId: input.clientId, ...input.chart });
        }
        if (!existing && this.clients.size >= MAX_CLIENTS) throw new AppError(429, 'Too many active chart windows.', 'CHART_CLIENT_LIMIT');
        if (existing && (input.chart.generation < existing.chart.generation || (input.chart.generation === existing.chart.generation && input.chart.sessionId !== existing.chart.sessionId))) throw new AppError(409, 'The chart registration is no longer current.', 'CHART_TARGET_CHANGED');
        const registered: ChartAgentClient = { clientId: input.clientId, ...input.chart };
        const changed = existing && (existing.chart.generation !== input.chart.generation || existing.chart.sessionId !== input.chart.sessionId);
        this.clients.set(input.clientId, { chart: registered, token: input.clientToken, expiresAt: this.now() + LEASE_MS });
        if (changed) this.rejectClient(input.clientId, new AppError(409, 'The chart session changed before the request completed.', 'CHART_TARGET_CHANGED'));
        for (const receipt of this.receipts.values()) if (receipt.outcome.target.clientId === input.clientId && receipt.acceptsCompletion) {
            try { this.assertTarget(receipt.outcome.target, registered); }
            catch { receipt.acceptsCompletion = false; }
        }
        // A removed cell must not leave a delivered request able to affect a replacement.
        for (const pending of this.pending.values()) if (pending.task.target.clientId === input.clientId && pending.task.target.cellId !== undefined && !registered.cells.some(cell => cell.id === pending.task.target.cellId)) this.finish(pending, new AppError(409, 'The target chart cell was removed.', 'CHART_TARGET_CHANGED'));
        this.schedule();
        if (input.completion) this.complete(input.clientId, input.clientToken, input.chart, input.completion);
        const queued = [...this.pending.values()].find(pending => pending.task.target.clientId === input.clientId && !pending.delivered);
        if (queued) {
            queued.delivered = true;
            const receipt = this.receipts.get(queued.task.requestId)!;
            receipt.outcome.dispatchedAt = this.now(); receipt.outcome.updatedAt = this.now(); receipt.acceptsCompletion = true;
        }
        this.schedule();
        return { request: queued ? structuredClone(queued.task) : null };
    }

    call(value: unknown, signal?: AbortSignal): Promise<unknown> {
        try {
            this.ensureOpen();
            if (signal?.aborted) throw new AppError(409, 'The chart caller cancelled this request.', 'CHART_CALL_CANCELLED');
            const input = call(value);
            this.prune();
            if (input.operation === 'read_operation') return Promise.resolve(this.readOperation(input));
            const requestId = input.requestId ?? randomUUID();
            if (this.receipts.has(requestId)) throw new AppError(409, `Request ID ${requestId} has already been used. Read its operation outcome instead of resubmitting it.`, 'CHART_REQUEST_ID_REUSED');
            const task: ChartAgentTask = { ...input, requestId, deadline: this.now() + DEADLINE_MS };
            const receipt: Receipt = { outcome: { requestId, operation: task.operation, target: task.target, state: 'not_dispatched',
                createdAt: this.now(), updatedAt: this.now(), deadline: task.deadline, expiresAt: this.now() + RECEIPT_MS }, acceptsCompletion: false };
            this.receipts.set(requestId, receipt);
            this.boundReceipts();
            try {
                const registered = this.clients.get(input.target.clientId);
                if (!registered) throw new AppError(409, 'The target chart window is not connected.', 'CHART_CLIENT_NOT_CONNECTED');
                this.assertTarget(input.target, registered.chart);
                if (this.pending.size >= MAX_PENDING || [...this.pending.values()].some(pending => pending.task.target.clientId === input.target.clientId)) throw new AppError(429, 'A chart request is already pending or the assistant queue is full.', 'CHART_REQUEST_LIMIT');
                receipt.token = registered.token;
                receipt.outcome.state = 'pending';
            } catch (error) {
                receipt.outcome.error = error instanceof Error ? error.message : 'The chart request was not dispatched.';
                this.schedule();
                throw error;
            }
            const result = new Promise<unknown>((resolve, reject) => this.pending.set(task.requestId, { task, delivered: false, resolve, reject }));
            const cancel = (): void => {
                const pending = this.pending.get(task.requestId);
                // Existing chart edits retain their delivery/save/receipt lifecycle after a caller disconnects.
                if (pending && (task.operation === 'propose_scenario' || task.operation === 'read_candle_evidence')) {
                    this.finish(pending, new AppError(409, 'The chart caller cancelled this request.', 'CHART_CALL_CANCELLED'));
                }
            };
            signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted) cancel();
            this.schedule();
            return result.finally(() => signal?.removeEventListener('abort', cancel));
        } catch (error) { return Promise.reject(error); }
    }

    private complete(clientId: string, clientToken: string, registered: Omit<ChartAgentClient, 'clientId'>, response: ChartAgentCompletion): void {
        const pending = this.pending.get(response.requestId);
        const receipt = this.receipts.get(response.requestId);
        if (!receipt?.acceptsCompletion || receipt.outcome.dispatchedAt === undefined || receipt.outcome.target.clientId !== clientId) throw new AppError(409, 'The chart request is no longer pending.', 'CHART_REQUEST_CHANGED');
        if (!receipt.token || !timingSafeEqual(Buffer.from(receipt.token), Buffer.from(clientToken))) throw new AppError(403, 'The chart window token does not match.', 'CHART_CLIENT_TOKEN');
        this.assertTarget(receipt.outcome.target, { clientId, ...registered });
        if (response.success && receipt.outcome.operation === 'propose_scenario' && !receipt.proposal?.granted) throw new AppError(409, 'The proposal has no server commit authority.', 'CHART_PROPOSAL_NOT_AUTHORIZED');
        const result = response.success ? json(response.value, receipt.outcome.operation === 'screenshot' ? SCREENSHOT_BYTES : RESULT_BYTES) : undefined;
        receipt.acceptsCompletion = false;
        receipt.outcome.state = response.success ? 'completed' : 'failed';
        receipt.outcome.updatedAt = this.now(); receipt.outcome.completedAt = this.now();
        delete receipt.outcome.error;
        this.pending.delete(response.requestId);
        if (!response.success) {
            receipt.outcome.error = response.error;
            pending?.reject(new AppError(422, response.error, 'CHART_TOOL_FAILED'));
            return;
        }
        receipt.outcome.value = structuredClone(result);
        pending?.resolve(result);
    }

    private readOperation(input: ChartAgentCall): ChartAgentOutcome {
        keys(input.args, ['requestId']);
        const requestId = uuid(input.args.requestId).toLowerCase();
        const receipt = this.receipts.get(requestId);
        if (!receipt) return { requestId, target: input.target, state: 'unknown', error: 'No retained outcome exists for this request ID. It may have expired, been evicted, or belong to an earlier application process. This does not establish that the operation failed or was not applied.' };
        if (!sameTarget(receipt.outcome.target, input.target)) throw new AppError(409, 'The request outcome belongs to a different chart target.', 'CHART_TARGET_CHANGED');
        return structuredClone(receipt.outcome);
    }

    private boundReceipts(): void {
        for (const requestId of this.receipts.keys()) {
            if (this.receipts.size <= MAX_RECEIPTS) break;
            if (!this.pending.has(requestId)) this.receipts.delete(requestId);
        }
    }

    private assertTarget(destination: ChartAgentTarget, registered: ChartAgentClient): void {
        if (destination.sessionId !== registered.sessionId || destination.generation !== registered.generation || (destination.cellId !== undefined && !registered.cells.some(cell => cell.id === destination.cellId))) throw new AppError(409, 'The target chart session or cell changed.', 'CHART_TARGET_CHANGED');
    }
    private ensureOpen(): void {
        if (this.closed) throw new AppError(503, 'The chart assistant is restarting.', 'CHART_ASSISTANT_CLOSED');
    }
    private finish(pending: Pending, error: AppError): void {
        this.pending.delete(pending.task.requestId);
        const receipt = this.receipts.get(pending.task.requestId);
        const message = `${error.message} Request ID: ${pending.task.requestId}. ${pending.delivered ? 'The operation outcome is unknown; read its operation outcome before deciding what to do next.' : 'The request was not dispatched.'}`;
        if (receipt) {
            receipt.outcome.state = pending.delivered ? 'unknown' : 'not_dispatched';
            receipt.outcome.updatedAt = this.now(); receipt.outcome.error = message;
            receipt.acceptsCompletion = pending.delivered && (['CHART_REQUEST_TIMEOUT', 'CHART_CLIENT_EXPIRED', 'CHART_CLIENT_DISCONNECTED'].includes(error.code)
                || error.code === 'CHART_CALL_CANCELLED' && (pending.task.operation !== 'propose_scenario' || receipt.proposal?.granted === true));
        }
        pending.reject(new AppError(error.status, message, error.code));
    }
    private rejectClient(clientId: string, error: AppError): void {
        for (const pending of this.pending.values()) if (pending.task.target.clientId === clientId) this.finish(pending, error);
    }
    private removeClient(clientId: string, error: AppError): void {
        this.clients.delete(clientId);
        this.rejectClient(clientId, error);
    }
    private prune(): void {
        const now = this.now();
        for (const [clientId, lease] of this.clients) if (lease.expiresAt <= now) this.removeClient(clientId, new AppError(409, 'The target chart window stopped responding.', 'CHART_CLIENT_EXPIRED'));
        for (const pending of this.pending.values()) if (pending.task.deadline <= now) this.finish(pending, new AppError(504, 'The chart assistant request timed out.', 'CHART_REQUEST_TIMEOUT'));
        for (const [requestId, receipt] of this.receipts) if (receipt.outcome.expiresAt! <= now && !this.pending.has(requestId)) this.receipts.delete(requestId);
        this.schedule();
    }
    private schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        if (this.closed) return;
        const deadlines = [...this.clients.values()].map(lease => lease.expiresAt).concat([...this.pending.values()].map(pending => pending.task.deadline), [...this.receipts.values()].map(receipt => receipt.outcome.expiresAt!));
        if (!deadlines.length) return;
        this.timer = setTimeout(() => this.prune(), Math.max(1, Math.min(...deadlines) - this.now()));
        this.timer.unref?.();
    }
    close(): void {
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        for (const pending of this.pending.values()) this.finish(pending, new AppError(503, 'The chart assistant is restarting.', 'CHART_ASSISTANT_CLOSED'));
        this.clients.clear();
        this.receipts.clear();
    }
}
