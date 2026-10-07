import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCodexAdapter } from '@/lib/adapters/codex';
import { CollectionError } from '@/lib/errors';
import { runAdapter } from '@/lib/collector/index';

const FAKE = join(process.cwd(), 'tests', 'helpers', 'fake-app-server', 'server.mjs');
const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'codex', 'valid-0.154.0.json');

// macOS keeps `false` in /usr/bin; GNU/Linux has it in both. A real executable
// that exits non-zero before reading stdin, unlike a missing path.
const FALSE_BIN =
  ['/usr/bin/false', '/bin/false'].find((path) => existsSync(path)) ?? '/usr/bin/false';

function adapter(mode: string, timeoutMs = 3000, payload = FIXTURE) {
  // The fake server reads its behaviour from the environment of the spawned
  // process, which the adapter inherits from this one.
  process.env['AUD_FAKE_MODE'] = mode;
  process.env['AUD_FAKE_PAYLOAD'] = payload;
  return createCodexAdapter({ command: process.execPath, args: [FAKE], timeoutMs });
}

function countFakeProcesses(): number {
  try {
    // `pgrep -fc` is GNU-only; `-f` plus `wc -l` counts the same processes on
    // both GNU/Linux and macOS, and the pipeline always exits 0.
    const out = execFileSync('/bin/sh', ['-c', `pgrep -f "${FAKE}" | wc -l`], {
      encoding: 'utf8',
    });
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

describe('codex app-server over a real child process', () => {
  it('completes the handshake and returns a normalised snapshot', async () => {
    const snap = await adapter('ok').collect(new AbortController().signal);
    expect(snap.kind).toBe('quota');
    expect(snap.windows).toHaveLength(2);
    // The version is derived from the handshake's userAgent, not a second spawn.
    expect(snap.sourceVersion).toBe('codex-cli/9.8.7');
  });

  it('ignores notifications and unparsable lines interleaved with the response', async () => {
    const snap = await adapter('garbage').collect(new AbortController().signal);
    expect(snap.windows).toHaveLength(2);
  });

  it('sends `initialized` so the server will answer subsequent requests', async () => {
    // The fake refuses to answer until it has seen the notification.
    const snap = await adapter('no-initialize').collect(new AbortController().signal);
    expect(snap.windows).toHaveLength(2);
  });

  it('times out rather than hanging when the server never answers', async () => {
    const started = Date.now();
    await expect(adapter('slow', 400).collect(new AbortController().signal)).rejects.toThrow(
      CollectionError,
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('reports a server-side JSON-RPC error without echoing its text', async () => {
    try {
      await adapter('rpc-error').collect(new AbortController().signal);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CollectionError).code).toBe('upstream_error');
      // The upstream message contained an email address.
      expect((err as CollectionError).message).not.toContain('user@example.com');
    }
  });

  it('detects a child that exits during the exchange', async () => {
    try {
      await adapter('crash').collect(new AbortController().signal);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CollectionError).code).toBe('process_failed');
    }
  });

  it.each([
    ['an absolute path that does not exist', '/nonexistent/definitely-not-here'],
    ['a bare name that is not on PATH', 'aud-definitely-missing-codex-cli'],
  ])('reports a missing CLI at %s as unavailable rather than an error', async (_, command) => {
    const missing = createCodexAdapter({ command, args: [], timeoutMs: 1000 });
    const record = await runAdapter(missing);
    expect(record.result.outcome).toBe('unavailable');
    if (record.result.outcome === 'unavailable') {
      expect(record.result.failure.code).toBe('cli_not_found');
      expect(record.result.failure.retryable).toBe(false);
    }
  });

  it('keeps a CLI that is found but cannot run as process_failed', async () => {
    // A found executable whose own startup fails is a fault, not a setup state.
    const record = await runAdapter(
      createCodexAdapter({ command: FALSE_BIN, args: [], timeoutMs: 1000 }),
    );
    expect(record.result.outcome).toBe('error');
    if (record.result.outcome === 'error') {
      expect(record.result.failure.code).toBe('process_failed');
    }
  });

  it('reaps the child process on both the success and the failure path', async () => {
    const before = countFakeProcesses();

    await adapter('ok').collect(new AbortController().signal);
    await adapter('slow', 300)
      .collect(new AbortController().signal)
      .catch(() => undefined);

    // Give SIGTERM a moment to land.
    await new Promise((r) => setTimeout(r, 800));
    expect(countFakeProcesses()).toBeLessThanOrEqual(before);
  });
});
