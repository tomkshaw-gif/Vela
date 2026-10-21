import { describe, expect, it } from 'vitest';
import { nextSessionTime, parseWallTime, REPLAY_ZONES, wallTimeInput, wallTimeOccurrences } from '../client/replay-time';

const epoch = (value: string): number => Date.parse(value);

describe('replay wall time', () => {
    it('offers explicit zones and formats without using the machine timezone', () => {
        expect(REPLAY_ZONES.map(({ id }) => id)).toEqual(['UTC', 'Europe/London', 'America/New_York']);
        const time = epoch('2024-07-03T13:30:45.500Z');
        expect(wallTimeInput(time, 'UTC')).toBe('2024-07-03T13:30:45');
        expect(wallTimeInput(time, 'Europe/London')).toBe('2024-07-03T14:30:45');
        expect(wallTimeInput(time, 'America/New_York')).toBe('2024-07-03T09:30:45');
    });

    it('parses minute and second precision including leap days and early years', () => {
        expect(parseWallTime('2024-02-29T12:34', 'UTC')).toBe(epoch('2024-02-29T12:34:00Z'));
        expect(parseWallTime('2024-02-29T12:34:56', 'Europe/London')).toBe(epoch('2024-02-29T12:34:56Z'));
        expect(wallTimeInput(parseWallTime('0099-01-02T03:04:05', 'UTC'), 'UTC')).toBe('0099-01-02T03:04:05');
    });

    it.each(['2023-02-29T12:00', '2024-02-30T12:00', '2024-04-31T12:00', '1900-02-29T12:00',
        '2024-00-01T12:00', '2024-13-01T12:00', '2024-01-00T12:00', '2024-01-01T24:00',
        '2024-01-01T12:60', '2024-01-01T12:00:60', '0000-01-01T00:00', '2024-1-01T12:00',
        '2024-01-01 12:00', '2024-01-01T12:00Z', '2024-01-01T12:00:00.000', ''])('rejects invalid input %s', (value) => {
        expect(() => parseWallTime(value, 'UTC')).toThrow(RangeError);
    });

    it('rejects nonexistent spring times in each DST zone', () => {
        expect(() => parseWallTime('2024-03-10T02:30', 'America/New_York')).toThrow(/does not exist/);
        expect(() => parseWallTime('2024-03-31T01:30', 'Europe/London')).toThrow(/does not exist/);
        expect(parseWallTime('2024-03-10T03:00', 'America/New_York')).toBe(epoch('2024-03-10T07:00:00Z'));
        expect(parseWallTime('2024-03-31T02:00', 'Europe/London')).toBe(epoch('2024-03-31T01:00:00Z'));
    });

    it('requires an explicit occurrence for repeated fall-back times in both zones', () => {
        for (const [value, zone, earlier, later] of [
            ['2026-11-01T01:15', 'America/New_York', '2026-11-01T05:15:00Z', '2026-11-01T06:15:00Z'],
            ['2026-10-25T01:15', 'Europe/London', '2026-10-25T00:15:00Z', '2026-10-25T01:15:00Z'],
        ]) {
            expect(() => parseWallTime(value!, zone!)).toThrow(/occurrence|offset/);
            expect(parseWallTime(value!, zone!, { occurrence: 'earlier' })).toBe(epoch(earlier!));
            expect(parseWallTime(value!, zone!, { occurrence: 'later' })).toBe(epoch(later!));
        }
    });

    it('exposes real offset choices and preserves the later instant through zone formatting', () => {
        const value = '2026-11-01T01:15';
        expect(wallTimeOccurrences(value, 'America/New_York')).toEqual([
            { time: epoch('2026-11-01T05:15:00Z'), offsetMinutes: -240, label: 'UTC-04:00' },
            { time: epoch('2026-11-01T06:15:00Z'), offsetMinutes: -300, label: 'UTC-05:00' },
        ]);
        const selected = parseWallTime(value, 'America/New_York', { offsetMinutes: -300 });
        expect(selected).toBeGreaterThan(epoch('2026-11-01T06:10:00Z'));
        expect(parseWallTime(wallTimeInput(selected, 'UTC'), 'UTC')).toBe(selected);
        expect(parseWallTime(wallTimeInput(selected, 'America/New_York'), 'America/New_York', { offsetMinutes: -300 })).toBe(selected);
        expect(() => parseWallTime(value, 'America/New_York', { offsetMinutes: 60 })).toThrow(/offset/);
        expect(() => parseWallTime(value, 'America/New_York', { occurrence: 'earlier', offsetMinutes: -300 })).toThrow(/offset|occurrence/);
        expect(wallTimeOccurrences('2026-03-08T02:15', 'America/New_York')).toEqual([]);
        expect(() => parseWallTime('2026-03-08T02:15', 'America/New_York', { occurrence: 'later' })).toThrow(/does not exist/);
        expect(wallTimeOccurrences('2026-01-01T01:15', 'UTC')).toEqual([{ time: epoch('2026-01-01T01:15:00Z'), offsetMinutes: 0, label: 'UTC+00:00' }]);
    });

    it('uses the different US and UK transition dates without leaking offsets between zones', () => {
        for (let index = 0; index < 3; index++) {
            expect(parseWallTime('2024-03-18T09:30', 'America/New_York')).toBe(epoch('2024-03-18T13:30:00Z'));
            expect(parseWallTime('2024-03-18T08:00', 'Europe/London')).toBe(epoch('2024-03-18T08:00:00Z'));
            expect(parseWallTime('2024-04-01T08:00', 'Europe/London')).toBe(epoch('2024-04-01T07:00:00Z'));
        }
    });

    it('rejects invalid epoch values and zones', () => {
        expect(() => wallTimeInput(NaN, 'UTC')).toThrow(RangeError);
        expect(() => wallTimeInput(Infinity, 'UTC')).toThrow(RangeError);
        expect(() => parseWallTime('2024-01-01T12:00', 'Invalid/Zone')).toThrow(RangeError);
        expect(() => wallTimeOccurrences('2024-01-01T12:00', 'Invalid/Zone')).toThrow(RangeError);
        expect(() => parseWallTime('2024-01-01T12:00', 'UTC', { offsetMinutes: NaN })).toThrow(/offset/);
        expect(() => parseWallTime('2024-01-01T12:00', 'UTC', { occurrence: 'automatic' as 'earlier' })).toThrow(/occurrence/);
        expect(() => parseWallTime('2026-07-01T01:15', 'America/New_York', { offsetMinutes: -300 })).toThrow(/offset/);
    });
});

