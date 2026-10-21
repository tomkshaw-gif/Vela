export const REPLAY_ZONES = [
    { id: 'UTC', label: 'UTC' },
    { id: 'Europe/London', label: 'London' },
    { id: 'America/New_York', label: 'New York' },
] as const;

export type JumpPreset = 'london' | 'new-york' | 'next-day';
/** offsetMinutes is local time minus UTC; label includes historical offset seconds when needed. */
export interface WallTimeOccurrence { time: number; offsetMinutes: number; label: string }
export interface WallTimeParseOptions { occurrence?: 'earlier' | 'later'; offsetMinutes?: number }

interface WallTime { year: number; month: number; day: number; hour: number; minute: number; second: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
const minute = 60000;
const day = 24 * 60 * minute;

function formatter(zone: string): Intl.DateTimeFormat {
    if (!REPLAY_ZONES.some(({ id }) => id === zone)) throw new RangeError('Choose UTC, London, or New York.');
    let result = formatters.get(zone);
    if (!result) {
        result = new Intl.DateTimeFormat('en-GB', { timeZone: zone, calendar: 'gregory', numberingSystem: 'latn',
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
            hourCycle: 'h23', era: 'short' });
        formatters.set(zone, result);
    }
    return result;
}

function utcTime(value: WallTime): number {
    const result = new Date(0);
    result.setUTCFullYear(value.year, value.month - 1, value.day);
    result.setUTCHours(value.hour, value.minute, value.second, 0);
    return result.getTime();
}

function utcParts(time: number): WallTime {
    const value = new Date(time);
    return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate(),
        hour: value.getUTCHours(), minute: value.getUTCMinutes(), second: value.getUTCSeconds() };
}

function parts(time: number, zone: string): WallTime {
    if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime())) throw new RangeError('Choose a valid date and time.');
    if (zone === 'UTC') return utcParts(time);
    const values = Object.fromEntries(formatter(zone).formatToParts(time).map(({ type, value }) => [type, value]));
    const year = Number(values.year);
    return { year: values.era === 'BC' ? 1 - year : year, month: Number(values.month), day: Number(values.day),
        hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) };
}

function same(left: WallTime, right: WallTime): boolean {
    return left.year === right.year && left.month === right.month && left.day === right.day
        && left.hour === right.hour && left.minute === right.minute && left.second === right.second;
}

function input(value: WallTime): string {
    if (value.year < 1 || value.year > 9999) throw new RangeError('Choose a year from 0001 to 9999.');
    const pad = (number: number, length = 2): string => String(number).padStart(length, '0');
    return `${pad(value.year, 4)}-${pad(value.month)}-${pad(value.day)}T${pad(value.hour)}:${pad(value.minute)}:${pad(value.second)}`;
}

function readInput(value: string): WallTime {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (!match) throw new RangeError('Choose a date and time in YYYY-MM-DDTHH:mm format.');
    const result = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
        hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] ?? 0) };
    if (result.year < 1 || result.year > 9999 || !same(result, utcParts(utcTime(result)))) {
        throw new RangeError('Choose a valid calendar date and time.');
    }
    return result;
}

function occurrences(value: WallTime, zone: string): number[] {
    const wall = utcTime(value);
    if (zone === 'UTC') return [wall];
    // Sampling both sides of the date captures both offsets at a clock change.
    const offsets = new Set([-2, -1, 0, 1, 2].map((shift) => {
        const time = wall + shift * day;
        return utcTime(parts(time, zone)) - time;
    }));
    return [...offsets].map((offset) => wall - offset).filter((time) => same(value, parts(time, zone))).sort((a, b) => a - b);
}

/** Formats UTC epoch milliseconds for a datetime-local input, to second precision. */
export function wallTimeInput(time: number, zone: string): string {
    return input(parts(time, zone));
}

/** Empty for a spring gap; repeated times expose both real UTC offsets in time order. */
export function wallTimeOccurrences(value: string, zone: string): WallTimeOccurrence[] {
    const wall = readInput(value);
    return occurrences(wall, zone).map(time => {
        const offsetMinutes = (utcTime(wall) - time) / minute;
        const seconds = Math.round(Math.abs(offsetMinutes) * 60);
        const pad = (value: number): string => String(value).padStart(2, '0');
        const label = `UTC${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}${seconds % 60 ? `:${pad(seconds % 60)}` : ''}`;
        return { time, offsetMinutes, label };
    });
}

/** Manual entry never silently selects one occurrence of a repeated wall time. */
export function parseWallTime(value: string, zone: string, options: WallTimeParseOptions = {}): number {
    const matches = wallTimeOccurrences(value, zone);
    if (!matches.length) throw new RangeError('That local time does not exist because the clocks move forward. Choose a later time.');
    if (options.occurrence !== undefined && options.occurrence !== 'earlier' && options.occurrence !== 'later') throw new RangeError('Choose the earlier or later occurrence.');
    const occurrence = options.occurrence === undefined ? undefined : options.occurrence === 'earlier' ? matches[0] : matches.at(-1);
    const offset = options.offsetMinutes === undefined ? undefined : matches.find(match => match.offsetMinutes === options.offsetMinutes);
    if (options.offsetMinutes !== undefined && !offset || occurrence && offset && occurrence !== offset) throw new RangeError('Choose an offset that matches the selected local time and occurrence.');
    if (matches.length > 1 && !occurrence && !offset) throw new RangeError('That local time occurs twice. Choose an explicit UTC offset or occurrence.');
    return (offset ?? occurrence ?? matches[0]!).time;
}

/** Presets are weekday time conventions, not exchange holiday calendars. */
export function nextSessionTime(after: number, preset: JumpPreset, zone: string): { time: number; zone: string; label: string } {
    if (preset !== 'london' && preset !== 'new-york' && preset !== 'next-day') throw new RangeError('Choose a valid replay shortcut.');
    const targetZone = preset === 'london' ? 'Europe/London' : preset === 'new-york' ? 'America/New_York' : zone;
    const current = parts(after, targetZone);
    if (preset === 'next-day') {
        const target = utcParts(utcTime(current) + day);
        // The same wall time may be skipped in spring. Use the first valid minute after it.
        for (let index = 0; index <= 180; index++) {
            const candidate = index ? utcParts(utcTime({ ...target, second: 0 }) + index * minute) : target;
            const matches = occurrences(candidate, targetZone);
            if (matches.length > 1) throw new RangeError('Next day occurs twice. Enter that date and choose an explicit UTC offset or occurrence.');
            const time = matches[0];
            if (time !== undefined && time > after) return { time, zone: targetZone, label: 'Next day' };
        }
    } else {
        const opening = { ...current, hour: preset === 'london' ? 8 : 9, minute: preset === 'london' ? 0 : 30, second: 0 };
        for (let index = 0; index < 8; index++) {
            const candidate = utcParts(utcTime(opening) + index * day);
            const weekday = new Date(utcTime(candidate)).getUTCDay();
            if (weekday === 0 || weekday === 6) continue;
            const time = occurrences(candidate, targetZone)[0];
            if (time !== undefined && time > after) return { time, zone: targetZone, label: preset === 'london' ? 'London 08:00' : 'New York 09:30' };
        }
    }
    throw new RangeError('No later replay time is available for that date.');
}
