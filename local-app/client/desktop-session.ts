const KEY = 'vela.desktop.session.v1';
const NAMES = ['vela-replay-selected-session', 'vela.local.pine-window-id', 'vela.local.pine-window-lock'] as const;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Restore only session identity; credentials and arbitrary storage never cross this seam. */
export function restoreDesktopSession(local: Store, session: Store): void {
    const raw = local.getItem(KEY);
    if (!raw) return;
    if (raw.length > 1024) throw new Error('Desktop session recovery is invalid.');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Desktop session recovery is invalid.');
    const restored: [string, string][] = [];
    for (const name of NAMES) {
        const value = (parsed as Record<string, unknown>)[name];
        if (value !== undefined && (typeof value !== 'string' || !(name === 'vela.local.pine-window-lock' && value === '')
            && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))) throw new Error('Desktop session recovery is invalid.');
        if (typeof value === 'string' && session.getItem(name) === null) restored.push([name, value]);
    }
    for (const [name, value] of restored) session.setItem(name, value);
}
export function persistDesktopSession(local: Store, session: Store): void {
    const values: Record<string, string> = {};
    for (const name of NAMES) { const value = session.getItem(name); if (value !== null) values[name] = value; }
    local.setItem(KEY, JSON.stringify(values));
}
