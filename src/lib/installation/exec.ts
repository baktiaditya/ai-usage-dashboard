/**
 * Child-process execution for the managed-installation manager.
 *
 * Every child runs with stdin connected to `/dev/null`. In the
 * `curl … | bash` bootstrap the rest of the script is still on stdin, so a
 * child that reads it would consume the bootstrap; no lifecycle step may ever
 * inherit that pipe.
 *
 * Stdlib-only by design (see `semver.ts`).
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export class CommandError extends Error {
  override readonly name = 'CommandError';
  readonly command: string;
  readonly status: number | null;
  readonly stderr: string;

  constructor(command: string, status: number | null, stderr: string) {
    super(
      `${command} exited with status ${status === null ? 'null (signal)' : status}${
        stderr.trim() === '' ? '' : `: ${stderr.trim()}`
      }`,
    );
    this.command = command;
    this.status = status;
    this.stderr = stderr;
  }
}

export interface RunResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: NodeJS.ErrnoException;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly input?: string;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** Run a command, capturing output; stdin is /dev/null. */
export function run(command: string, args: readonly string[], options: RunOptions = {}): RunResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error as NodeJS.ErrnoException | undefined,
  };
}

/** Run a command with inherited stdout/stderr; stdin is /dev/null. */
export function runLive(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): RunResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: '',
    stderr: '',
    error: result.error as NodeJS.ErrnoException | undefined,
  };
}

/** Run a command and throw `CommandError` on any non-zero outcome. */
export function runOrThrow(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): RunResult {
  const result = run(command, args, options);
  const label = [command, ...args].join(' ');
  if (result.error) throw new CommandError(label, result.status, result.error.message);
  if (result.status !== 0) throw new CommandError(label, result.status, result.stderr);
  return result;
}

/** `command -v` without a shell: search PATH for an executable file. */
export function commandPath(
  command: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (command.includes('/')) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, command);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** Parse a JSON document a child printed on stdout, with a labelled error. */
export function parseJsonOutput<T>(result: RunResult, label: string): T {
  const text = result.stdout.trim();
  if (text === '') throw new CommandError(`${label} printed no JSON`, result.status, result.stderr);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new CommandError(
      `${label} printed invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      result.status,
      result.stderr,
    );
  }
}
