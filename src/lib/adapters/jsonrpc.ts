/**
 * Minimal newline-delimited JSON-RPC 2.0 client over a child process' stdio.
 *
 * Deliberately small: the Codex app-server is the only consumer, and the
 * dashboard issues exactly two calls against it. Keeping this self-contained
 * means the child process lifecycle — and in particular *always* killing it —
 * is visible in one place.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CollectionError } from '../errors';
import { redactText } from '../redact';

export interface JsonRpcClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  /** Bytes of stdout to buffer before giving up, guarding against a runaway child. */
  readonly maxBufferBytes?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export class JsonRpcProcessClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private lastStderr = '';

  constructor(private readonly options: JsonRpcClientOptions) {}

  start(): void {
    if (this.child) return;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.command, [...this.options.args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Inherit the environment so the CLI can find its own credential store,
        // which is exactly the delegation we want: this process never reads it.
        env: process.env,
      });
    } catch (err) {
      throw new CollectionError('process_failed', redactText(String(err)));
    }
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Keep only a short tail; stderr can carry paths and argv.
      this.lastStderr = (this.lastStderr + chunk).slice(-400);
    });

    child.on('error', (err) =>
      this.failAll(new CollectionError('process_failed', redactText(err.message))),
    );
    child.on('exit', (code, signal) => {
      if (this.closed) return;
      this.failAll(
        new CollectionError(
          'process_failed',
          `app-server exited early (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
        ),
      );
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    const max = this.options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
    if (this.buffer.length > max) {
      this.failAll(
        new CollectionError('process_failed', 'app-server output exceeded buffer limit'),
      );
      return;
    }
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let msg: { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      // Notifications and stray output are expected; ignore anything unparsable
      // rather than failing a request that has not arrived yet.
      return;
    }
    if (typeof msg.id !== 'number') return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(
        new CollectionError('upstream_error', redactText(msg.error.message ?? 'app-server error')),
      );
      return;
    }
    pending.resolve(msg.result);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new CollectionError('timeout', `aborted before ${method}`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CollectionError('timeout', `no response to ${method}`));
      }, this.options.timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CollectionError('timeout', `aborted during ${method}`));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      });

      try {
        this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CollectionError('process_failed', redactText(String(err))));
      }
    });
  }

  /** Idempotent. Always call this, including on the error path. */
  close(): void {
    this.closed = true;
    this.failAll(new CollectionError('process_failed', 'client closed'));
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    child.kill('SIGTERM');
    // Escalate if the child ignores SIGTERM, but do not keep the event loop
    // alive waiting for it.
    const t = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 2000);
    t.unref?.();
  }

  /** Redacted tail of stderr, for diagnostics only. */
  stderrTail(): string {
    return redactText(this.lastStderr);
  }
}
