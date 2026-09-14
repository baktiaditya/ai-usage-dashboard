/**
 * Child process for the concurrent-first-open test.
 *
 * Waits until a shared start instant so several processes reach `openDb` on the
 * same fresh file together — the situation when the web server and the
 * collector both start before any database exists.
 */
import { openDb } from '../../src/lib/db/client';

const [path, startAt] = [process.argv[2] ?? '', Number(process.argv[3])];
while (Date.now() < startAt) {
  // Busy-wait: a timer would add scheduling jitter that spreads the opens out.
}

try {
  openDb({ path }).$client.close();
  process.stdout.write('ok');
} catch (err) {
  process.stdout.write(`error: ${(err as Error).message}`);
  process.exitCode = 1;
}
