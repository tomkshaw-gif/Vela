import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { Command } from '../shared/types';

// Exercise the application's actual queued method without constructing a UI or connecting an API.
const source = ts.createSourceFile('main.ts', readFileSync(new URL('../client/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const studio = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ReplayStudio');
if (!studio || !ts.isClassDeclaration(studio)) throw new Error('ReplayStudio class is missing.');
const method = studio.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === 'command');
if (!method) throw new Error('ReplayStudio.command is missing.');
const compiled = ts.transpileModule(`class CommandHarness { ${method.getText(source)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;

interface Harness {
    command(command: Command, strict?: boolean, expectedRevision?: number): Promise<void>;
    commandQueue: Promise<void>;
    view: { session: { id: string; revision: number } };
    sessionGeneration: number;
    runtimeBlocked: boolean; starting: boolean; disposed: boolean; mutationBusy: boolean; playing: boolean; jumping: boolean;
}

function fixture() {
    const status = { textContent: '', innerHTML: '' };
    const Constructor = new Function('$', 'ApiError', `${compiled}; return CommandHarness;`)(() => status, class extends Error {}) as new () => Harness;
    const harness = new Constructor();
    let release!: () => void;
    harness.commandQueue = new Promise<void>(resolve => { release = resolve; });
    const post = vi.fn(async () => ({ session: { id: 'queue-fixture', revision: 1 } }));
    Object.assign(harness, { view: { session: { id: 'queue-fixture', revision: 0 } }, sessionGeneration: 1,
        runtimeBlocked: false, starting: false, disposed: false, mutationBusy: false, playing: false, jumping: false,
        api: { post }, sessionController: new AbortController(), updateControls: vi.fn(), renderView: vi.fn(),
        updateSummary: vi.fn(), analyticsRefresh: { invalidate: vi.fn(), wake: vi.fn() }, charts: { sync: vi.fn() } });
    return { harness, post, release };
}

describe('chart order command dispatch queue', () => {
    it.each(['runtimeBlocked', 'starting', 'disposed', 'mutationBusy', 'playing', 'jumping'] as const)('rechecks %s after waiting for a preceding command', async flag => {
        const f = fixture();
        const work = f.harness.command({ type: 'amend', orderId: 'pending-fixture', price: 100 }, false, 0);
        f.harness[flag] = true;
        f.release(); await work;
        expect(f.post).not.toHaveBeenCalled();
    });

    it('posts one current unlocked amendment and keeps its expected revision', async () => {
        const f = fixture(); const command: Command = { type: 'amend', orderId: 'pending-fixture', price: 100 };
        const work = f.harness.command(command, false, 0); f.release(); await work;
        expect(f.post).toHaveBeenCalledExactlyOnceWith('/api/sessions/queue-fixture/command', { expectedRevision: 0, command }, expect.any(AbortSignal));
    });

    it('rejects a revision change while preserving playback-driven source advancement', async () => {
        const f = fixture();
        const amendment = f.harness.command({ type: 'cancel', orderId: 'pending-fixture' }, false, 0);
        f.harness.view.session.revision = 1; f.release(); await amendment;
        expect(f.post).not.toHaveBeenCalled();
        f.harness.playing = true;
        await f.harness.command({ type: 'advance', count: 1 });
        expect(f.post).toHaveBeenCalledTimes(1);
    });
});
