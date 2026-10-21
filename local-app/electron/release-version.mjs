import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WINDOWS_COMPONENT_LIMIT = 65_535;
const RUNS_PER_MAJOR = WINDOWS_COMPONENT_LIMIT + 1;
const MAX_RUN_NUMBER = WINDOWS_COMPONENT_LIMIT * RUNS_PER_MAJOR - 1;

function positiveInteger(value, name, maximum) {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
        throw new Error(`${name} must be a positive decimal integer.`);
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > maximum) {
        throw new Error(`${name} exceeds the Windows desktop version limit (${maximum}).`);
    }
    return number;
}

/** Stable SemVer ordered by run, then attempt, with Windows-safe numeric components. */
export function desktopReleaseVersion(runNumber, runAttempt) {
    const run = positiveInteger(runNumber, 'GITHUB_RUN_NUMBER', MAX_RUN_NUMBER);
    const attempt = positiveInteger(runAttempt, 'GITHUB_RUN_ATTEMPT', WINDOWS_COMPONENT_LIMIT);
    // Carry into the major instead of overflowing Windows' 16-bit minor version.
    return `${1 + Math.floor(run / RUNS_PER_MAJOR)}.${run % RUNS_PER_MAJOR}.${attempt}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        console.log(desktopReleaseVersion(process.env.GITHUB_RUN_NUMBER, process.env.GITHUB_RUN_ATTEMPT));
    } catch (error) {
        console.error(error instanceof Error ? error.message : 'Could not generate the desktop version.');
        process.exitCode = 1;
    }
}
