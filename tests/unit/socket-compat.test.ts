import { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { installTypeOfServiceGuard } from '@/lib/socket-compat';

interface TypeOfServiceSetter {
  (this: Socket, tos: number): Socket;
  audTosGuard?: true;
}

const prototype = Socket.prototype as Socket & { setTypeOfService?: TypeOfServiceSetter };
const original = prototype.setTypeOfService;

function throwing(code: string): TypeOfServiceSetter {
  return function (this: Socket): Socket {
    const error = new Error(`setTypeOfService ${code}`) as NodeJS.ErrnoException;
    error.code = code;
    error.syscall = 'setTypeOfService';
    throw error;
  };
}

function newSocket(): Socket & { setTypeOfService(tos: number): Socket } {
  return new Socket() as Socket & { setTypeOfService(tos: number): Socket };
}

describe('type-of-service guard', () => {
  afterEach(() => {
    if (original === undefined) delete prototype.setTypeOfService;
    else prototype.setTypeOfService = original;
  });

  it('ignores EINVAL and keeps the socket usable', () => {
    prototype.setTypeOfService = throwing('EINVAL');
    installTypeOfServiceGuard();
    const socket = newSocket();
    expect(socket.setTypeOfService(0)).toBe(socket);
  });

  it('rethrows every other error', () => {
    prototype.setTypeOfService = throwing('EACCES');
    installTypeOfServiceGuard();
    expect(() => newSocket().setTypeOfService(0)).toThrow('EACCES');
  });

  it('installs once, so a second call does not wrap again', () => {
    prototype.setTypeOfService = throwing('EINVAL');
    installTypeOfServiceGuard();
    const guarded = prototype.setTypeOfService;
    installTypeOfServiceGuard();
    expect(prototype.setTypeOfService).toBe(guarded);
  });
});
