import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAUNCHD_PLACEHOLDERS, launchdValue, renderPlist, xmlEscape } from '@/lib/launchd-plist';
import {
  assertNotProtected,
  defaultLogDir,
  parseRenderArgs,
  protectedRootFor,
  validateLabelPrefix,
} from '../../scripts/render-launchd-agents';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aud-launchd-unit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('plist value escaping', () => {
  it('escapes every XML metacharacter and leaves % literal', () => {
    expect(xmlEscape(`a&b<c>d"e'f%g`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f%g');
    expect(launchdValue('DATADIR', `/tmp/a&b<c>d"e'f%g`)).toBe(
      '/tmp/a&amp;b&lt;c&gt;d&quot;e&apos;f%g',
    );
  });

  it('escapes & first so an escape is not double-escaped', () => {
    expect(xmlEscape('&amp;')).toBe('&amp;amp;');
  });

  it('allows whitespace, quotes and backslashes that XML can carry', () => {
    expect(launchdValue('LABEL', 'a b')).toBe('a b');
    expect(launchdValue('LABEL', "a'b\\c")).toBe('a&apos;b\\c');
  });

  it('refuses an empty value or one with a control character', () => {
    expect(() => launchdValue('DATADIR', '')).toThrow(/empty/);
    expect(() => launchdValue('DATADIR', `/tmp/a\u0007b`)).toThrow(/control character/);
    expect(() => launchdValue('DATADIR', `/tmp/a\u001fb`)).toThrow(/control character/);
  });

  it('refuses relative paths, including one PATH entry', () => {
    for (const name of ['WORKDIR', 'NODE', 'TSX', 'CODEXHOME', 'DATADIR', 'ENVFILE', 'LOGDIR']) {
      expect(() => launchdValue(name, 'relative/path'), name).toThrow(/absolute path/);
    }
    expect(() => launchdValue('PATH', '/usr/bin:bin')).toThrow(/absolute path/);
    expect(launchdValue('PATH', '/usr/bin:/bin')).toBe('/usr/bin:/bin');
  });
});

describe('renderPlist', () => {
  it('substitutes every placeholder in one literal pass', () => {
    const template =
      '<string>__WORKDIR__/scripts/collect.ts</string><integer>__STARTINTERVAL__</integer>';
    expect(renderPlist(template, { WORKDIR: '/opt/aud & co', STARTINTERVAL: '300' })).toBe(
      '<string>/opt/aud &amp; co/scripts/collect.ts</string><integer>300</integer>',
    );
  });

  it('refuses an unknown placeholder', () => {
    expect(() => renderPlist('<string>__NOPE__</string>', {})).toThrow(/unknown placeholder/);
  });

  it('refuses a placeholder left without a value', () => {
    expect(() => renderPlist('<string>__HOST__</string>', { PORT: '3838' })).toThrow(
      /has no value/,
    );
  });

  it('names every placeholder the launchd templates use', () => {
    // The renderer and installer must agree on the set; a new one here without
    // a value at the call site fails the "has no value" refusal above.
    expect(LAUNCHD_PLACEHOLDERS).toContain('STARTINTERVAL');
    expect(LAUNCHD_PLACEHOLDERS).toContain('LOGDIR');
    expect(LAUNCHD_PLACEHOLDERS).toContain('LABEL');
  });
});

describe('renderer argument parsing', () => {
  const home = '/Users/example';

  it('defaults the label prefix and log directory', () => {
    const args = parseRenderArgs(['out'], home);
    expect(args.labelPrefix).toBe('io.github.baktiaditya.ai-usage-dashboard');
    expect(args.logDir).toBe(join(home, 'Library', 'Logs', 'ai-usage-dashboard'));
  });

  it('accepts explicit options in either order', () => {
    const a = parseRenderArgs(
      ['out', '--label-prefix', 'dev.example', '--log-dir', '/tmp/logs'],
      home,
    );
    expect(a).toEqual({ outDir: 'out', labelPrefix: 'dev.example', logDir: '/tmp/logs' });
    const b = parseRenderArgs(
      ['out', '--log-dir', '/tmp/logs', '--label-prefix', 'dev.example'],
      home,
    );
    expect(b).toEqual(a);
  });

  it('refuses a missing option argument, an unknown option, or a second positional', () => {
    expect(() => parseRenderArgs(['out', '--label-prefix'], home)).toThrow(/requires a value/);
    expect(() => parseRenderArgs(['out', '--log-dir'], home)).toThrow(/requires a value/);
    expect(() => parseRenderArgs(['out', '--nope'], home)).toThrow(/unknown argument/);
    expect(() => parseRenderArgs(['out', 'extra'], home)).toThrow(/unexpected argument/);
    expect(() => parseRenderArgs([], home)).toThrow(/usage:/);
  });

  it('refuses an invalid label prefix', () => {
    for (const bad of ['', '.hidden', 'a/b', 'a b', 'a\u0001b', '-leading']) {
      expect(
        () => parseRenderArgs(['out', '--label-prefix', bad], home),
        JSON.stringify(bad),
      ).toThrow();
    }
  });

  it('accepts the prefix characters launchd labels allow', () => {
    for (const good of ['a', 'A1', 'io.github.baktiaditya.ai-usage-dashboard.test.1699999999-42']) {
      expect(() => validateLabelPrefix(good), good).not.toThrow();
    }
  });

  it('refuses a relative log directory', () => {
    expect(() => parseRenderArgs(['out', '--log-dir', 'logs'], home)).toThrow(/absolute path/);
    expect(() => parseRenderArgs(['out', '--log-dir', '~/logs'], home)).toThrow(/absolute path/);
    expect(() => parseRenderArgs(['out', '--log-dir', '/tmp/a\u0007b'], home)).toThrow(
      /control character/,
    );
  });
});

describe('protected locations', () => {
  it('refuses the checkout, data, env, CODEX_HOME and log paths under a protected folder', () => {
    mkdirSync(join(dir, 'Documents'), { recursive: true });
    mkdirSync(join(dir, 'Downloads'), { recursive: true });
    mkdirSync(join(dir, 'Desktop'), { recursive: true });
    mkdirSync(join(dir, 'Library', 'Mobile Documents'), { recursive: true });

    const cases: [string, string][] = [
      ['the checkout', join(dir, 'Documents', 'checkout')],
      ['the data directory', join(dir, 'Downloads', 'data')],
      ['the environment file', join(dir, 'Library', 'Mobile Documents', 'collector.env')],
      ['CODEX_HOME', join(dir, 'Desktop', '.codex')],
      ['the log directory', join(dir, 'Documents', 'logs')],
    ];
    for (const [name, target] of cases) {
      expect(protectedRootFor(target, dir), target).not.toBeNull();
      expect(() => assertNotProtected(name, target, dir), target).toThrow(/privacy protection/);
    }
  });

  it('allows paths outside the protected folders', () => {
    mkdirSync(join(dir, 'Workspace'), { recursive: true });
    expect(protectedRootFor(join(dir, 'Workspace', 'checkout'), dir)).toBeNull();
    expect(() =>
      assertNotProtected('the checkout', join(dir, 'Workspace', 'checkout'), dir),
    ).not.toThrow();
  });

  it('refuses a symlink that resolves into a protected folder', () => {
    mkdirSync(join(dir, 'Documents', 'real'), { recursive: true });
    mkdirSync(join(dir, 'Workspace'), { recursive: true });
    symlinkSync(join(dir, 'Documents'), join(dir, 'Workspace', 'inward'));
    // The final component does not exist yet; the longest existing prefix resolves.
    expect(protectedRootFor(join(dir, 'Workspace', 'inward', 'data'), dir)).not.toBeNull();
    expect(() =>
      assertNotProtected('the data directory', join(dir, 'Workspace', 'inward', 'data'), dir),
    ).toThrow(/privacy protection/);
  });

  it('does not refuse a folder whose name merely starts with a protected name', () => {
    mkdirSync(join(dir, 'Documents-archive'), { recursive: true });
    expect(protectedRootFor(join(dir, 'Documents-archive', 'data'), dir)).toBeNull();
  });

  it('compares protected roots case-insensitively when asked, as APFS requires', () => {
    // Without an existing Documents folder the two spellings stay distinct
    // paths, so only the flag decides; the native-casing resolution is covered
    // by the Darwin-only integration test.
    const lower = join(dir, 'documents', 'checkout');
    expect(protectedRootFor(lower, dir, false)).toBeNull();
    expect(protectedRootFor(lower, dir, true)).not.toBeNull();
    const match = protectedRootFor(lower, dir, true);
    expect(match?.display).toBe('~/Documents');
    expect(match?.root.endsWith('/Documents')).toBe(true);
  });

  it('builds the default log directory under an injected home', () => {
    expect(defaultLogDir('/Users/example')).toBe('/Users/example/Library/Logs/ai-usage-dashboard');
  });
});
