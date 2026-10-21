import type { Bar } from '../shared/types';

export const money = (value: number): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(value);
export const signedMoney = (value: number): string => `${value > 0 ? '+' : ''}${money(value)}`;
export const number = (value: number): string => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
export const percent = (value: number | null): string => value === null ? '—' : `${number(value * 100)}%`;
export const utc = (value: number): string => new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
export const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export const clampPercent = (value: number): number => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

export function serializeBackup(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > MAX_BACKUP_BYTES) throw new Error('Session backup exceeds the 64 MiB restore limit.');
    return serialized;
}

/** The server includes the partial aggregation bucket again in incremental answers. */
export function mergeBars(previous: readonly Bar[], incoming: readonly Bar[], limit = 5000): Bar[] {
    const byTime = new Map<number, Bar>();
    for (const bar of previous) byTime.set(bar.time, bar);
    for (const bar of incoming) byTime.set(bar.time, bar);
    return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-Math.min(5000, limit));
}

export function replayShortcutTargetIsEditing(target: Element | null): boolean {
    return !!target?.closest('input,select,textarea,summary,[contenteditable="true"],[role="dialog"],[role="tablist"],dialog,.local-drawing-grip,.local-script-dock,.local-chart-templates');
}

export function keyboardAction(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>, editing: boolean): 'play' | 'step' | 'buy' | 'sell' | 'close' | null {
    if (editing || event.ctrlKey || event.metaKey || event.altKey) return null;
    if (event.code === 'Space') return 'play';
    if (event.key === 'ArrowRight') return 'step';
    return ({ b: 'buy', s: 'sell', x: 'close' } as const)[event.key.toLowerCase() as 'b' | 's' | 'x'] ?? null;
}

export function blocksNativeMarketTyping(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>, editing: boolean): boolean {
    return !editing && !event.ctrlKey && !event.metaKey && !event.altKey && /^[a-z0-9]$/i.test(event.key);
}

export function downloadJson(name: string, value: unknown): void {
    const url = URL.createObjectURL(new Blob([serializeBackup(value)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** SVG coordinates use actual values and handle flat or single-point series. */
export function linePath(values: readonly number[], width = 700, height = 110): string {
    if (!values.length) return '';
    const min = Math.min(...values); const max = Math.max(...values);
    const spread = max - min || Math.max(1, Math.abs(min) * 0.01);
    return values.map((value, i) => `${i ? 'L' : 'M'}${(i * width / Math.max(1, values.length - 1)).toFixed(2)},${(height - 8 - ((value - min) / spread) * (height - 16)).toFixed(2)}`).join(' ');
}
