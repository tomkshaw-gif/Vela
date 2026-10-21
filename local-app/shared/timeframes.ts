import type { Schema } from './types';

export interface TimeframeDescriptor {
    native: string; server: string; unit: 'second' | 'minute' | 'day' | 'week' | 'month';
    count: number; intervalMs: number | null;
}
const DAY = 86_400_000;
const MONDAY = -3 * DAY;
const MAX_COUNT = { second: 86400, minute: 525600, day: 366, week: 52, month: 120 };

/** Accepts native chart resolutions and existing lower-case server aliases. */
export function parseTimeframe(value: string): TimeframeDescriptor | null {
    if (typeof value !== 'string' || value.length > 8) return null;
    let unit: TimeframeDescriptor['unit']; let count: number;
    const bare = /^([1-9][0-9]{0,5})$/.exec(value);
    const native = /^([1-9][0-9]{0,5})?([SDWM])$/.exec(value);
    const alias = /^([1-9][0-9]{0,5})([smhdw])$/.exec(value);
    if (bare) { unit = 'minute'; count = Number(bare[1]); }
    else if (native) { unit = ({ S: 'second', D: 'day', W: 'week', M: 'month' } as const)[native[2] as 'S' | 'D' | 'W' | 'M']; count = Number(native[1] ?? 1); }
    else if (alias) {
        unit = ({ s: 'second', m: 'minute', h: 'minute', d: 'day', w: 'week' } as const)[alias[2] as 's' | 'm' | 'h' | 'd' | 'w'];
        count = Number(alias[1]) * (alias[2] === 'h' ? 60 : 1);
    } else return null;
    if (!Number.isSafeInteger(count) || count > MAX_COUNT[unit]) return null;
    const multiplier = { second: 1000, minute: 60000, day: DAY, week: 7 * DAY, month: 0 }[unit];
    const suffix = { second: 'S', minute: '', day: 'D', week: 'W', month: 'M' }[unit];
    const nativeValue = `${count === 1 && ['day', 'week', 'month'].includes(unit) ? '' : count}${suffix}`;
    const server = unit === 'minute' ? count % 60 === 0 ? `${count / 60}h` : `${count}m` : `${count}${{ second: 's', minute: 'm', day: 'd', week: 'w', month: 'M' }[unit]}`;
    return { native: nativeValue, server, unit, count, intervalMs: unit === 'month' ? null : count * multiplier };
}
export function timeframeSupported(value: string, schema: Schema): boolean {
    const period = parseTimeframe(value);
    const source = schema === 'ohlcv-1s' ? 1000 : schema === 'ohlcv-1m' ? 60000 : null;
    return !!period && source !== null && (period.intervalMs === null || period.intervalMs >= source && period.intervalMs % source === 0);
}
export function toServerTimeframe(value: string): string {
    const period = parseTimeframe(value);
    if (!period) throw new Error('Invalid chart timeframe.');
    return period.server;
}
/** Days use UTC midnight; weeks use Monday; months use actual calendar boundaries. */
export function timeframeBucket(time: number, period: TimeframeDescriptor): number {
    if (period.unit === 'month') {
        const date = new Date(time); const months = (date.getUTCFullYear() - 1970) * 12 + date.getUTCMonth();
        const bucket = new Date(0); bucket.setUTCFullYear(1970, Math.floor(months / period.count) * period.count, 1);
        return bucket.getTime();
    }
    const anchor = period.unit === 'week' ? MONDAY : 0;
    return Math.floor((time - anchor) / period.intervalMs!) * period.intervalMs! + anchor;
}
export function nextTimeframeBucket(bucket: number, period: TimeframeDescriptor): number {
    if (period.unit !== 'month') return bucket + period.intervalMs!;
    const date = new Date(bucket); let days = 0;
    for (let i = 0; i < period.count; i++) {
        const monthIndex = date.getUTCMonth() + i; const year = date.getUTCFullYear() + Math.floor(monthIndex / 12); const month = monthIndex % 12;
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        days += [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month]!;
    }
    return bucket + days * DAY;
}
