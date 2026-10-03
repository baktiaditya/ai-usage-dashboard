import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupError, inUseStopHint, processesHoldingViaLsof } from '@/lib/db/backup';
import type { LsofResult, LsofRunner } from '@/lib/db/backup';

let dir: string;
let db: string;
let wal: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'aud-lsof-')));
  db = join(dir, 'usage.db');
  wal = `${db}-wal`;
  writeFileSync(db, '');
  writeFileSync(wal, '');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A runner that records its arguments and answers with `result`. */
function fake(result: Partial<LsofResult>): LsofRunner & { calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const run = (args: readonly string[]): LsofResult => {
    calls.push(args);
    return { status: 0, signal: null, stdout: '', stderr: '', ...result };
  };
  return Object.assign(run, { calls });
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawnSync lsof ${code}`), { code });
}

const UNKNOWN = /^cannot tell whether the database is in use/;

describe('processesHoldingViaLsof', () => {
  it('asks lsof only about the paths that exist, by real path', () => {
    const run = fake({ status: 1 });
    processesHoldingViaLsof([db, wal, `${db}-shm`], run);
    expect(run.calls).toEqual([['-w', '-t', '--', db, wal]]);
  });

  it('does not run lsof when none of the paths exist', () => {
    const run = fake({ status: 0, stdout: '42\n' });
    expect(processesHoldingViaLsof([join(dir, 'missing.db')], run)).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  it('returns the PIDs lsof prints, deduplicated and sorted', () => {
    const run = fake({ status: 0, stdout: '311\n42\n311\n' });
    expect(processesHoldingViaLsof([db, wal], run)).toEqual([42, 311]);
  });

  it('treats PIDs on stdout as holders when lsof exits 1 because some paths are not open', () => {
    const run = fake({ status: 1, stdout: '42\n' });
    expect(processesHoldingViaLsof([db, wal], run)).toEqual([42]);
  });

  it('returns no holder for exit 1 with no output', () => {
    expect(processesHoldingViaLsof([db, wal], fake({ status: 1 }))).toEqual([]);
  });

  describe('refuses to answer', () => {
    function expectUnknown(result: Partial<LsofResult>, detail: RegExp): void {
      let thrown: unknown;
      try {
        processesHoldingViaLsof([db, wal], fake(result));
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(BackupError);
      expect((thrown as Error).message).toMatch(UNKNOWN);
      expect((thrown as Error).message).toMatch(detail);
    }

    it('for exit 1 with an error and no PIDs', () => {
      expectUnknown(
        { status: 1, stderr: 'lsof: status error on /Users/someone/x: Permission denied\n' },
        /lsof failed: lsof: status error on ~\/x: Permission denied$/,
      );
    });

    it('for any other non-zero exit', () => {
      expectUnknown({ status: 2 }, /lsof failed: exit status 2 with no process listed/);
    });

    it('for exit 0 with no process listed', () => {
      expectUnknown({ status: 0 }, /lsof failed: exit status 0 with no process listed/);
    });

    it('when lsof is killed by a signal', () => {
      expectUnknown({ status: null, signal: 'SIGKILL' }, /lsof failed: killed by SIGKILL/);
    });

    it('when lsof times out', () => {
      expectUnknown(
        { status: null, signal: 'SIGTERM', error: errno('ETIMEDOUT') },
        /lsof failed: ETIMEDOUT/,
      );
    });

    it('when a stdout line is not a process ID', () => {
      expectUnknown({ status: 0, stdout: '42\nnode\n' }, /other than process IDs/);
    });

    it('when lsof is not installed', () => {
      expectUnknown({ error: errno('ENOENT') }, /\/proc is unavailable and lsof was not found/);
    });
  });
});

describe('inUseStopHint', () => {
  it('names the systemd units on Linux', () => {
    expect(inUseStopHint('linux')).toMatch(/ai-usage-dashboard-web\.service/);
    expect(inUseStopHint('linux')).toMatch(/ai-usage-dashboard-collector\.timer/);
  });

  it('names no systemd unit elsewhere', () => {
    expect(inUseStopHint('darwin')).not.toMatch(/systemd|\.service|\.timer/);
    expect(inUseStopHint('darwin')).toMatch(/scheduled collector.*dashboard server/);
  });
});
