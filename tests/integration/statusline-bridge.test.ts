import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createClaudeIngestor,
  parseSpoolEvent,
  spoolEventToSnapshot,
} from '@/lib/ingestors/claude-statusline';

const BRIDGE = join(process.cwd(), 'scripts', 'claude-statusline-bridge.mjs');

/** A realistic status-line payload, including everything we must NOT keep. */
const STATUS_LINE_INPUT = {
  cwd: '/home/someone/private-project',
  session_id: 'sess_0123456789abcdef',
  session_name: 'my secret project',
  prompt_id: '550e8400-e29b-41d4-a716-446655440000',
  transcript_path: '/home/someone/.claude/projects/x/transcript.jsonl',
  model: { id: 'claude-opus-5', display_name: 'Opus' },
  workspace: {
    current_dir: '/home/someone/private-project',
    project_dir: '/home/someone/private-project',
    repo: { host: 'github.com', owner: 'secret-org', name: 'secret-repo' },
  },
  version: '2.1.269',
  cost: { total_cost_usd: 12.34, total_duration_ms: 45000 },
  context_window: { used_percentage: 8 },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1773554400 },
    seven_day: { used_percentage: 41.2, resets_at: 1773986400 },
  },
};

let dir: string;
let spool: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aud-bridge-'));
  spool = join(dir, 'spool', 'claude-statusline.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runBridge(input: unknown, env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, AUD_SPOOL_PATH: spool, ...env },
  });
}

describe('status-line bridge field selection', () => {
  it('writes only the allowlisted quota fields', () => {
    runBridge(STATUS_LINE_INPUT);
    const raw = readFileSync(spool, 'utf8');

    // Everything the dashboard needs.
    const event = parseSpoolEvent(raw);
    expect(event.hasRateLimits).toBe(true);
    expect(event.cliVersion).toBe('2.1.269');
    expect(event.rateLimits?.['five_hour']?.usedPercentage).toBe(23.5);

    // And nothing it does not.
    for (const secret of [
      'sess_0123456789abcdef',
      'private-project',
      'transcript.jsonl',
      'secret-org',
      'secret-repo',
      'my secret project',
      '550e8400-e29b-41d4-a716-446655440000',
      '12.34',
      'claude-opus-5',
    ]) {
      expect(raw, `spool must not contain ${secret}`).not.toContain(secret);
    }
  });

  it('still prints a status line for the terminal', () => {
    const out = runBridge(STATUS_LINE_INPUT);
    expect(out).toContain('Opus');
    expect(out).toContain('5h 24%');
  });

  it('records hasRateLimits=false when the account exposes none', () => {
    const { rate_limits: _omitted, ...withoutQuota } = STATUS_LINE_INPUT;
    runBridge(withoutQuota);
    const event = parseSpoolEvent(readFileSync(spool, 'utf8'));
    expect(event.hasRateLimits).toBe(false);
    expect(event.rateLimits).toBeNull();
  });

  it('does not crash the status line on malformed stdin', () => {
    const out = execFileSync(process.execPath, [BRIDGE], {
      input: 'not json',
      encoding: 'utf8',
      env: { ...process.env, AUD_SPOOL_PATH: spool },
    });
    expect(out.trim()).not.toBe('');
  });

  it('composes with a pre-existing status line instead of replacing it', () => {
    const out = runBridge(STATUS_LINE_INPUT, { AUD_WRAPPED_CMD: 'echo "MY EXISTING LINE"' });
    expect(out).toContain('MY EXISTING LINE');
    // And it still recorded the observation.
    expect(parseSpoolEvent(readFileSync(spool, 'utf8')).hasRateLimits).toBe(true);
  });

  it('falls back to its own rendering when the wrapped command fails', () => {
    const out = runBridge(STATUS_LINE_INPUT, { AUD_WRAPPED_CMD: 'exit 1' });
    expect(out).toContain('Opus');
  });
});

describe('spool file safety', () => {
  it('writes with mode 0600', () => {
    runBridge(STATUS_LINE_INPUT);
    expect(statSync(spool).mode & 0o777).toBe(0o600);
  });

  it('creates the spool directory with mode 0700', () => {
    runBridge(STATUS_LINE_INPUT);
    expect(statSync(join(dir, 'spool')).mode & 0o777).toBe(0o700);
  });

  it('replaces the file atomically and leaves no temp files behind', () => {
    for (let i = 0; i < 5; i += 1) runBridge(STATUS_LINE_INPUT);
    const leftovers = readdirSync(join(dir, 'spool')).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    // The file is always complete JSON, never a partial write.
    expect(() => parseSpoolEvent(readFileSync(spool, 'utf8'))).not.toThrow();
  });

  it('produces a different event id for each observation', () => {
    runBridge(STATUS_LINE_INPUT);
    const first = parseSpoolEvent(readFileSync(spool, 'utf8')).eventId;
    // Force a distinct observedAt.
    execFileSync('/bin/sh', ['-c', 'sleep 0.02']);
    runBridge(STATUS_LINE_INPUT);
    const second = parseSpoolEvent(readFileSync(spool, 'utf8')).eventId;
    expect(first).not.toBe(second);
  });
});

describe('ingestor', () => {
  it('reads a spool written by the real bridge end to end', async () => {
    runBridge(STATUS_LINE_INPUT);
    const snap = await createClaudeIngestor({ spoolPath: spool }).collect(
      new AbortController().signal,
    );
    expect(snap.provider).toBe('claude');
    expect(snap.windows).toHaveLength(2);
    expect(snap.sourceEventId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('reports a missing spool as no_event_yet with a setup instruction', async () => {
    const ingestor = createClaudeIngestor({ spoolPath: join(dir, 'never-written.json') });
    await expect(ingestor.collect(new AbortController().signal)).rejects.toMatchObject({
      code: 'no_event_yet',
    });
    await ingestor.collect(new AbortController().signal).catch((err: Error) => {
      expect(err.message).toContain('claude:install-statusline');
    });
  });

  it('reports a corrupt spool as a schema mismatch, not a crash', async () => {
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{ half written');
    await expect(
      createClaudeIngestor({ spoolPath: corrupt }).collect(new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'schema_mismatch',
    });
  });

  it('keeps the observation timestamp the bridge recorded, not the read time', () => {
    const event = parseSpoolEvent(
      JSON.stringify({
        spoolSchemaVersion: 1,
        eventId: 'abcdefgh12345678',
        observedAt: '2026-09-12T04:00:00.000Z',
        cliVersion: '2.1.269',
        hasRateLimits: true,
        rateLimits: { five_hour: { usedPercentage: 1, resetsAt: null } },
      }),
    );
    const snap = spoolEventToSnapshot(event);
    expect(snap.observedAt).toBe('2026-09-12T04:00:00.000Z');
    // collectedAt is "now", and the two must stay distinguishable.
    expect(snap.collectedAt).not.toBe(snap.observedAt);
  });
});
