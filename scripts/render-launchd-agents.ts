#!/usr/bin/env tsx
/**
 * Render the collector's macOS LaunchAgents into a directory.
 *
 *   tsx scripts/render-launchd-agents.ts <output-dir> \
 *     [--label-prefix <prefix>] [--log-dir <absolute-path>]
 *
 * `scripts/install-launchd.sh` calls this with the interpreter paths it
 * resolved (`AUD_UNIT_WORKDIR`, `AUD_UNIT_PATH`, `AUD_UNIT_CODEXHOME`,
 * `AUD_UNIT_NODE`, `AUD_UNIT_TSX`) and forwards `--label-prefix` and
 * `--log-dir`. It derives `<prefix>.collector` and `<prefix>.web` once and
 * renders both templates from `launchd/` in the checkout, writing
 * `<prefix>.collector.plist` and `<prefix>.web.plist` with mode 0600.
 *
 * On success it prints, one per line, the environment file, the data
 * directory, the interval, the host, the port, the two labels and the two
 * rendered file names, so the installer and the renderer agree on every value.
 *
 * The protected-location refusal lives here, not in shell, so it can be unit
 * tested with an injected home directory. macOS privacy protection (TCC)
 * denies launchd-started processes access to Desktop, Documents, Downloads,
 * and iCloud Drive even though Terminal can read them; a job whose working
 * directory sits there fails with `Operation not permitted` while every
 * manual check passes. Paths are compared physically, so a symlink into a
 * protected folder is refused too.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { physicalPath } from '../src/lib/installation/install-paths';
import { renderPlist } from '../src/lib/launchd-plist';
import type { LaunchdValues } from '../src/lib/launchd-plist';
import { safeErrorMessage } from '../src/lib/redact';
import { UnitValueError } from '../src/lib/systemd-unit';
import { resolveUnitValues } from '../src/lib/unit-values';

export const DEFAULT_LABEL_PREFIX = 'io.github.baktiaditya.ai-usage-dashboard';

/** The default log directory, resolved under the injected home directory. */
export function defaultLogDir(home: string): string {
  return join(home, 'Library', 'Logs', 'ai-usage-dashboard');
}

const LABEL_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Directories whose whole subtree macOS denies to launchd-started processes. */
const PROTECTED_DIRNAMES = [
  'Desktop',
  'Documents',
  'Downloads',
  join('Library', 'Mobile Documents'),
];

export interface RenderArgs {
  readonly outDir: string;
  readonly labelPrefix: string;
  readonly logDir: string;
}

function hasControlChar(raw: string): boolean {
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function validateLabelPrefix(raw: string): void {
  if (raw === '') {
    throw new UnitValueError('--label-prefix must not be empty');
  }
  if (hasControlChar(raw)) {
    throw new UnitValueError('--label-prefix must not contain a control character');
  }
  if (!LABEL_PREFIX_PATTERN.test(raw)) {
    throw new UnitValueError(
      `--label-prefix may only contain letters, digits, '.', '_' and '-', and must start with a letter or digit: ${JSON.stringify(raw)}`,
    );
  }
}

/** Parse renderer arguments, refusing every invalid value before any write. */
export function parseRenderArgs(argv: readonly string[], home: string): RenderArgs {
  let outDir: string | undefined;
  let labelPrefix = DEFAULT_LABEL_PREFIX;
  let logDir: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--label-prefix' || arg === '--log-dir') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new UnitValueError(`${arg} requires a value`);
      }
      i += 1;
      if (arg === '--label-prefix') labelPrefix = value;
      else logDir = value;
    } else if (arg.startsWith('--')) {
      throw new UnitValueError(`unknown argument: ${arg}`);
    } else if (outDir === undefined) {
      outDir = arg;
    } else {
      throw new UnitValueError(`unexpected argument: ${arg}`);
    }
  }

  if (outDir === undefined || outDir === '') {
    throw new UnitValueError(
      'usage: tsx scripts/render-launchd-agents.ts <output-dir> [--label-prefix <prefix>] [--log-dir <absolute-path>]',
    );
  }
  validateLabelPrefix(labelPrefix);

  const log = logDir ?? defaultLogDir(home);
  if (!isAbsolute(log)) {
    throw new UnitValueError(
      `--log-dir must be an absolute path, since launchd does not expand '~' (got ${JSON.stringify(log)})`,
    );
  }
  if (hasControlChar(log)) {
    throw new UnitValueError('--log-dir must not contain a control character');
  }
  return { outDir, labelPrefix, logDir: log };
}

