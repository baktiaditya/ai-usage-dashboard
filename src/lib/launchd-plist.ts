/**
 * Rendering macOS LaunchAgent property lists from their templates.
 *
 * The substitution contract matches `src/lib/systemd-unit.ts`: one literal
 * pass, so a value is never reinterpreted or rescanned. What differs is the
 * escaping. A plist is XML, so `&`, `<`, `>`, `"` and `'` are escaped rather
 * than refused — a path containing them still round-trips through a plist
 * parser. `%` carries no special meaning to launchd and is left alone.
 *
 * Values that no plist can carry usably are refused: an empty value, a
 * control character, and a relative path, which launchd would resolve against
 * an unspecified working directory. `LABEL` and the log directory get the same
 * treatment so a bad `--label-prefix` or `--log-dir` fails before anything is
 * written.
 */
import { UnitValueError } from './systemd-unit';

export const LAUNCHD_PLACEHOLDERS = [
  'LABEL',
  'WORKDIR',
  'PATH',
  'CODEXHOME',
  'NODE',
  'TSX',
  'DATADIR',
  'ENVFILE',
  'INTERVAL',
  'STARTINTERVAL',
  'HOST',
  'PORT',
  'LOGDIR',
] as const;

export type LaunchdPlaceholder = (typeof LAUNCHD_PLACEHOLDERS)[number];
export type LaunchdValues = Readonly<Partial<Record<LaunchdPlaceholder, string>>>;

/** Placeholders naming a file or directory; `PATH` is checked entry by entry. */
const PATH_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'WORKDIR',
  'NODE',
  'TSX',
  'CODEXHOME',
  'DATADIR',
  'ENVFILE',
  'LOGDIR',
]);

function hasControlChar(raw: string): boolean {
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isRelativePath(name: string, raw: string): boolean {
  if (name === 'PATH') return raw.split(':').some((entry) => !entry.startsWith('/'));
  return PATH_PLACEHOLDERS.has(name) && !raw.startsWith('/');
}

/** Escape a value for an XML text node; `&` first so escapes are not double-escaped. */
export function xmlEscape(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** A value as it must appear in a plist, XML-escaped. */
export function launchdValue(name: string, raw: string): string {
  if (raw === '') {
    throw new UnitValueError(`${name} is empty, which a LaunchAgent plist cannot carry`);
  }
  if (hasControlChar(raw)) {
    throw new UnitValueError(
      `${name} contains a control character, which a LaunchAgent plist cannot carry safely: ${JSON.stringify(raw)}`,
    );
  }
  if (isRelativePath(name, raw)) {
    throw new UnitValueError(
      `${name} must be an absolute path; launchd resolves a relative one unpredictably: ${JSON.stringify(raw)}`,
    );
  }
  return xmlEscape(raw);
}

function isPlaceholder(name: string): name is LaunchdPlaceholder {
  return (LAUNCHD_PLACEHOLDERS as readonly string[]).includes(name);
}

/** Substitute every `__NAME__` placeholder in one literal pass. */
export function renderPlist(template: string, values: LaunchdValues): string {
  return template.replace(/__([A-Z]+)__/g, (match, name: string) => {
    if (!isPlaceholder(name)) {
      throw new UnitValueError(`unknown placeholder ${match} in launchd template`);
    }
    const raw = values[name];
    if (raw === undefined) {
      throw new UnitValueError(`placeholder ${match} has no value in launchd template`);
    }
    return launchdValue(name, raw);
  });
}
