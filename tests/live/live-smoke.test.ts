/**
 * Opt-in live smoke checks.
 *
 * These talk to the real local CLI and the real provider endpoints, so they are
 * excluded from the default test run (see vitest.config.ts `include`) and each
 * one skips itself when its credential or local account is absent.
 *
 * Run with:  pnpm run test:live
 *
 * They assert *shape and reachability only*. No observed value is printed, and
 * nothing they see is ever written to a fixture — a real quota percentage or
 * balance is exactly the kind of thing that must not end up in the repository.
 */
import { describe, expect, it } from 'vitest';
import { createCodexAdapter } from '@/lib/adapters/codex';
import { createDeepseekAdapter } from '@/lib/adapters/deepseek';
import { createOpenrouterAdapter } from '@/lib/adapters/openrouter';
import { createClaudeIngestor } from '@/lib/ingestors/claude-statusline';
import { loadConfig } from '@/lib/config';
import { loadCollectorEnvFile } from '@/lib/env-file';
import { readSavedCredentials } from '../helpers/saved-credentials';

const enabled = process.env['LIVE_SMOKE'] === '1';
const describeLive = enabled ? describe : describe.skip;

/** Skip a gate whose credential is absent, rather than failing it. */
const describeWhen = (condition: boolean) => (enabled && condition ? describe : describe.skip);

// collector.env may still set AUD_* settings such as the data directory. Keys
// come from that directory's database, where dashboard Settings saved them. A
// missing database or table means no key, so those gates skip; any other
// database error fails the run.
loadCollectorEnvFile(process.env);
const config = loadConfig(process.env);
const saved = readSavedCredentials(config.databasePath);
const signal = () => AbortSignal.timeout(30_000);

describeLive('live: codex app-server', () => {
  it('answers account/rateLimits/read with at least one usable window', async () => {
    const snap = await createCodexAdapter({ timeoutMs: 25_000 }).collect(signal());

    expect(snap.kind).toBe('quota');
    expect(snap.windows.length).toBeGreaterThan(0);
    expect(snap.sourceVersion).toMatch(/^codex-cli\//);

    for (const w of snap.windows) {
      // Shape only: the value itself is never asserted or printed.
      expect(typeof w.usedPercent).toBe('number');
      expect(w.usedPercent).toBeGreaterThanOrEqual(0);
      expect(w.usedPercent).toBeLessThanOrEqual(100);
      expect(w.bucketId.length).toBeGreaterThan(0);
      if (w.resetsAt !== null) expect(w.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }

    // Account identity must not survive normalisation.
    expect(JSON.stringify(snap)).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  }, 40_000);
});

describeLive('live: claude status-line spool', () => {
  it('either has a valid event or reports a precise reason it does not', async () => {
    try {
      const snap = await createClaudeIngestor({ spoolPath: config.spoolPath }).collect(signal());
      expect(snap.provider).toBe('claude');
      expect(snap.windows.length).toBeGreaterThan(0);
      expect(snap.sourceEventId).toBeTruthy();
      for (const w of snap.windows) {
        expect(w.usedPercent).toBeGreaterThanOrEqual(0);
        expect(w.usedPercent).toBeLessThanOrEqual(100);
      }
    } catch (err) {
      // The gate is not yet unlocked; the reason must be one of the honest ones.
      expect(['no_event_yet', 'not_entitled', 'io_error']).toContain(
        (err as { code: string }).code,
      );
    }
  }, 20_000);
});

describeWhen(saved.deepseekApiKey !== null)('live: deepseek balance', () => {
  it('returns at least one currency with a decimal balance', async () => {
    const snap = await createDeepseekAdapter({
      apiKey: saved.deepseekApiKey,
      timeoutMs: 20_000,
    }).collect(signal());

    expect(snap.balances.length).toBeGreaterThan(0);
    for (const b of snap.balances) {
      expect(b.currency).toMatch(/^[A-Z]{3}$/);
      // Decimal string, never a float.
      if (b.totalBalance !== null) expect(b.totalBalance).toMatch(/^-?\d+(\.\d+)?$/);
      // This endpoint has no usage concept at all.
      expect(b.totalUsage).toBeNull();
    }
  }, 30_000);
});

describeWhen(saved.openrouterManagementKey !== null)('live: openrouter credits', () => {
  it('returns credits, usage and an exact decimal remainder', async () => {
    const snap = await createOpenrouterAdapter({
      managementKey: saved.openrouterManagementKey,
      timeoutMs: 20_000,
    }).collect(signal());

    const usd = snap.balances[0];
    expect(usd?.currency).toBe('USD');
    expect(usd?.totalCredits).toMatch(/^-?\d+(\.\d+)?$/);
    expect(usd?.totalUsage).toMatch(/^-?\d+(\.\d+)?$/);
    expect(usd?.remainingCredit).toMatch(/^-?\d+(\.\d+)?$/);
  }, 30_000);
});
