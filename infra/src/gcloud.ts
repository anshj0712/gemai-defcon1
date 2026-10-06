import { spawnSync } from 'node:child_process';

export interface CmdResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

const isWindows = process.platform === 'win32';

/** cmd.exe needs quoting for spaces and metacharacters; our arguments never contain double quotes. */
export function quoteForCmd(arg: string): string {
  return /[\s&|<>^()%!,;=]/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Runs gcloud or bq. On Windows these are .cmd shims, which Node can only start through a shell,
 * so arguments are quoted for cmd.exe. Secret values go through stdin, never the command line.
 */
export function run(cmd: 'gcloud' | 'bq', args: string[], opts: { input?: string } = {}): CmdResult {
  const r = spawnSync(isWindows ? `${cmd}.cmd` : cmd, isWindows ? args.map(quoteForCmd) : args, {
    encoding: 'utf8',
    shell: isWindows,
    windowsHide: true,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim() || (r.error?.message ?? ''),
  };
}

export function hasGcloud(): boolean {
  return run('gcloud', ['--version']).ok;
}

/** Printable form of a command, for dry runs and error messages. */
export function describe(cmd: string, args: string[]): string {
  return [cmd, ...args.map(quoteForCmd)].join(' ');
}
