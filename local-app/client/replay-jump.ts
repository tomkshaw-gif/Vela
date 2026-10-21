import type { Session } from '../shared/types';

export interface ReplayJumpHooks {
    current: () => Pick<Session, 'cursor' | 'status'>;
    advance: (count: number) => Promise<void>;
    shouldStop: () => boolean;
    progress?: (cursor: number) => void;
}

/** Forward jumps use ordinary replay commands so every intervening bar is simulated. */
export async function runReplayJump(targetIndex: number, hooks: ReplayJumpHooks): Promise<'reached' | 'stopped'> {
    if (!Number.isSafeInteger(targetIndex) || targetIndex < 0) throw new Error('Replay target must be a nonnegative integer');
    for (;;) {
        const before = hooks.current();
        if (before.cursor >= targetIndex) return 'reached';
        if (hooks.shouldStop() || before.status !== 'paused') return 'stopped';
        await hooks.advance(Math.min(5000, targetIndex - before.cursor));
        const after = hooks.current();
        if (after.cursor <= before.cursor) throw new Error('Replay did not advance; the jump has stopped');
        hooks.progress?.(after.cursor);
        if (after.cursor >= targetIndex) return 'reached';
        await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
}