describe('replay time shortcuts', () => {
    it('requires manual occurrence selection when next-day reaches a repeated hour', () => {
        expect(() => nextSessionTime(epoch('2026-10-31T05:15:00Z'), 'next-day', 'America/New_York')).toThrow(/offset|occurrence/);
        expect(() => nextSessionTime(epoch('2026-10-24T00:15:00Z'), 'next-day', 'Europe/London')).toThrow(/offset|occurrence/);
    });
    it('uses today only if the London opening is still strictly ahead', () => {
        expect(nextSessionTime(epoch('2024-04-08T06:59:59Z'), 'london', 'UTC')).toEqual({
            time: epoch('2024-04-08T07:00:00Z'), zone: 'Europe/London', label: 'London 08:00' });
        expect(nextSessionTime(epoch('2024-04-08T07:00:00Z'), 'london', 'UTC').time).toBe(epoch('2024-04-09T07:00:00Z'));
    });

    it('skips the London weekend and applies the spring clock change', () => {
        expect(nextSessionTime(epoch('2024-03-29T08:00:00Z'), 'london', 'America/New_York').time).toBe(epoch('2024-04-01T07:00:00Z'));
    });

    it('skips the New York weekend and applies its separate spring clock change', () => {
        expect(nextSessionTime(epoch('2024-03-08T14:30:00Z'), 'new-york', 'Europe/London')).toEqual({
            time: epoch('2024-03-11T13:30:00Z'), zone: 'America/New_York', label: 'New York 09:30' });
    });

    it('uses the later winter UTC opening after each fall-back transition', () => {
        expect(nextSessionTime(epoch('2024-10-25T07:00:00Z'), 'london', 'UTC').time).toBe(epoch('2024-10-28T08:00:00Z'));
        expect(nextSessionTime(epoch('2024-11-01T13:30:00Z'), 'new-york', 'UTC').time).toBe(epoch('2024-11-04T14:30:00Z'));
    });

    it('keeps next-day wall time across a spring transition instead of adding 24 hours', () => {
        const after = epoch('2024-03-09T14:30:45Z');
        const target = nextSessionTime(after, 'next-day', 'America/New_York');
        expect(target).toEqual({ time: epoch('2024-03-10T13:30:45Z'), zone: 'America/New_York', label: 'Next day' });
        expect(target.time - after).toBe(23 * 60 * 60 * 1000);
    });

    it('keeps next-day wall time across a fall transition', () => {
        const after = epoch('2024-10-26T09:00:00Z');
        const target = nextSessionTime(after, 'next-day', 'Europe/London');
        expect(target.time).toBe(epoch('2024-10-27T10:00:00Z'));
        expect(target.time - after).toBe(25 * 60 * 60 * 1000);
    });

    it('advances a skipped next-day wall time to the first valid minute', () => {
        expect(nextSessionTime(epoch('2024-03-09T07:30:45Z'), 'next-day', 'America/New_York').time).toBe(epoch('2024-03-10T07:00:00Z'));
        expect(nextSessionTime(epoch('2024-03-30T01:30:45Z'), 'next-day', 'Europe/London').time).toBe(epoch('2024-03-31T01:00:00Z'));
    });

    it('handles year and leap-day boundaries, retaining weekends for next-day', () => {
        expect(nextSessionTime(epoch('2023-12-31T23:59:59Z'), 'next-day', 'UTC').time).toBe(epoch('2024-01-01T23:59:59Z'));
        expect(nextSessionTime(epoch('2024-02-28T12:00:00Z'), 'next-day', 'UTC').time).toBe(epoch('2024-02-29T12:00:00Z'));
        expect(nextSessionTime(epoch('2024-02-29T12:00:00Z'), 'next-day', 'UTC').time).toBe(epoch('2024-03-01T12:00:00Z'));
        expect(nextSessionTime(epoch('2024-04-05T12:00:00Z'), 'next-day', 'UTC').time).toBe(epoch('2024-04-06T12:00:00Z'));
    });
});
