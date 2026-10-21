import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { AppError } from './errors';

const FILENAME = 'provider-key.dpapi';
function validKey(key: unknown): string {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(key)) throw new AppError(400, 'Invalid provider key.');
    return key;
}
async function dpapi(mode: 'protect' | 'unprotect', value: string): Promise<string> {
    if (process.platform !== 'win32') throw new AppError(400, 'Encrypted key storage requires Windows. Set DATABENTO_API_KEY in the server environment instead.');
    // The program is fixed. The credential travels over stdin, never command arguments.
    const script = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $o=[Security.Cryptography.ProtectedData]::${mode === 'protect' ? 'Protect' : 'Unprotect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))`;
    return new Promise((resolveResult, reject) => {
        const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let result = ''; let size = 0;
        const timer = setTimeout(() => { child.kill(); reject(new AppError(500, 'Credential encryption timed out.')); }, 10_000);
        child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8192) child.kill(); else result += chunk.toString(); });
        child.stderr.resume();
        child.on('error', () => { clearTimeout(timer); reject(new AppError(500, 'Credential encryption is unavailable.')); });
        child.on('close', code => { clearTimeout(timer); if (code !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(result) || size > 8192) reject(new AppError(500, 'Credential encryption failed.')); else resolveResult(result); });
        child.stdin.on('error', () => {}); child.stdin.end(value);
    });
}
export async function saveDatabentoKey(dataDirectory: string, apiKey: string): Promise<void> {
    const key = validKey(apiKey);
    const encrypted = await dpapi('protect', Buffer.from(key).toString('base64'));
    await mkdir(resolve(dataDirectory), { recursive: true, mode: 0o700 });
    const temporary = join(resolve(dataDirectory), `${FILENAME}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
        await rename(temporary, join(resolve(dataDirectory), FILENAME));
    } finally { await rm(temporary, { force: true }); }
}
export async function loadDatabentoKey(dataDirectory: string): Promise<string | undefined> {
    if (process.env.DATABENTO_API_KEY) return validKey(process.env.DATABENTO_API_KEY);
    let stored: string;
    try { stored = await readFile(join(resolve(dataDirectory), FILENAME), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new AppError(500, 'Unable to read encrypted provider settings.'); }
    if (stored.length > 8192) throw new AppError(500, 'Invalid encrypted provider settings.');
    const decrypted = await dpapi('unprotect', stored);
    return validKey(Buffer.from(decrypted, 'base64').toString('utf8'));
}
