/**
 * Rendering the collector's systemd units from their templates.
 *
 * Two escaping layers stand between a configured path and a working unit, and
 * both have bitten: a text substitution tool that reads `&` or its delimiter in
 * the replacement, and systemd itself, which expands `%` specifiers in
 * `Environment=`, `ReadWritePaths=` and `ExecStart=`. Substitution here is a
 * single literal pass, so a value is never reinterpreted or rescanned, and each
 * value is escaped for systemd. Characters that no directive in the unit can
 * carry the same way — whitespace, quotes, backslashes, control characters —
 * are refused with a clear error rather than rendered into a unit that points
 * somewhere else. So is a relative path, which systemd ignores with only a
 * warning — leaving the sandbox without its writable data directory.
 */

export const UNIT_PLACEHOLDERS = [
  'WORKDIR',
  'PATH',
  'CODEXHOME',
  'NODE',
  'TSX',
  'DATADIR',
  'ENVFILE',
  'INTERVAL',
] as const;

export type UnitPlaceholder = (typeof UNIT_PLACEHOLDERS)[number];
export type UnitValues = Readonly<Record<UnitPlaceholder, string>>;

export class UnitValueError extends Error {
  override readonly name = 'UnitValueError';
}

function isUnsafe(raw: string): boolean {
  if (/[\s"'\\]/.test(raw)) return true;
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Placeholders naming a file or directory; `PATH` is checked entry by entry. */
const PATH_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'WORKDIR',
  'NODE',
  'TSX',
  'CODEXHOME',
  'DATADIR',
  'ENVFILE',
]);

function isRelativePath(name: string, raw: string): boolean {
  if (name === 'PATH') return raw.split(':').some((entry) => !entry.startsWith('/'));
  return PATH_PLACEHOLDERS.has(name) && !raw.startsWith('/');
}

/** A value as it must appear in a unit file, with `%` escaped as `%%`. */
export function systemdValue(name: string, raw: string): string {
  if (raw === '' || isUnsafe(raw)) {
    throw new UnitValueError(
      `${name} is empty or contains whitespace, a quote, a backslash or a control character, which a systemd unit cannot carry safely: ${JSON.stringify(raw)}`,
    );
  }
  if (isRelativePath(name, raw)) {
    throw new UnitValueError(
      `${name} must be an absolute path; systemd ignores a relative one: ${JSON.stringify(raw)}`,
    );
  }
  return raw.replaceAll('%', '%%');
}

function isPlaceholder(name: string): name is UnitPlaceholder {
  return (UNIT_PLACEHOLDERS as readonly string[]).includes(name);
}

/** Substitute every `__NAME__` placeholder in one literal pass. */
export function renderUnit(template: string, values: UnitValues): string {
  return template.replace(/__([A-Z]+)__/g, (match, name: string) => {
    if (!isPlaceholder(name)) {
      throw new UnitValueError(`unknown placeholder ${match} in unit template`);
    }
    return systemdValue(name, values[name]);
  });
}
