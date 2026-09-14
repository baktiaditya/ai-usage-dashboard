import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonLossless } from '@/lib/money';

const ROOT = join(process.cwd(), 'tests', 'fixtures');

export function fixtureText(provider: string, name: string): string {
  return readFileSync(join(ROOT, provider, `${name}.json`), 'utf8');
}

/** Plain `JSON.parse`, for sources that already send decimal strings. */
export function fixtureJson(provider: string, name: string): unknown {
  return JSON.parse(fixtureText(provider, name));
}

/**
 * Parse the way the HTTP layer does, preserving JSON number source text.
 * Required for any fixture whose money arrives as a JSON number.
 */
export function fixtureLossless(provider: string, name: string): unknown {
  return parseJsonLossless(fixtureText(provider, name));
}
