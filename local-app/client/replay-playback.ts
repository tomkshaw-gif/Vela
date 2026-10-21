export interface ReplayPlaybackHooks {
    advance(): Promise<void>;
    delay(): number;
    canPlay(): boolean;
    onError(error: unknown): void;
}

/** Serializes replay advances across pause and resume, including pending requests. */
export class ReplayPlayback {
    private active = false;
    private generation = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private advancing: Promise<void> | null = null;

    constructor(private hooks: ReplayPlaybackHooks) {}

    get playing(): boolean { return this.active; }

    start(): void {
        if (this.active) return;
        try {
            if (!this.hooks.canPlay()) return;
            this.active = true;
            void this.tick(++this.generation);
        } catch (error) { this.fail(error); }
    }

    stop(): void {
        this.active = false;
        this.generation++;
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    private current(generation: number): boolean {
        return this.active && this.generation === generation;
    }

    private fail(error: unknown): void {
        this.stop();
        this.hooks.onError(error);
    }

    private async tick(generation: number): Promise<void> {
        try {
            if (!this.current(generation)) return;
            if (this.advancing) {
                // The request owner handles failure once and invalidates waiting starts.
                await this.advancing.catch(() => undefined);
            }
            if (!this.current(generation)) return;
            if (!this.hooks.canPlay()) { this.stop(); return; }

            const advance = this.hooks.advance();
            this.advancing = advance;
            try { await advance; }
            catch (error) { this.fail(error); return; }
            finally { if (this.advancing === advance) this.advancing = null; }

            if (!this.current(generation)) return;
            if (!this.hooks.canPlay()) { this.stop(); return; }
            const requested = this.hooks.delay();
            const delay = Number.isFinite(requested) ? Math.min(2_147_483_647, Math.max(0, requested)) : 1000;
            this.timer = setTimeout(() => {
                this.timer = undefined;
                void this.tick(generation);
            }, delay);
        } catch (error) {
            if (this.current(generation)) this.fail(error);
        }
    }
}
