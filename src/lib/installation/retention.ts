/**
 * Reference-aware retention for managed releases and runtimes.
 *
 * Each release carries its own dependency tree and build, so keeping every
 * release forever would grow without bound. After a committed update, only the
 * active release, the recorded previous release, and whatever an installed unit
 * or an owned Claude bridge still references are retained. Backups are
 * application data and are never pruned here, and pruning never runs while an
 * operation is unfinished.
 *
 * Stdlib-only by design (see `semver.ts`).
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exists, isDirectory } from './atomic.ts';
import { releasesDir } from './install-paths.ts';
import type { ManagedRelease } from './state.ts';

export interface RetentionInput {
  readonly root: string;
  readonly active: ManagedRelease;
  readonly previous: ManagedRelease | null;
  /** Installed owned unit file contents. */
  readonly unitContents: readonly string[];
  /** The state-recorded owned bridge command, if any. */
  readonly bridgeCommand: string | null;
}

export interface RetentionPlan {
  readonly keepReleases: string[];
  readonly pruneReleases: string[];
  readonly keepRuntimes: string[];
  readonly pruneRuntimes: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** SHA release directory names referenced by units or an owned bridge. */
export function referencedReleaseShas(
  input: Omit<RetentionInput, 'active' | 'previous'>,
): Set<string> {
  const pattern = new RegExp(`${escapeRegExp(releasesDir(input.root))}/([0-9a-f]{40})`, 'g');
  const shas = new Set<string>();
  for (const text of [...input.unitContents, input.bridgeCommand ?? '']) {
    for (const match of text.matchAll(pattern)) {
      const sha = match[1];
      if (sha !== undefined) shas.add(sha);
    }
  }
  return shas;
}

/** Runtime directory paths referenced by units or an owned bridge. */
export function referencedRuntimePaths(
  input: Omit<RetentionInput, 'active' | 'previous'>,
): Set<string> {
  const pattern = new RegExp(`${escapeRegExp(join(input.root, 'runtime'))}/node-v[0-9.]+`, 'g');
  const paths = new Set<string>();
  for (const text of [...input.unitContents, input.bridgeCommand ?? '']) {
    for (const match of text.matchAll(pattern)) paths.add(resolve(match[0]));
  }
  return paths;
}

function listDirectories(path: string): string[] {
  if (!exists(path) || !isDirectory(path)) return [];
  try {
    return readdirSync(path)
      .filter((entry) => !entry.startsWith('.'))
      .map((entry) => resolve(join(path, entry)))
      .filter((entry) => {
        // `runtime/current` and similar pointers are symlinks, not releases.
        try {
          if (lstatSync(entry).isSymbolicLink()) return false;
        } catch {
          return false;
        }
        return isDirectory(entry);
      });
  } catch {
    return [];
  }
}

/** Compute what may be pruned after a committed operation. */
export function planRetention(input: RetentionInput): RetentionPlan {
  const referencedShas = referencedReleaseShas(input);
  const referencedRuntimes = referencedRuntimePaths(input);
  const keepShas = new Set<string>([input.active.sha]);
  if (input.previous !== null) keepShas.add(input.previous.sha);

  const releaseDirs = listDirectories(releasesDir(input.root));
  const keepReleases: string[] = [];
  const pruneReleases: string[] = [];
  for (const dir of releaseDirs) {
    const sha = dir.slice(dir.lastIndexOf('/') + 1);
    const keep =
      keepShas.has(sha) ||
      referencedShas.has(sha) ||
      [...referencedShas].some((s) => dir.endsWith(s));
    (keep ? keepReleases : pruneReleases).push(dir);
  }

  const keepRuntimePaths = new Set<string>([resolve(input.active.runtime.path)]);
  if (input.previous !== null) keepRuntimePaths.add(resolve(input.previous.runtime.path));
  for (const path of referencedRuntimes) keepRuntimePaths.add(path);

  const runtimeDirs = listDirectories(join(input.root, 'runtime'));
  const keepRuntimes: string[] = [];
  const pruneRuntimes: string[] = [];
  for (const dir of runtimeDirs) {
    (keepRuntimePaths.has(resolve(dir)) ? keepRuntimes : pruneRuntimes).push(dir);
  }

  return { keepReleases, pruneReleases, keepRuntimes, pruneRuntimes };
}
