import type { ChildProcess } from 'node:child_process';
export function repositoryIdentity(root: string): string;
export function managedIdentity(status: unknown, mode: string, repositoryId: string, instanceId?: string): boolean;
export function claimSingleton(root: string, mode: string, state: () => Record<string, unknown>): Promise<{existing?: Record<string, unknown>; state?: () => Promise<unknown>; close(): Promise<void>}>;
export function openApplication(url: string): void;
export interface OwnedProcess { child: ChildProcess; exited: boolean; code?: number; exit: Promise<void> }
export function stopOwned(owned?: OwnedProcess, updateId?: string, timeout?: number): Promise<void>;
export function startManagedRuntime(options: {root: string; mode: 'run' | 'develop'; open?: boolean}): Promise<void>;
