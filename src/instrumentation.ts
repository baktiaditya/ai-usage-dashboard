/**
 * Next.js calls `register` once per server instance, before it serves a
 * request, so the socket compatibility guard is in place before the first
 * `fetch()` a route handler makes. Edge has no `node:net`, so the guard is
 * imported only for the Node.js runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installTypeOfServiceGuard } = await import('./lib/socket-compat');
    installTypeOfServiceGuard();
  }
}
