import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UnitValueError, renderUnit, systemdValue } from '@/lib/systemd-unit';
import type { UnitValues } from '@/lib/systemd-unit';

const values: UnitValues = {
  WORKDIR: '/srv/aud',
  PATH: '/opt/node/bin:/usr/bin:/bin',
  CODEXHOME: '/home/u/.codex',
  NODE: '/opt/node/bin/node',
  TSX: '/srv/aud/node_modules/tsx/dist/cli.mjs',
  DATADIR: '/data/a&b|c',
  ENVFILE: '/home/u/.config/ai-usage-dashboard/collector.env',
  INTERVAL: '5',
  HOST: '127.0.0.1',
  PORT: '4444',
};

describe('systemd unit rendering', () => {
  it('substitutes values literally, including sed metacharacters', () => {
    // `sed s|x|$v|` read `&` as "the match" and `|` as its delimiter.
    expect(
      renderUnit('Environment="AUD_DATA_DIR=__DATADIR__"\nReadWritePaths=__DATADIR__\n', values),
    ).toBe('Environment="AUD_DATA_DIR=/data/a&b|c"\nReadWritePaths=/data/a&b|c\n');
  });

  it('never rescans a substituted value for placeholders', () => {
    const out = renderUnit('ReadWritePaths=__DATADIR__', {
      ...values,
      DATADIR: '/data/__ENVFILE__',
    });
    expect(out).toBe('ReadWritePaths=/data/__ENVFILE__');
  });

  it('escapes % so systemd does not expand it as a specifier', () => {
    // Unescaped, `%h` would silently become the home directory.
    expect(systemdValue('DATADIR', '/data/50%h')).toBe('/data/50%%h');
  });

  it.each([
    '',
    '/data/with space',
    '/data/tab\there',
    '/data/new\nline',
    '/data/quote"d',
    "/data/it's",
    '/data/back\\slash',
    '/data/bell\u0007',
  ])('refuses %j rather than rendering a unit that points elsewhere', (raw) => {
    expect(() => systemdValue('DATADIR', raw)).toThrow(UnitValueError);
  });

  it.each([
    ['DATADIR', 'relative-data'],
    ['DATADIR', '~/data'],
    ['ENVFILE', 'keys.env'],
    ['CODEXHOME', '.codex'],
    ['WORKDIR', 'aud'],
    ['PATH', '/usr/bin:node_modules/.bin'],
    ['PATH', '/usr/bin::/bin'],
  ])('refuses a relative %s (%j), which systemd would ignore', (name, raw) => {
    expect(() => systemdValue(name, raw)).toThrow(UnitValueError);
  });

  it('refuses a placeholder it does not know', () => {
    expect(() => renderUnit('X=__NOPE__', values)).toThrow(UnitValueError);
  });

  it.each([
    'ai-usage-dashboard-collector.service',
    'ai-usage-dashboard-collector.timer',
    'ai-usage-dashboard-web.service',
  ])('renders the shipped %s template completely', (unit) => {
    const template = readFileSync(join(process.cwd(), 'systemd', `${unit}.template`), 'utf8');
    const out = renderUnit(template, values);
    expect(out).not.toMatch(/__[A-Z]+__/);
    if (unit.endsWith('.service')) {
      expect(out).toContain('Environment="AUD_DATA_DIR=/data/a&b|c"');
      expect(out).toContain('ReadWritePaths=/data/a&b|c');
    }
    // Only the web server binds, and it must bind where the installer reported.
    if (unit === 'ai-usage-dashboard-web.service') {
      expect(out).toContain('Environment=AUD_HOST=127.0.0.1');
      expect(out).toContain('Environment=AUD_PORT=4444');
    } else {
      expect(out).not.toMatch(/AUD_(HOST|PORT)/);
    }
  });
});
