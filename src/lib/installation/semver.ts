/**
 * Numeric SemVer handling for managed release tags.
 *
 * Release tags are `vMAJOR.MINOR.PATCH` only: a prerelease, a build suffix, or
 * anything malformed is never eligible, and selection compares numbers rather
 * than strings (`v0.10.0` is newer than `v0.9.0`).
 *
 * Stdlib-only by design: the managed installation manager runs on a bare
 * release checkout, before `pnpm install` has created `node_modules`.
 */

export const STABLE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface StableVersion {
  readonly tag: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Parse `vX.Y.Z`; anything else (prerelease, prefix, suffix) returns null. */
export function parseStableTag(tag: string): StableVersion | null {
  const match = STABLE_TAG_PATTERN.exec(tag);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return { tag, major, minor, patch };
}

/** Order two parsed versions numerically. */
export function compareVersions(a: StableVersion, b: StableVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * The highest stable tag among `tags`, or null when none is stable.
 * Lexical sorting is explicitly not used.
 */
export function pickHighestStableTag(tags: readonly string[]): string | null {
  let best: StableVersion | null = null;
  for (const tag of tags) {
    const parsed = parseStableTag(tag);
    if (parsed === null) continue;
    if (best === null || compareVersions(parsed, best) > 0) best = parsed;
  }
  return best?.tag ?? null;
}

/** Compare two tag strings; malformed tags sort below any stable tag. */
export function compareTagStrings(a: string, b: string): number {
  const left = parseStableTag(a);
  const right = parseStableTag(b);
  if (left === null && right === null) return a < b ? -1 : a > b ? 1 : 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareVersions(left, right);
}
