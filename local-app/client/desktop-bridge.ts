export interface DesktopUpdateState {
    status: 'idle' | 'checking' | 'downloading' | 'current' | 'ready' | 'installing' | 'error';
    version?: string;
    currentVersion: string;
}
export interface DesktopBridge {
    onPrepare(callback: (request: { requestId: string; reason: 'quit' | 'update' }) => void): () => void;
    prepared(requestId: string, error?: string): void;
    getUpdateState(): Promise<DesktopUpdateState>;
    onUpdateState(callback: (state: DesktopUpdateState) => void): () => void;
    checkForUpdates(): Promise<void>;
    installUpdate(): Promise<boolean>;
}
declare global { interface Window { velaDesktop?: DesktopBridge } }
