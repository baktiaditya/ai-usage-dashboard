import { Socket } from 'node:net';

interface TypeOfServiceSetter {
  (this: Socket, tos: number): Socket;
  audTosGuard?: true;
}

/**
 * Node 24 bundles undici 7.x, whose HTTP/1.1 writer calls
 * `socket.setTypeOfService()` on every request. On macOS that call throws
 * `EINVAL` once the peer has reset the connection, and because it runs inside a
 * socket I/O callback it escapes every `fetch()` try/catch and terminates the
 * process (nodejs/undici#5544). undici 8.8.0 ignores the error
 * (nodejs/undici#5547) but Node 24 still bundles 7.x, so the same best-effort
 * guard is installed here, before a process makes its first `fetch()`.
 *
 * Only `EINVAL` is swallowed — type of service is a QoS hint — and every other
 * error still throws. Calling this more than once is a no-op.
 */
export function installTypeOfServiceGuard(): void {
  const prototype = Socket.prototype as Socket & { setTypeOfService?: TypeOfServiceSetter };
  const current = prototype.setTypeOfService;
  if (current === undefined || current.audTosGuard === true) return;

  const guarded: TypeOfServiceSetter = Object.assign(
    function (this: Socket, tos: number): Socket {
      try {
        return current.call(this, tos);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EINVAL') return this;
        throw error;
      }
    },
    { audTosGuard: true as const },
  );
  prototype.setTypeOfService = guarded;
}
