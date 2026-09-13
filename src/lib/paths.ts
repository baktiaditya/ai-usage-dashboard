/**
 * User-supplied filesystem paths.
 *
 * Every entry point — the systemd collector, `npm run collect`, the dashboard —
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

/** An XDG base directory, or `fallback` when unset or relative, as the XDG spec requires. */
export function xdgBaseDir(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  return value && isAbsolute(value) ? value : fallback;
}
