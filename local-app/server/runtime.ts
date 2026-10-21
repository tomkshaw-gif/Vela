import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AppError, requireObject } from './errors';
import type { ManagedRuntimeOptions, RuntimeStatus } from '../shared/runtime';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const LEASE_MS = 20_000;
const REGISTRATION_GRACE_MS = 1000;
const MAX_CLIENTS = 64;
export function repositoryIdentity(repository: string): string {
    const path = resolve(repository);
    return createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
}
export function validateRuntime(value: ManagedRuntimeOptions): ManagedRuntimeOptions {
    if (!value || !['run', 'develop'].includes(value.mode) || typeof value.version !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(value.version)) throw new AppError(500, 'Invalid managed runtime configuration.');
    return { mode: value.mode, version: value.version };
}

/** Coordinates one update without forcing a tab past an unsaved chart layout. */
export class RuntimeCoordinator {
    private readonly leases = new Map<string, { expiresAt: number; acknowledged?: string }>();
    private readonly participants = new Set<string>();
    private phase: RuntimeStatus['phase'] = 'ready';
    private updateId: string | null = null;
    private message: string | null = null;
    private preparedAt = 0;
    private notifiedReady = false;
    private closed = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    readonly instanceId = randomUUID();
    readonly repositoryId: string;
    readonly managed: ManagedRuntimeOptions | undefined;

    constructor(runtime: ManagedRuntimeOptions | undefined, repository: string, private notify: (message: { type: 'runtime:ready'; updateId: string }) => void = () => {}, private readonly now: () => number = Date.now, private readonly idle: () => boolean = () => true) {
        this.managed = runtime ? validateRuntime(runtime) : undefined;
        this.repositoryId = repositoryIdentity(repository);
    }
    status(): RuntimeStatus {
        return { managed: !!this.managed, mode: this.managed?.mode ?? 'run', version: this.managed?.version ?? 'unmanaged', instanceId: this.instanceId, repositoryId: this.repositoryId, phase: this.phase, updateId: this.updateId, message: this.message };
    }
    get preparing(): boolean { return this.phase === 'preparing'; }
    private prune(): void {
        const now = this.now();
        for (const [id, lease] of this.leases) if (lease.expiresAt <= now && !this.participants.has(id)) this.leases.delete(id);
    }
    client(value: unknown): RuntimeStatus {
        if (this.closed) throw new AppError(503, 'The local application is restarting.', 'UPDATE_PENDING');
        if (!this.managed) throw new AppError(409, 'This instance is not managed by the desktop launcher.', 'UNMANAGED_RUNTIME');
        const input = requireObject(value);
        if (Object.keys(input).some(key => !['clientId', 'action', 'updateId'].includes(key)) || typeof input.clientId !== 'string' || !UUID.test(input.clientId) || !['heartbeat', 'ready', 'release'].includes(String(input.action))) throw new AppError(400, 'Invalid runtime client request.');
        this.prune();
        if (input.action === 'release') {
            if (input.updateId !== undefined) throw new AppError(400, 'Release must not contain an update ID.');
            this.leases.delete(input.clientId);
            this.participants.delete(input.clientId);
        } else {
            const existing = this.leases.get(input.clientId);
            if (!existing && this.leases.size >= MAX_CLIENTS) throw new AppError(429, 'Too many active application windows.', 'CLIENT_LIMIT');
            if (input.action === 'ready') {
                if (!existing) throw new AppError(409, 'Register the application window before acknowledging an update.', 'CLIENT_NOT_REGISTERED');
                if (!this.preparing || input.updateId !== this.updateId) throw new AppError(409, 'The update acknowledgement is no longer current.', 'UPDATE_CHANGED');
            } else if (input.updateId !== undefined) throw new AppError(400, 'Heartbeat must not contain an update ID.');
            this.leases.set(input.clientId, { expiresAt: this.now() + LEASE_MS, acknowledged: input.action === 'ready' ? this.updateId! : existing?.acknowledged });
            if (this.preparing) this.participants.add(input.clientId);
        }
        this.checkReadiness();
        return this.status();
    }
    prepare(updateId: unknown): boolean {
        if (this.closed || !this.managed || typeof updateId !== 'string' || !UUID.test(updateId)) return false;
        if (this.preparing) return updateId === this.updateId;
        this.prune();
        this.phase = 'preparing'; this.updateId = updateId; this.message = null;
        this.preparedAt = this.now(); this.notifiedReady = false;
        // A suspended tab must not become safe merely because its heartbeat expired.
        this.participants.clear();
        for (const id of this.leases.keys()) this.participants.add(id);
        for (const lease of this.leases.values()) delete lease.acknowledged;
        this.checkReadiness(); return true;
    }
    cancel(updateId: unknown): boolean {
        if (!this.preparing || updateId !== this.updateId) return false;
        this.clearTimer(); this.phase = 'error'; this.updateId = null;
        this.participants.clear(); this.prune();
        this.message = 'The update was cancelled. Your existing version is still running.';
        this.notifiedReady = false; return true;
    }
    canShutdown(updateId: unknown): boolean {
        if (this.closed) return false;
        if (updateId === undefined) return true;
        this.prune();
        return this.preparing && updateId === this.updateId && this.idle() && this.now() - this.preparedAt >= REGISTRATION_GRACE_MS && [...this.participants].every(id => this.leases.get(id)?.acknowledged === updateId);
    }
    beginShutdown(updateId: unknown): boolean {
        if (!this.canShutdown(updateId)) return false;
        this.close(); return true;
    }
    activityChanged(): void { this.checkReadiness(); }
    onReady(notify: (message: { type: 'runtime:ready'; updateId: string }) => void): void { this.notify = notify; }
    private checkReadiness(): void {
        this.clearTimer(); this.prune();
        if (this.closed || !this.preparing) return;
        const ready = this.canShutdown(this.updateId);
        if (ready && !this.notifiedReady) {
            this.notifiedReady = true;
            this.notify({ type: 'runtime:ready', updateId: this.updateId! });
        } else if (!ready) this.notifiedReady = false;
        const deadlines = [...this.leases].filter(([id]) => !this.participants.has(id)).map(([, lease]) => lease.expiresAt);
        if (this.now() - this.preparedAt < REGISTRATION_GRACE_MS) deadlines.push(this.preparedAt + REGISTRATION_GRACE_MS);
        if (deadlines.length) {
            this.timer = setTimeout(() => this.checkReadiness(), Math.max(1, Math.min(...deadlines) - this.now()));
            this.timer.unref?.();
        }
    }
    private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
    close(): void { this.closed = true; this.clearTimer(); this.leases.clear(); this.participants.clear(); }
}
