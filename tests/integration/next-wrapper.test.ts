import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WRAPPER = join(process.cwd(), 'scripts', 'next.ts');
const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

describe('the Next.js wrapper keeps the validated bind address', () => {
  it.each([
    ['--port', '3999'],
    ['--port=3999'],
    ['-p', '3999'],
    ['-p3999'],
    ['--hostname', '127.0.0.2'],
    ['--hostname=127.0.0.2'],
    ['-H', '127.0.0.2'],
  ])('refuses a passed-through %s before starting a server', (...flag) => {
    // A regression would start a server; the timeout turns that into a failure
    // instead of a hung test.
    const r = spawnSync(process.execPath, [TSX, WRAPPER, 'start', ...flag], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('set AUD_HOST / AUD_PORT instead');
  });
});
