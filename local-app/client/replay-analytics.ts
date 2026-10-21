import type { Analytics } from '../shared/types';

interface Target { sessionId: string; version: number }
interface Options {
    target(): Target | null; enabled(): boolean;
    load(target: Target, signal: AbortSignal): Promise<Analytics>;
    apply(analysis: Analytics): void; onError(error: unknown): void;
}

/** Coalesces ledger changes without putting analytics on the playback queue. */
export class ReplayAnalyticsRefresh {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private request: Promise<void> | null = null;
    private controller: AbortController | null = null;
    private dirty = false;
    private lastStarted = -Infinity;
    private disposed = false;

    constructor(private readonly options: Options) {}

    invalidate(): void { this.dirty = true; this.schedule(); }
    wake(): void { this.schedule(); }

    private schedule(): void {
        if (this.disposed || this.timer || this.request || !this.dirty || !this.options.enabled()) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (this.options.enabled()) void this.refresh().catch(this.options.onError);
        }, Math.max(0, 300 - (Date.now() - this.lastStarted)));
    }

    async refresh(): Promise<void> {
        clearTimeout(this.timer); this.timer = undefined;
        if (this.disposed) return;
        if (this.request) { this.dirty = true; return this.request; }
        if (!this.options.enabled()) { this.dirty = true; return; }
        const target = this.options.target(); if (!target) { this.dirty = true; return; }
        const controller = new AbortController(); this.controller = controller;
        this.dirty = false; this.lastStarted = Date.now();
        const request = this.options.load(target, controller.signal).then(analysis => {
            const current = this.options.target();
            if (this.disposed || controller.signal.aborted) return;
            if (current?.sessionId === target.sessionId && current.version === target.version) this.options.apply(analysis);
            else this.dirty = true;
        }).catch((error: unknown) => { if (!controller.signal.aborted && !this.disposed) throw error; });
        this.request = request;
        try { await request; }
        finally {
            if (this.request === request) { this.request = null; this.controller = null; }
            this.schedule();
        }
    }

    reset(): void {
        clearTimeout(this.timer); this.timer = undefined; this.controller?.abort();
        this.controller = null; this.request = null; this.dirty = false;
    }

    destroy(): void { this.disposed = true; this.reset(); }
}
