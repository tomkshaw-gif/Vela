export interface DesktopBridge {
    onPrepare(callback: (request: { requestId: string; reason: 'quit' | 'update' }) => void): () => void;
    prepared(requestId: string, error?: string): void;
}
declare global { interface Window { velaDesktop?: DesktopBridge } }
