/** Bound graceful shutdown so node --watch can always start its replacement.
 * Durable financial operations reconcile on restart; never await a dead client forever.
 */
export function installShutdown(close: () => Promise<void>, timeoutMs = 10_000) {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => {
      console.error('API shutdown deadline exceeded; exiting for restart');
      process.exit(1);
    }, timeoutMs);
    void close().then(() => {
      clearTimeout(deadline);
      process.exit(0);
    }, () => {
      clearTimeout(deadline);
      console.error('API shutdown failed');
      process.exit(1);
    });
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
}
