import { describe, expect, it } from 'vitest';
import { ERROR_CODE_HINTS, ERROR_CODES, isRetryable, isUnavailable } from '@/lib/errors';

describe('error code classification', () => {
  it('treats a missing CLI as a setup state: unavailable, not retried, with a hint', () => {
    expect(isUnavailable('cli_not_found')).toBe(true);
    expect(isRetryable('cli_not_found')).toBe(false);
    expect(ERROR_CODE_HINTS.cli_not_found).toContain('PATH');
  });

  it('keeps a CLI that started and failed as an error', () => {
    expect(isUnavailable('process_failed')).toBe(false);
  });

  it('has a hint for every code', () => {
    for (const code of ERROR_CODES) expect(ERROR_CODE_HINTS[code]).toBeTruthy();
  });
});
