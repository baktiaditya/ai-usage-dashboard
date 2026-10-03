/**
 * Shared timestamp formatting for backup and metadata file names.
 *
 * Stdlib-only: the managed installation manager runs on a bare release
 * checkout, before `pnpm install` has created `node_modules`.
 */

/** `2026-09-14T01:02:03.456Z` becomes `20260914T010203456Z`: sortable and file-name safe. */
export function backupStamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, '');
}
