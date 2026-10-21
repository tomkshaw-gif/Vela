/** The exact standalone worker shipped inside the installed official Pine addon. */
export function loadPineWorkerSource(): Promise<string>;
/** The exact official host transport class, with a hosted-worker-only spawning helper. */
export function loadPineHostSource(): Promise<string>;
export function extractPineHostSource(source: string, entry?: string): string;
