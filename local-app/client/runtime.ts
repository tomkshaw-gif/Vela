import type { LocalApi } from './api';
import type { RuntimeStatus } from '../shared/runtime';

export interface RuntimeNotice {
    mode: RuntimeStatus['mode'] | null;
    blocked: boolean;
    message: string;
    error?: boolean;
}

interface RuntimeHooks {
    /** Synchronously pause playback and prevent new user mutations. */
    notice(notice: RuntimeNotice): void;
    /** Resolve only after the complete current chart snapshot is durably saved. */
    prepare(): Promise<void>;
    /** Refresh the write token and strictly save any old-process chart state before reload. */
    reconnect(): Promise<void>;
    reload(): void;
}

const SELECTED_SESSION = 'vela-replay-selected-session';

export function rememberSession(storage: Pick<Storage, 'setItem'>, id: string): void {
    try { storage.setItem(SELECTED_SESSION, id); } catch { /* Storage may be disabled. */ }
}

export function selectedSession(storage: Pick<Storage, 'getItem'>, sessions: { id: string }[]): string | undefined {
    let saved: string | null = null;
    try { saved = storage.getItem(SELECTED_SESSION); } catch { /* Fall back to the current index. */ }
    return sessions.find((session) => session.id === saved)?.id ?? sessions[0]?.id;
}

/** The supervisor may restart only after each live browser has persisted its UI state. */
export class RuntimeCoordinator {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private controller = new AbortController();
    private disposed = false;
    private managed = false;
    private mode: RuntimeStatus['mode'] | null = null;
    private instanceId: string | null = null;
    private updateId: string | null = null;
    private updateGeneration = 0;
    private failedUpdate: string | null = null;
    private reloading = false;
    private failures = 0;
    private lastHeartbeat = -Infinity;
    private startPromise: Promise<void> | null = null;
    private registered: (() => void) | null = null;

    constructor(private api: Pick<LocalApi, 'get' | 'post' | 'postKeepalive'>, private hooks: RuntimeHooks,
        private clientId = crypto.randomUUID(), private now: () => number = Date.now) {}

    start(): Promise<void> {
        if (this.startPromise) return this.startPromise;
        if (this.disposed) return Promise.reject(new Error('The workspace closed before local registration.'));
        this.startPromise = new Promise((resolve) => { this.registered = resolve; });
        void this.poll();
        return this.startPromise;
    }

    private async poll(): Promise<void> {
        if (this.disposed || this.reloading) return;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const request = new AbortController();
        const abort = (): void => request.abort();
        this.controller.signal.addEventListener('abort', abort, { once: true });
        try {
            timeout = setTimeout(() => request.abort(), 5000);
            const state = await this.api.get<RuntimeStatus>('/api/runtime', request.signal);
            if (this.disposed) return;
            if (!state.managed) {
                if (this.failures) this.hooks.notice({ mode: null, blocked: false, message: '' });
                this.registered?.(); this.registered = null; this.failures = 0; return;
            }
            this.managed = true; this.mode = state.mode;
            if (this.instanceId && this.instanceId !== state.instanceId) {
                this.updateGeneration++;
                this.hooks.notice({ mode: this.mode, blocked: true, message: 'Vela restarted. Saving any pending chart changes before reopening…' });
                await this.hooks.reconnect();
                if (this.disposed) return;
                this.reloading = true;
                this.hooks.notice({ mode: this.mode, blocked: true, message: 'Workspace saved. Reopening your session…' });
                this.hooks.reload(); return;
            }
            this.instanceId = state.instanceId;
            if (this.now() - this.lastHeartbeat >= 3000) {
                await this.api.post('/api/runtime/client', { clientId: this.clientId, action: 'heartbeat' }, request.signal);
                this.lastHeartbeat = this.now();
            }
            if (this.disposed) return;
            this.failures = 0;
            this.registered?.(); this.registered = null;
            if (state.phase === 'preparing' && state.updateId) {
                if (this.updateId !== state.updateId) {
                    this.updateId = state.updateId; this.failedUpdate = null;
                    const generation = ++this.updateGeneration;
                    this.hooks.notice({ mode: this.mode, blocked: true, message: 'Updating Vela. Pausing and saving this workspace…' });
                    void this.prepare(state.updateId, generation);
                }
            } else {
                const wasPreparing = this.updateId !== null;
                this.updateId = null; this.failedUpdate = null; this.updateGeneration++;
                this.hooks.notice({ mode: this.mode, blocked: false, error: state.phase === 'error',
                    message: state.phase === 'error' ? 'Update could not be applied. The current version remains open.'
                        : wasPreparing ? 'Update cancelled. The current version remains open; playback stays paused.' : '' });
            }
        } catch {
            if (!this.disposed) {
                this.failures++;
                this.hooks.notice({ mode: this.mode, blocked: true, message: this.instanceId
                    ? 'Reconnecting to the local app. Pending chart changes stay in this window until they can be saved. Playback is paused.'
                    : 'Connecting to the local app. Waiting for secure workspace registration before opening your chart…' });
            }
        } finally {
            clearTimeout(timeout);
            this.controller.signal.removeEventListener('abort', abort);
            if (!this.disposed && !this.reloading) this.timer = setTimeout(() => { void this.poll(); }, Math.min(5000, 1000 * Math.max(1, this.failures)));
        }
    }

    private async prepare(updateId: string, generation: number): Promise<void> {
        try {
            await this.hooks.prepare();
            if (this.disposed || generation !== this.updateGeneration || this.updateId !== updateId) return;
            await this.api.post('/api/runtime/client', { clientId: this.clientId, action: 'ready', updateId }, this.controller.signal);
            if (this.disposed || generation !== this.updateGeneration) return;
            this.lastHeartbeat = this.now();
            this.hooks.notice({ mode: this.mode, blocked: true, message: 'Workspace saved. Waiting for Vela to restart…' });
        } catch {
            if (this.disposed || generation !== this.updateGeneration || this.failedUpdate === updateId) return;
            this.failedUpdate = updateId;
            this.hooks.notice({ mode: this.mode, blocked: true, error: true,
                message: 'The workspace could not be saved for this update. Playback remains paused; the current version will be kept.' });
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true; this.updateGeneration++;
        clearTimeout(this.timer); this.controller.abort();
        if (this.managed) this.api.postKeepalive('/api/runtime/client', { clientId: this.clientId, action: 'release' });
    }
}
