/**
 * The production LaunchAgent label names, in one place.
 *
 * `scripts/install-launchd.sh` cannot import TypeScript, so it keeps the same
 * default prefix as a shell constant. When either changes, change both.
 */
export const DEFAULT_LABEL_PREFIX = 'io.github.baktiaditya.ai-usage-dashboard';

export function collectorLabel(prefix: string = DEFAULT_LABEL_PREFIX): string {
  return `${prefix}.collector`;
}

export function webLabel(prefix: string = DEFAULT_LABEL_PREFIX): string {
  return `${prefix}.web`;
}

export function plistName(label: string): string {
  return `${label}.plist`;
}
