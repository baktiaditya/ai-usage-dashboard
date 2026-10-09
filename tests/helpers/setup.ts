import { Socket } from 'node:net';

// Tests must never pick up the developer's real data directory. Every suite
// that needs configuration builds it explicitly via `loadConfig`.
delete process.env['AUD_DATA_DIR'];
// `getConfig` merges the collector environment file; point it at a path that
// cannot exist so a provisioned ~/.config/ai-usage-dashboard/collector.env
// never leaks real settings into a suite.
process.env['AUD_ENV_FILE'] = '/nonexistent/ai-usage-dashboard-tests/collector.env';

/**
 * Node 24 bundles undici 7.x, whose HTTP/1.1 writer calls
 * `socket.setTypeOfService()` on every request. On macOS that call throws
 * `EINVAL` once the peer has reset the connection, and because it runs inside a
 * socket I/O callback it escapes every `fetch()` try/catch and kills the
 * Vitest worker (nodejs/undici#5544). undici 8.8.0 ignores the error
 * (nodejs/undici#5547) but Node 24 still bundles 7.x, so the same best-effort
 * guard is applied here. Only `EINVAL` is swallowed — type of service is a QoS
 * hint — and every other error still throws.
 */
interface TypeOfServiceSetter {
  (this: Socket, tos: number): Socket;
  audTosGuard?: true;
}

const socketPrototype = Socket.prototype as Socket & {
  setTypeOfService?: TypeOfServiceSetter;
};
const nativeSetTypeOfService = socketPrototype.setTypeOfService;
if (nativeSetTypeOfService !== undefined && nativeSetTypeOfService.audTosGuard !== true) {
  const guarded: TypeOfServiceSetter = Object.assign(
    function (this: Socket, tos: number): Socket {
      try {
        return nativeSetTypeOfService.call(this, tos);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EINVAL') return this;
        throw error;
      }
    },
    { audTosGuard: true as const },
  );
  socketPrototype.setTypeOfService = guarded;
}

// `@testing-library/jest-dom` needs a DOM and is imported by the component
// suites themselves, which opt into the jsdom environment per file.
