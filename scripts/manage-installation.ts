#!/usr/bin/env node
/**
 * Managed-installation lifecycle entry point.
 *
 * This file is copied into every release checkout and runs from the active
 * release through the generated launcher. It is deliberately dependency-free:
 * Node 24 strips the TypeScript types at run time, and its static import graph
 * (src/lib/installation/**) uses only the standard library, so it can run on a
 * bare checkout before `pnpm install` has created `node_modules`.
 *
 * Mutating commands re-exec themselves under one exclusive `flock` on the
 * install root's `lifecycle.lock`. Contention fails (exit 75 from flock) before
 * any mutation. The lock sentinel stays in place across uninstall so a reinstall
 * cannot acquire a different lock inode while removal is still running.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { commandPath } from '../src/lib/installation/exec.ts';
import { lockPath } from '../src/lib/installation/install-paths.ts';
import {
  InstallationError,
  rootFromArgsOrEnv,
  runManager,
  type ManagerArgs,
} from '../src/lib/installation/manager.ts';

const HELP = `ai-usage-dashboard — managed installation lifecycle

Usage:
  ai-usage-dashboard update [--version vX.Y.Z] [--dry-run]
  ai-usage-dashboard status
  ai-usage-dashboard uninstall [--dry-run]
  ai-usage-dashboard claude-statusline [status-line installer flags]
  ai-usage-dashboard --help

Managed by scripts/install.sh; environment:
  AUD_INSTALL_ROOT      the managed install root (set by the launcher)
  AUD_INSTALL_REPO_URL  the source repository (defaults to GitHub)
`;

interface Parsed {
  readonly args: ManagerArgs;
  readonly argv: readonly string[];
}

function usageError(message: string): never {
  process.stderr.write(`error: ${message}\n\n${HELP}`);
  process.exit(2);
}

function parse(argv: readonly string[]): Parsed {
  if (argv.length === 0) usageError('a command is required');
  const command = argv[0] as string;
  const allowed = ['install', 'update', 'status', 'uninstall', 'claude-statusline'];
  if (!allowed.includes(command)) usageError(`unknown command ${JSON.stringify(command)}`);
  const rest = argv.slice(1);

  if (command === 'claude-statusline') {
    return {
      args: {
        command: 'claude-statusline',
        installDir: null,
        version: null,
        dryRun: rest.includes('--dry-run'),
        enableLinger: false,
        passthrough: rest,
      },
      argv,
    };
  }

  let installDir: string | null = null;
  let version: string | null = null;
  let dryRun = false;
  let enableLinger = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    switch (arg) {
      case '--install-dir': {
        const value = rest[i + 1];
        if (value === undefined || value.startsWith('--'))
          usageError('--install-dir needs a value');
        installDir = value;
        i += 1;
        break;
      }
      case '--version': {
        if (command !== 'update' && command !== 'install') {
          usageError(`--version is not valid for ${command}`);
        }
        const value = rest[i + 1];
        if (value === undefined || value.startsWith('--')) usageError('--version needs a value');
        version = value;
        i += 1;
        break;
      }
      case '--dry-run':
        if (command !== 'update' && command !== 'uninstall' && command !== 'install') {
          usageError(`--dry-run is not valid for ${command}`);
        }
        dryRun = true;
        break;
      case '--enable-linger':
        if (command !== 'install') usageError('--enable-linger is only valid for install');
        enableLinger = true;
        break;
      default:
        usageError(`unknown argument ${JSON.stringify(arg)}`);
    }
  }

  return {
    args: {
      command: command as ManagerArgs['command'],
      installDir,
      version,
      dryRun,
      enableLinger,
      passthrough: [],
    },
    argv,
  };
}

function withLock(argv: readonly string[], args: ManagerArgs): never {
  const root = rootFromArgsOrEnv(args, process.env);
  if (args.command === 'install') mkdirSync(root, { recursive: true, mode: 0o700 });
  const flock = commandPath('flock', process.env);
  if (flock === null) {
    process.stderr.write('error: flock is required and was not found on PATH\n');
    process.exit(1);
  }
  const result = spawnSync(
    flock,
    [
      '--nonblock',
      '--conflict-exit-code',
      '75',
      lockPath(root),
      process.execPath,
      '--disable-warning=ExperimentalWarning',
      process.argv[1] as string,
      ...argv,
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, AUD_INSTALL_LOCK_HELD: '1' },
    },
  );
  if (result.status === 75) {
    process.stderr.write(
      `error: another managed installation operation is already running for ${root}\n` +
        'Wait for it to finish, then retry. Status is safe to run at any time.\n',
    );
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const { args } = parse(argv);

  if (args.command === 'install') {
    const api = process.env['AUD_INSTALL_MANAGER_API'];
    if (api !== '1') {
      process.stderr.write(
        api === undefined
          ? 'error: install runs through scripts/install.sh; run the bootstrap instead\n'
          : `error: the bootstrap requested manager interface ${JSON.stringify(api)}, but this release speaks interface 1\n`,
      );
      return 1;
    }
  }

  const mutating = args.command !== 'status';
  const rootExists = existsSync(rootFromArgsOrEnv(args, process.env));
  if (mutating && rootExists && process.env['AUD_INSTALL_LOCK_HELD'] !== '1') {
    withLock(argv, args);
  }

  return runManager(args, process.env);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof InstallationError) {
      process.stderr.write(`error: ${err.message}\n`);
      if (err.remedy !== null) process.stderr.write(`remedy: ${err.remedy}\n`);
    } else {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    process.exitCode = 1;
  });
