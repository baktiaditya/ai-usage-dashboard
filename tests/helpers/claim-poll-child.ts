/**
 * Child process for the cross-process Claude poll claim test.
 *
 * Waits until a shared start instant so several processes — standing in for
 * the scheduled collector and the web server's manual refresh — claim the same
 * poll together. Prints `claimed` or `skipped`.
 */
import { openDb } from '../../src/lib/db/client';
import { claimClaudePoll } from '../../src/lib/db/repository';

const [path, startAt, attemptedAt] = [
  process.argv[2] ?? '',
  Number(process.argv[3]),
  process.argv[4] ?? '',
];
const db = openDb({ path });
while (Date.now() < startAt) {
  // Busy-wait: a timer would add scheduling jitter that spreads the claims out.
}

try {
  process.stdout.write(claimClaudePoll(db, attemptedAt, 5 * 60_000) ? 'claimed' : 'skipped');
} catch (err) {
  process.stdout.write(`error: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  db.$client.close();
}
