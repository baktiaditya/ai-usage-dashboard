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
 * manual check passes. Paths are compared physically and, on macOS,
 * case-insensitively: APFS is case-insensitive, so a user's typed
 * `~/documents` reaches the same protected folder as `~/Documents`.
 */
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { physicalPath } from '../src/lib/installation/install-paths';
import {
  DEFAULT_LABEL_PREFIX,
  collectorLabel,
  plistName,
  webLabel,
} from '../src/lib/launchd-labels';
import { renderPlist } from '../src/lib/launchd-plist';
import type { LaunchdValues } from '../src/lib/launchd-plist';
import { hasControlChar } from '../src/lib/paths';
import { safeErrorMessage } from '../src/lib/redact';
import { UnitValueError } from '../src/lib/unit-template';
import { resolveUnitValues } from '../src/lib/unit-values';

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

/** APFS is case-insensitive, so the comparison must be too. */
const CASE_INSENSITIVE_FS = process.platform === 'darwin';

export interface RenderArgs {
  readonly outDir: string;
  readonly labelPrefix: string;
  readonly logDir: string;
}

export interface ProtectedMatch {
  /** The physical protected root the target lives under. */
  readonly root: string;
  /** The root as a person should read it: `~/Documents`. */
  readonly display: string;
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

/** `realpathSync.native` reports on-disk casing, which `realpathSync` does not. */
function canonical(path: string): string {
  return physicalPath(path, realpathSync.native);
}

/**
 * The protected root `target` resolves under after following symlinks, or
 * `null`. `home` is resolved the same way, so a symlinked home still works.
 */
export function protectedRootFor(
  target: string,
  home: string,
  caseInsensitive: boolean = CASE_INSENSITIVE_FS,
): ProtectedMatch | null {
  const resolved = canonical(target);
  const base = canonical(home);
  const normalise = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);
  const candidate = normalise(resolved);
  for (const name of PROTECTED_DIRNAMES) {
    const root = join(base, name);
    const rootNormalised = normalise(root);
    if (candidate === rootNormalised || candidate.startsWith(`${rootNormalised}${sep}`)) {
      return { root, display: `~${root.slice(base.length)}` };
    }
  }
  return null;
}

/** True when `target` physically equals or lives under one protected root. */
export function isProtectedLocation(
  target: string,
  home: string,
  caseInsensitive?: boolean,
): boolean {
  return protectedRootFor(target, home, caseInsensitive) !== null;
}

export function assertNotProtected(
  name: string,
  target: string,
  home: string,
  caseInsensitive?: boolean,
): void {
  const match = protectedRootFor(target, home, caseInsensitive);
  if (match === null) return;
  throw new UnitValueError(
    `${name} resolves under ${match.display}, which macOS privacy protection denies to launchd-started processes. Move the checkout, data directory, environment file, CODEX_HOME or log directory somewhere else, for example under ~/Workspace. Do not grant Full Disk Access to node: it would cover every script that binary runs`,
  );
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set; run scripts/install-launchd.sh instead`);
  return value;
}

interface AgentSpec {
  readonly label: string;
  readonly file: string;
  readonly template: string;
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

    const collector = collectorLabel(args.labelPrefix);
    const web = webLabel(args.labelPrefix);
    const agents: AgentSpec[] = [
      {
        label: collector,
        file: plistName(collector),
        template: `${DEFAULT_LABEL_PREFIX}.collector.plist.template`,
      },
      {
        label: web,
        file: plistName(web),
        template: `${DEFAULT_LABEL_PREFIX}.web.plist.template`,
      },
    ];
    const common: LaunchdValues = {
      ...values,
      STARTINTERVAL: String(config.collectIntervalMinutes * 60),
      LOGDIR: args.logDir,
    };

    // Render both before writing either, so a refused value never leaves a
    // collector and web plist that disagree.
    const launchdDir = join(values.WORKDIR, 'launchd');
    const rendered = agents.map((agent) => ({
      dest: join(args.outDir, agent.file),
      text: renderPlist(readFileSync(join(launchdDir, agent.template), 'utf8'), {
        ...common,
        LABEL: agent.label,
      }),
    }));

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
        collector,
        plistName(collector),
        web,
        plistName(web),
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
