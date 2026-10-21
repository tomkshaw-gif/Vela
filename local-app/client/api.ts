export class ApiError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
}

/** The bootstrap token stays in memory and accompanies same-origin mutations only. */
export class LocalApi {
    private token = '';
    setToken(token: string): void { this.token = token; }
    async get<T>(path: string, signal?: AbortSignal): Promise<T> {
        return this.request<T>(path, { signal });
    }
    async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
        return this.request<T>(path, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': this.token },
            body: JSON.stringify(body), signal,
        });
    }
    postKeepalive(path: string, body: unknown): void {
        void fetch(path, { method: 'POST', credentials: 'same-origin', keepalive: true,
            headers: { 'Content-Type': 'application/json', 'X-Local-Token': this.token },
            body: JSON.stringify(body) }).catch(() => undefined);
    }
    private async request<T>(path: string, init: RequestInit): Promise<T> {
        const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
        const data: unknown = await response.json();
        if (!response.ok) {
            const message = data && typeof data === 'object' && 'error' in data ? String(data.error) : 'Local request failed.';
            throw new ApiError(message, response.status);
        }
        return data as T;
    }
}
