/**
 * Rendering the collector's systemd units from their templates.
 *
 * Two escaping layers stand between a configured path and a working unit, and
 * both have bitten: a text substitution tool that reads `&` or its delimiter in
 * the replacement, and systemd itself, which expands `%` specifiers in
 * `Environment=`, `ReadWritePaths=` and `ExecStart=`. Substitution is a single
 * literal pass (the shared walk in `unit-template.ts`), so a value is never
 * reinterpreted or rescanned, and each value is escaped for systemd. Characters
 * that no directive in the unit can carry the same way — whitespace, quotes,
 * backslashes, control characters — are refused with a clear error rather than
 * rendered into a unit that points somewhere else. So is a relative path, which
 * systemd ignores with only a warning — leaving the sandbox without its
 * writable data directory.
 */
import { hasControlChar } from './paths';
import { UnitValueError, isRelativePath, renderTemplate } from './unit-template';

export { UnitValueError } from './unit-template';

export const UNIT_PLACEHOLDERS = [
  'WORKDIR',
  'PATH',
  'CODEXHOME',
  'NODE',
  'TSX',
  'DATADIR',
  'ENVFILE',
  'INTERVAL',
  'HOST',
  'PORT',
] as const;

export type UnitPlaceholder = (typeof UNIT_PLACEHOLDERS)[number];
export type UnitValues = Readonly<Record<UnitPlaceholder, string>>;

function isUnsafe(raw: string): boolean {
  if (/[\s"'\\]/.test(raw)) return true;
  return hasControlChar(raw);
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

/** Substitute every `__NAME__` placeholder in one literal pass. */
export function renderUnit(template: string, values: UnitValues): string {
  return renderTemplate(template, values, {
    placeholders: UNIT_PLACEHOLDERS,
    context: 'unit',
    escape: systemdValue,
  });
}
