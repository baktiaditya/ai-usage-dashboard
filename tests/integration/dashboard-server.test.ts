import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { startDashboardServer, type DashboardServer } from '../helpers/dashboard-server';

const servers: DashboardServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('installer health server fixture', () => {
  it('rejects its own bind failure even when a foreign HTTP server answers the probe', async () => {
    const foreign = spawn(
      process.execPath,
      [
        '-e',
        `const server = require('node:http').createServer((q, r) => r.end('foreign'));
server.listen(0, '127.0.0.1', () => process.send(server.address().port));
process.on('disconnect', () => process.exit(0));`,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    const [port] = await once(foreign, 'message');
    try {
      await expect(
        startDashboardServer(port).then((server) => {
          servers.push(server);
          return server;
        }),
      ).rejects.toThrow('EADDRINUSE');
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('foreign');
    } finally {
      const exited = once(foreign, 'exit');
      foreign.kill('SIGKILL');
      await exited;
    }
  });

  it('keeps distinct OS-assigned ports bound and answers while the caller blocks', async () => {
    for (let i = 0; i < 4; i += 1) servers.push(await startDashboardServer());
    expect(new Set(servers.map((server) => server.port)).size).toBe(4);
    for (const server of servers) {
      const probe = spawnSync(
        process.execPath,
        ['-e', `fetch('http://127.0.0.1:${server.port}').then(r => r.text()).then(console.log)`],
        { encoding: 'utf8', timeout: 5_000 },
      );
      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stdout.trim()).toBe('ok');
    }
  });

  it('closes idempotently and releases its listening socket', async () => {
    const server = await startDashboardServer();
    servers.push(server);
    await server.close();
    await server.close();
    await expect(fetch(`http://127.0.0.1:${server.port}`)).rejects.toThrow();
  });

  it('exits when its parent goes away without explicitly closing it', async () => {
    const helper = new URL('../helpers/dashboard-server.ts', import.meta.url).href;
    const port = Number(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {startDashboardServer} from ${JSON.stringify(helper)};
const server = await startDashboardServer();
console.log(server.port);
process.exit(0);`,
        ],
        { encoding: 'utf8', timeout: 5_000 },
      ).trim(),
    );
    expect(port).toBeGreaterThan(0);
    await expect
      .poll(async () =>
        fetch(`http://127.0.0.1:${port}`).then(
          () => false,
          () => true,
        ),
      )
      .toBe(true);
  });
});
