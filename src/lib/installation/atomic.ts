/**
 * Atomic metadata writes and strict JSON reads.
 *
 * Managed metadata is parsed as data, never sourced by a shell, and is written
 * through a temporary file in the same directory followed by `rename(2)` so a
 * crash never leaves a half-written state or journal. Modes are owner-only.
 *
 * Stdlib-only by design (see `semver.ts`).
 */
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export class MetadataError extends Error {
  override readonly name = 'MetadataError';
}

/** Write `data` to `path` (mode `0600`) through a temp file and an atomic rename. */
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(temp, 'w', mode);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

/**
 * Parse a JSON file with a caller-supplied validator. A missing file returns
 * null; unreadable or invalid content throws `MetadataError` with the label and
 * path, because a corrupt state file must be diagnosed rather than replaced.
 */
export function readJsonFile<T>(
  path: string,
  label: string,
  validate: (value: unknown) => T,
): T | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new MetadataError(`could not read ${label} at ${path}: ${errorText(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new MetadataError(`${label} at ${path} is not valid JSON: ${errorText(err)}`);
  }
  try {
    return validate(parsed);
  } catch (err) {
    throw new MetadataError(`${label} at ${path} is invalid: ${errorText(err)}`);
  }
}

/** Replace `linkPath` with an atomic symlink to `target`. */
export function writeSymlinkAtomic(linkPath: string, target: string): void {
  const dir = dirname(linkPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${process.pid}.${Date.now()}.lnk`);
  rmSync(temp, { force: true });
  symlinkSync(target, temp);
  try {
    renameSync(temp, linkPath);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** Remove a file, ignoring a missing one. */
export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Whether a directory exists and is a directory (following symlinks). */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `path` exists at all. */
export function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
