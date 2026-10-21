import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopReleaseVersion } from '../local-app/electron/release-version.mjs';

describe('desktop release versions', () => {
    it('keeps the desktop version separate from the library version', () => {
        expect(desktopReleaseVersion('1', '1')).toBe('1.1.1');
        expect(desktopReleaseVersion('42', '3')).toBe('1.42.3');
    });

    it('orders reruns before the next run without a prerelease or build suffix', () => {
        const versions = [desktopReleaseVersion('42', '1'), desktopReleaseVersion('42', '65535'), desktopReleaseVersion('43', '1')];
        expect(versions).toEqual(['1.42.1', '1.42.65535', '1.43.1']);
        for (const version of versions) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('carries the minor into the major at the Windows version boundary', () => {
        expect(desktopReleaseVersion('65535', '65535')).toBe('1.65535.65535');
        expect(desktopReleaseVersion('65536', '1')).toBe('2.0.1');
        expect(desktopReleaseVersion('4294901759', '65535')).toBe('65535.65535.65535');
    });

    it.each([undefined, null, '', '0', '-1', '01', '1.0', '1e2', ' 1', '1\n', '1\nversion=injected', 1])(
        'rejects malformed GitHub counters: %j', value => {
            expect(() => desktopReleaseVersion(value, '1')).toThrow('GITHUB_RUN_NUMBER');
            expect(() => desktopReleaseVersion('1', value)).toThrow('GITHUB_RUN_ATTEMPT');
        },
    );

    it('fails instead of producing overflowing Windows version components', () => {
        expect(() => desktopReleaseVersion('4294901760', '1')).toThrow('Windows desktop version limit');
        expect(() => desktopReleaseVersion('1', '65536')).toThrow('Windows desktop version limit');
        expect(() => desktopReleaseVersion('9007199254740992', '1')).toThrow('Windows desktop version limit');
    });

    it('prints only the version when run by the workflow', () => {
        const result = spawnSync(process.execPath, [resolve('local-app/electron/release-version.mjs')], {
            env: { ...process.env, GITHUB_RUN_NUMBER: '73', GITHUB_RUN_ATTEMPT: '2' }, encoding: 'utf8', timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe('1.73.2');
        expect(result.stderr).toBe('');
    });

    it('exits unsuccessfully without output when a workflow counter is missing', () => {
        const result = spawnSync(process.execPath, [resolve('local-app/electron/release-version.mjs')], {
            env: { ...process.env, GITHUB_RUN_NUMBER: '', GITHUB_RUN_ATTEMPT: '1' }, encoding: 'utf8', timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('GITHUB_RUN_NUMBER must be a positive decimal integer.');
    });
});
