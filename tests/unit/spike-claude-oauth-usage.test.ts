import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkContract,
  countWithheldKeys,
  formatHttpFailure,
  isNotEntitledPayload,
  isRealInstant,
  resolveToken,
} from '../../scripts/spike-claude-oauth-usage';

const TOKEN_ENV = 'AUD_TEST_CLAUDE_OAUTH_TOKEN';
const temporaryDirectories: string[] = [];

function options(credentialsPath: string) {
  return {
    credentialsPath,
    tokenEnvName: TOKEN_ENV,
    timeoutMs: 1,
    showLimitKinds: false,
  };
}

function activeLimit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'five_hour',
    group: 'account',
    percent: 25,
    severity: 'ok',
    scope: null,
    is_active: true,
    resets_at: '2026-09-16T23:30:00-02:00',
    ...overrides,
  };
}

afterEach(() => {
  delete process.env[TOKEN_ENV];
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Claude usage spike contract helpers', () => {
  it('accepts real ISO-8601 instants with offsets and rejects impossible calendar dates', () => {
    expect(isRealInstant('2026-09-16T23:30:00-02:00')).toBe(true);
    expect(isRealInstant('2026-02-31T00:00:00Z')).toBe(false);
    expect(isRealInstant('2000-02-29T00:00:00Z')).toBe(true);
    expect(isRealInstant('1900-02-29T00:00:00Z')).toBe(false);
    expect(isRealInstant('2026-09-16T25:00:00Z')).toBe(false);
  });

  it('distinguishes missing nullable fields from fields explicitly set to null', () => {
    expect(checkContract({ limits: [activeLimit({ group: null, scope: null })] })).toEqual([]);

    const incomplete = activeLimit();
    delete incomplete['group'];
    delete incomplete['scope'];
    delete incomplete['resets_at'];

    expect(checkContract({ limits: [incomplete] })).toEqual([
      'limits[0].group is absent',
      'limits[0].scope is absent',
      'limits[0].resets_at is absent',
    ]);
  });

  it('maps absent, empty, and entirely inactive limits to not_entitled', () => {
    const inactive = { is_active: false };

    for (const payload of [{}, { limits: [] }, { limits: [inactive] }]) {
      expect(checkContract(payload)).toEqual([]);
      expect(isNotEntitledPayload(payload)).toBe(true);
    }

    expect(isNotEntitledPayload({ limits: [activeLimit()] })).toBe(false);
  });

  it('counts withheld names in every array row, not only the displayed exemplar', () => {
    const known = new Set(['limits', 'kind']);
    const payload = {
      limits: [
        { kind: 'five_hour', first_unknown: 1 },
        { kind: 'seven_day', second_unknown: 2 },
      ],
    };

    expect(countWithheldKeys(payload, known)).toBe(2);
  });

  it('treats null JSON and whitespace-only file tokens as unusable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aud-spike-token-'));
    temporaryDirectories.push(directory);

    const nullFile = join(directory, 'null.json');
    const whitespaceFile = join(directory, 'whitespace.json');
    writeFileSync(nullFile, 'null');
    writeFileSync(
      whitespaceFile,
      JSON.stringify({ claudeAiOauth: { accessToken: '   ', expiresAt: null } }),
    );

    expect(resolveToken(options(nullFile))).toBeNull();
    expect(resolveToken(options(whitespaceFile))).toBeNull();
  });

  it('trims a file token before using it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aud-spike-token-'));
    temporaryDirectories.push(directory);
    const credentials = join(directory, 'credentials.json');
    writeFileSync(
      credentials,
      JSON.stringify({ claudeAiOauth: { accessToken: '  shaped-test-token  ', expiresAt: 123 } }),
    );

    expect(resolveToken(options(credentials))).toEqual({
      token: 'shaped-test-token',
      origin: credentials,
      expiresAt: 123,
    });
  });

  it('formats an HTTP failure without accepting a provider body', () => {
    expect(formatHttpFailure(500)).toBe('\nFAILED 500\n');
    expect(formatHttpFailure(401)).toContain('FAILED 401');
  });
});
