import { spawn } from 'node:child_process';

export interface DashboardServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * A separate process can answer health checks while the installer tests block
 * their own event loop with spawnSync. Bind before reporting the OS-assigned
 * port over IPC: a random port plus curl can collide or accept another server.
 */
export async function startDashboardServer(port = 0): Promise<DashboardServer> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const server = require('node:http').createServer((q, r) => {
  r.writeHead(200, {'content-type': 'text/plain'}); r.end('ok');
});
server.listen(${port}, '127.0.0.1', () => process.send(server.address().port));
process.on('disconnect', () => process.exit(0));`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-8_192);
  });
  let exited = false;
  const stopped = new Promise<void>((resolve) => {
    child.once('close', () => {
      exited = true;
      resolve();
    });
  });
  const close = async (): Promise<void> => {
    if (!exited) child.kill('SIGKILL');
    await stopped;
  };

  try {
    const assignedPort = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('health server startup timed out')), 25_000);
      const cleanup = (): void => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('error', fail);
        child.off('exit', onExit);
      };
      const fail = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        fail(new Error(`health server exited before listening (${code ?? signal}): ${stderr}`));
      };
      const onMessage = (message: unknown): void => {
        if (
          typeof message !== 'number' ||
          !Number.isInteger(message) ||
          message < 1 ||
          message > 65_535
        ) {
          fail(new Error('health server reported an invalid port'));
          return;
        }
        cleanup();
        resolve(message);
      };
      child.on('message', onMessage);
      child.once('error', fail);
      child.once('exit', onExit);
    });
    return { port: assignedPort, close };
  } catch (error) {
    await close();
    throw error;
  }
}