/** The protected roots under `home`, physical so a symlinked home is handled too. */
export function protectedRoots(home: string): string[] {
  const base = physicalPath(home);
  return PROTECTED_DIRNAMES.map((name) => join(base, name));
}

/** True when `target` physically equals or lives under one protected root. */
export function isProtectedLocation(target: string, home: string): boolean {
  const resolved = physicalPath(target);
  return protectedRoots(home).some(
    (root) => resolved === root || resolved.startsWith(root.endsWith(sep) ? root : `${root}${sep}`),
  );
}

function displayProtected(target: string, home: string): string {
  const root = protectedRoots(home).find(
    (candidate) =>
      physicalPath(target) === candidate || physicalPath(target).startsWith(`${candidate}${sep}`),
  );
  const base = physicalPath(home);
  if (root === undefined) return target;
  return `~${root.slice(base.length)}`;
}

export function assertNotProtected(name: string, target: string, home: string): void {
  if (!isProtectedLocation(target, home)) return;
  throw new UnitValueError(
    `${name} resolves under ${displayProtected(target, home)}, which macOS privacy protection denies to launchd-started processes. Move the checkout, data directory, environment file, CODEX_HOME or log directory somewhere else, for example under ~/Workspace. Do not grant Full Disk Access to node: it would cover every script that binary runs`,
  );
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set; run scripts/install-launchd.sh instead`);
  return value;
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  try {
    const home = env['HOME']?.trim() ? env['HOME'] : homedir();
    const args = parseRenderArgs(argv, home);

    const { envFile, config, values } = resolveUnitValues({
      env,
      workdir: required(env, 'AUD_UNIT_WORKDIR'),
      path: required(env, 'AUD_UNIT_PATH'),
      codexHome: required(env, 'AUD_UNIT_CODEXHOME'),
      node: required(env, 'AUD_UNIT_NODE'),
      tsx: required(env, 'AUD_UNIT_TSX'),
    });

    for (const [name, target] of [
      ['the checkout', values.WORKDIR],
      ['the data directory', config.dataDir],
      ['the environment file', envFile],
      ['CODEX_HOME', values.CODEXHOME],
      ['the log directory', args.logDir],
    ] as const) {
      assertNotProtected(name, target, home);
    }

    const collectorLabel = `${args.labelPrefix}.collector`;
    const webLabel = `${args.labelPrefix}.web`;
    const collectorFile = `${collectorLabel}.plist`;
    const webFile = `${webLabel}.plist`;
    const common: LaunchdValues = {
      ...values,
      STARTINTERVAL: String(config.collectIntervalMinutes * 60),
      LOGDIR: args.logDir,
    };

    // Render both before writing either, so a refused value never leaves a
    // collector and web plist that disagree.
    const launchdDir = join(values.WORKDIR, 'launchd');
    const rendered = [
      {
        dest: join(args.outDir, collectorFile),
        text: renderPlist(
          readFileSync(
            join(launchdDir, `${DEFAULT_LABEL_PREFIX}.collector.plist.template`),
            'utf8',
          ),
          { ...common, LABEL: collectorLabel },
        ),
      },
      {
        dest: join(args.outDir, webFile),
        text: renderPlist(
          readFileSync(join(launchdDir, `${DEFAULT_LABEL_PREFIX}.web.plist.template`), 'utf8'),
          { ...common, LABEL: webLabel },
        ),
      },
    ];

    mkdirSync(args.outDir, { recursive: true, mode: 0o700 });
    for (const { dest, text } of rendered) {
      writeFileSync(dest, text, { mode: 0o600 });
      chmodSync(dest, 0o600);
    }

    process.stdout.write(
      [
        envFile,
        config.dataDir,
        config.collectIntervalMinutes,
        config.host,
        config.port,
        collectorLabel,
        basename(collectorFile),
        webLabel,
        basename(webFile),
      ].join('\n') + '\n',
    );
    return 0;
  } catch (err) {
    process.stderr.write(`could not render the launchd agents: ${safeErrorMessage(err)}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
