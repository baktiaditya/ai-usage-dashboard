import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/lib/logger';

function captureStdout(fn: () => void): string[] {
  const lines: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('structured logging', () => {
  it('emits one JSON object per line', () => {
    const lines = captureStdout(() => createLogger('info').info('hello', { a: 1 }));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ level: 'info', msg: 'hello', a: 1 });
    expect(parsed.ts).toMatch(/Z$/);
  });

  it('honours the minimum level', () => {
    const lines = captureStdout(() => {
      const log = createLogger('warn');
      log.debug('nope');
      log.info('nope');
      log.warn('yes');
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe('yes');
  });

  it('redacts secrets in the message', () => {
    const lines = captureStdout(() =>
      createLogger('info').error('failed with Authorization: Bearer sk-or-v1-supersecret123'),
    );
    expect(lines[0]).not.toContain('sk-or-v1-supersecret123');
  });

  it('redacts denied keys in structured fields', () => {
    const lines = captureStdout(() =>
      createLogger('info').info('attempt', {
        provider: 'openrouter',
        apiKey: 'sk-or-v1-leak',
        email: 'me@example.com',
        nested: { token: 'tok_leak' },
      }),
    );
    const line = lines[0]!;
    expect(line).not.toContain('sk-or-v1-leak');
    expect(line).not.toContain('me@example.com');
    expect(line).not.toContain('tok_leak');
    // Non-sensitive context survives so the log stays useful.
    expect(line).toContain('openrouter');
  });

  it('carries child bindings into every line', () => {
    const lines = captureStdout(() =>
      createLogger('info', { runId: 7 }).child({ provider: 'codex' }).info('x'),
    );
    expect(JSON.parse(lines[0]!)).toMatchObject({ runId: 7, provider: 'codex' });
  });

  it('sends warnings and errors to stderr', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = createLogger('debug');
    log.error('boom');
    log.info('fine');
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(outSpy).toHaveBeenCalledTimes(1);
  });
});
