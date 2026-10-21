export class UpdateDeferred extends Error {}
export interface TransitionOperations<T> {
    prepare(previous: T): Promise<void>;
    isCurrent(next: T): Promise<boolean>;
    cancel(previous: T): Promise<void>;
    stop(previous: T): Promise<void>;
    start(next: T): Promise<T>;
    stopFailed(): Promise<void>;
    restored(previous: T): void;
}
export function transitionRuntime<T>(previous: T | undefined, next: T, operations: TransitionOperations<T>): Promise<T>;
