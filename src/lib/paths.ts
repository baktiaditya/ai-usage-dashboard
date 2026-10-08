/**
 * User-supplied filesystem paths.
 *
 * Every entry point — the systemd collector, `pnpm run collect`, the dashboard —
 * must open the same database and read the same credential file. A relative
 * path resolves against whichever directory each process happened to start in,
 * so it is refused rather than resolved. A leading `~/` is expanded, because
 * `collector.env` (unlike a shell) never expands it, and writing `~/…` there is
 * the natural mistake.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export class PathError extends Error {
  override readonly name = 'PathError';
}

/** True when `raw` contains an ASCII control character, DEL included. */
export function hasControlChar(raw: string): boolean {
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** `~/x` becomes `<home>/x`; an absolute path is normalised; anything else throws. */
export function userPath(name: string, raw: string, home: string = homedir()): string {
  const value = raw.trim();
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  if (isAbsolute(value)) return resolve(value);
  throw new PathError(
    `${name} must be an absolute path or start with ~/ (got ${JSON.stringify(raw)}): a relative path would depend on the directory each process starts in`,
  );
}

/**
 * A path as a person should read it: `<home>/x` becomes `~/x`.
 *
 * Only a whole leading home directory is shortened. `/mnt/backup/home/you` and
 * `/home/youngster` stay as they are, and nothing is shortened when the home
 * directory is empty or `/`, where every path would otherwise gain a `~`.
 */
export function displayPath(path: string, home: string = homedir()): string {
  const base = home.replace(/\/+$/, '');
  if (base === '') return path;
  if (path === base) return '~';
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}

/** An XDG base directory, or `fallback` when unset or relative, as the XDG spec requires. */
export function xdgBaseDir(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  return value && isAbsolute(value) ? value : fallback;
}
