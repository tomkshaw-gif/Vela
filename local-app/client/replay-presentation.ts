const VISIBILITY_KEY = 'vela.replay-controls.open.v1';

export type ReplayPreferenceStore = Pick<Storage, 'getItem' | 'setItem'>;

/** Keep playback visibility independent of the saved chart and replay ledger. */
export class ReplayPresentation {
    private visible = false;
    private strip: HTMLElement | null = null;
    private root: HTMLElement | null = null;

    constructor(private readonly pause: () => void, private readonly storage?: ReplayPreferenceStore) {
        try { this.visible = storage?.getItem(VISIBILITY_KEY) === 'true'; } catch { /* Visibility remains usable without storage. */ }
    }

    get open(): boolean { return this.visible; }

    mount(strip: HTMLElement): void {
        this.strip = strip;
        this.root = strip.closest<HTMLElement>('.vela-workspace');
        this.sync();
    }

    unmount(): void { this.strip = null; this.root = null; }

    setOpen(open: boolean): void {
        if (!open) this.pause();
        this.visible = open;
        try { this.storage?.setItem(VISIBILITY_KEY, String(open)); } catch { /* Storage does not own the live control. */ }
        this.sync();
    }

    toggle(): void { this.setOpen(!this.visible); }

    private sync(): void {
        if (this.strip) this.strip.hidden = !this.visible;
        if (this.root) this.root.dataset.localReplayOpen = String(this.visible);
    }
}

export function replayPreferenceStore(): ReplayPreferenceStore | undefined {
    try { return window.localStorage; } catch { return undefined; }
}

/** A replay interval is a bounded number of complete source bars. */
export function replayIntervalCount(value: string): number {
    return value === '5' ? 5 : value === '10' ? 10 : 1;
}

export function replayIntervalLabel(intervalMs: number, count: number): string {
    const seconds = intervalMs * count / 1000;
    return seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}
