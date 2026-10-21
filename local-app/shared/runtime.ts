/** Browser-visible update state; repository identity contains no local paths. */
export interface RuntimeStatus {
    managed: boolean;
    mode: 'run' | 'develop';
    version: string;
    instanceId: string;
    repositoryId: string;
    phase: 'ready' | 'preparing' | 'error';
    updateId: string | null;
    message: string | null;
}

export interface ManagedRuntimeOptions {
    mode: RuntimeStatus['mode'];
    version: string;
}

export interface RuntimeClientAction {
    clientId: string;
    action: 'heartbeat' | 'ready' | 'release';
    updateId?: string;
}
