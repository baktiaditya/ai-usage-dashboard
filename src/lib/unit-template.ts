/**
 * The template-substitution core both scheduler renderers share.
 *
 * The systemd units and the launchd plists both substitute `__NAME__`
 * placeholders in a single literal pass, so a value is never reinterpreted or
 * rescanned; what differs is the escaping for each format and the set of
 * placeholders a template may use. Only the shared mechanics live here: the
 * error type, the relative-path rule, and the substitution walk. Each renderer
 * keeps its own placeholder list and its own `escape` function.
 */

export class UnitValueError extends Error {
  override readonly name = 'UnitValueError';
}

/**
 * Placeholders naming a file or directory; `PATH` is checked entry by entry.
 * The union of both renderers' path placeholders is safe: a name a given
 * template never uses has no value and is refused anyway.
 */
export const PATH_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'WORKDIR',
  'NODE',
  'TSX',
  'CODEXHOME',
  'DATADIR',
  'ENVFILE',
  'LOGDIR',
]);

export function isRelativePath(name: string, raw: string): boolean {
  if (name === 'PATH') return raw.split(':').some((entry) => !entry.startsWith('/'));
  return PATH_PLACEHOLDERS.has(name) && !raw.startsWith('/');
}

export interface TemplateRenderOptions<P extends string> {
  readonly placeholders: readonly P[];
  /** Names the template family in the unknown-placeholder error. */
  readonly context: string;
  readonly escape: (name: string, raw: string) => string;
}

/** Substitute every `__NAME__` placeholder in one literal pass. */
export function renderTemplate<P extends string>(
  template: string,
  values: Readonly<Partial<Record<P, string>>>,
  options: TemplateRenderOptions<P>,
): string {
  const known = new Set<string>(options.placeholders);
  return template.replace(/__([A-Z]+)__/g, (match, name: string) => {
    if (!known.has(name)) {
      throw new UnitValueError(`unknown placeholder ${match} in ${options.context} template`);
    }
    const raw = values[name as P];
    if (raw === undefined) {
      throw new UnitValueError(`placeholder ${match} has no value in ${options.context} template`);
    }
    return options.escape(name, raw);
  });
}
