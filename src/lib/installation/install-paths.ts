/**
 * Managed-installation paths and ownership boundaries.
 *
 * The install root is separate from the application data directory by default,
 * and `--install-dir` must be absolute. Paths that a systemd unit cannot carry
 * (whitespace, quotes, backslashes, control characters) are refused up front so
 * an installation cannot half-succeed and then fail at unit rendering.
 *
 * Stdlib-only by design (see `semver.ts`).
 */
import { readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { exists, isAtomicTempName, isDirectory, errorText } from './atomic.ts';
import { JOURNAL_FILE, LOCK_FILE, OWNERSHIP_FILE, STATE_FILE } from './state.ts';

export class InstallPathError extends Error {
  override readonly name = 'InstallPathError';
}

export const INSTALL_ROOT_DIRNAME = 'ai-usage-dashboard-install';
export const LAUNCHER_NAME = 'ai-usage-dashboard';
export const RUNTIME_DIRNAME = 'runtime';
export const RELEASES_DIRNAME = 'releases';
export const CACHE_DIRNAME = 'cache';

function fail(message: string): never {
  throw new InstallPathError(message);
}

/**
 * Reject a value no managed path may contain: an empty string, whitespace, a
 * quote, a backslash, or a control character. `%` is allowed — systemd
 * rendering escapes it — and so are `&` and `|`.
 */
export function assertSafePathValue(name: string, value: string): void {
  if (value === '') fail(`${name} is empty`);
  if (/[\s"'\\]/.test(value)) {
    fail(
      `${name} contains whitespace, a quote, or a backslash, which a systemd unit cannot carry safely: ${JSON.stringify(value)}`,
    );
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      fail(`${name} contains a control character: ${JSON.stringify(value)}`);
    }
  }
}

/** An absolute path with no trailing separator (except `/`). */
export function normaliseAbsolute(name: string, value: string): string {
  if (!isAbsolute(value)) fail(`${name} must be an absolute path (got ${JSON.stringify(value)})`);
  const normalised = resolve(value);
  assertSafePathValue(name, normalised);
  return normalised;
}

/** The default root: `$XDG_DATA_HOME/ai-usage-dashboard-install` or `~/.local/share/…`. */
export function defaultInstallRoot(env: Record<string, string | undefined>): string {
  const xdg = env['XDG_DATA_HOME']?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'share');
  return join(base, INSTALL_ROOT_DIRNAME);
}

export function launcherPathFor(): string {
  const home = homedir();
  return join(home, '.local', 'bin', LAUNCHER_NAME);
}

export function releasesDir(root: string): string {
  return join(root, RELEASES_DIRNAME);
}

export function releaseDir(root: string, sha: string): string {
  return join(releasesDir(root), sha);
}

export function runtimeDir(root: string, nodeVersion: string): string {
  return join(root, RUNTIME_DIRNAME, `node-v${nodeVersion}`);
}

export function cacheDir(root: string): string {
  return join(root, CACHE_DIRNAME);
}

export function statePath(root: string): string {
  return join(root, STATE_FILE);
}

export function journalPath(root: string): string {
  return join(root, 'operation.json');
}

export function ownershipPath(root: string): string {
  return join(root, OWNERSHIP_FILE);
}

export function lockPath(root: string): string {
  return join(root, LOCK_FILE);
}

/** True when `child` equals or lives under `parent`. */
export function isInside(child: string, parent: string): boolean {
  const normalChild = resolve(child);
  const normalParent = resolve(parent);
  if (normalChild === normalParent) return true;
  return normalChild.startsWith(
    normalParent.endsWith(sep) ? normalParent : `${normalParent}${sep}`,
  );
}

/**
 * Resolve a path to its physical location, following symlinks in the longest
 * existing prefix; the missing tail is appended unresolved. A path whose last
 * component (or any ancestor) symlinks elsewhere therefore reports where it
 * really lives, not where it is named.
 */
export function physicalPath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return suffix.length === 0 ? real : join(real, ...suffix);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * True when `child` physically equals or lives under `parent` after resolving
 * symlinks. This is the boundary that matters before deleting an install root:
 * a dataset outside the root that symlinks back inside it is inside it.
 */
export function isPhysicallyInside(child: string, parent: string): boolean {
  return isInside(physicalPath(child), physicalPath(parent));
}

export type RootKind = 'absent' | 'empty-managed' | 'managed' | 'occupied' | 'partial';

/**
 * Classify a root without writing anything.
 *
 * - `absent` — no directory.
 * - `empty-managed` — missing, empty, or holding only the recognised lock
 *   sentinel and ownership record; eligible for a fresh install.
 * - `managed` — `state.json` exists.
 * - `partial` — no state, but recognisable managed directories (`releases`,
 *   `runtime`, `cache`) or our launcher marker; recoverable, not foreign.
 * - `occupied` — anything else; never adopted.
 */
export function classifyRoot(root: string): RootKind {
  if (!exists(root)) return 'absent';
  if (!isDirectory(root)) fail(`the install root ${root} exists and is not a directory`);
  let entries: string[];
  try {
    entries = readdirSync(root).filter((entry) => !isAtomicTempName(entry));
  } catch (err) {
    fail(`cannot read the install root ${root}: ${errorText(err)}`);
  }
  if (entries.length === 0) return 'empty-managed';
  const allowedEmpty = new Set([LOCK_FILE, OWNERSHIP_FILE]);
  const partial = new Set([
    RUNTIME_DIRNAME,
    RELEASES_DIRNAME,
    CACHE_DIRNAME,
    JOURNAL_FILE,
    'current',
  ]);
  if (entries.includes(STATE_FILE)) return 'managed';
  if (entries.every((entry) => allowedEmpty.has(entry))) return 'empty-managed';
  if (entries.every((entry) => allowedEmpty.has(entry) || partial.has(entry))) return 'partial';
  return 'occupied';
}
