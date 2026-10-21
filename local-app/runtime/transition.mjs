export class UpdateDeferred extends Error {}

// Readiness and the final source check happen before touching a working process.
export async function transitionRuntime(previous, next, operations) {
    if (previous) {
        try {
            await operations.prepare(previous);
            if (!(await operations.isCurrent(next))) throw new UpdateDeferred('Source changed while waiting for saved clients.');
        } catch (error) {
            await operations.cancel(previous);
            throw error;
        }
        try { await operations.stop(previous); }
        catch (error) { await operations.cancel(previous); throw error; }
    } else if (!(await operations.isCurrent(next))) throw new UpdateDeferred('Source changed during startup.');
    try {
        return await operations.start(next);
    } catch (error) {
        await operations.stopFailed();
        if (previous) {
            const restored = await operations.start(previous);
            operations.restored(restored);
        }
        throw error;
    }
}
