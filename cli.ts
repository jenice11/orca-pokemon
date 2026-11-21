import { execFile, type ExecFileException } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { record } from './model.ts';

function executable(): string {
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND;
  if (process.env.ORCA_DEV_REPO_ROOT) return 'orca-dev';
  if (process.platform === 'darwin') {
    // GUI workers can use a separate Node binary and a PATH without Orca's CLI.
    const candidates: string[] = [
      resolve(dirname(process.execPath), '../Resources/bin/orca'),
      resolve(homedir(), 'Applications/Orca.app/Contents/Resources/bin/orca'),
      '/Applications/Orca.app/Contents/Resources/bin/orca'
    ];
    for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  }
  if (process.platform === 'win32') {
    const localAppData: string = process.env.LOCALAPPDATA ?? resolve(homedir(), 'AppData', 'Local');
    const candidate: string = resolve(localAppData, 'Programs', 'orca', 'resources', 'bin', 'orca.exe');
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === 'linux' ? 'orca-ide' : 'orca';
}

export async function callCli(args: readonly string[]): Promise<unknown> {
  const command: string = executable();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.platform === 'win32' && !env.ORCA_USER_DATA_PATH) {
    env.ORCA_USER_DATA_PATH = resolve(env.APPDATA ?? resolve(homedir(), 'AppData', 'Roaming'), 'orca');
  }
  return new Promise<unknown>((resolveResult, reject): void => {
    execFile(command, [...args, '--environment', 'local', '--json'], {
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env
    }, (error: ExecFileException | null, stdout: string, stderr: string): void => {
      try {
        const response: Record<string, unknown> = record(JSON.parse(stdout));
        if (response.ok !== true || error) {
          const detail: Record<string, unknown> = record(response.error ?? {});
          reject(new Error(`Orca CLI: ${String(detail.code ?? 'command_failed')}. Refresh and try again.`));
          return;
        }
        resolveResult(response.result);
      } catch {
        if (error) {
          const diagnostic: string = stderr.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300);
          const reason: string = String(error.code ?? 'timeout');
          reject(new Error(`Orca CLI ${command} failed (${reason})${diagnostic ? `: ${diagnostic}` : '. Check its installation and PATH.'}`));
          return;
        }
        reject(new Error('Orca CLI returned invalid JSON. Update Orca and try again.'));
      }
    });
  });
}
