/** Runs once when the server starts: resume queued work without waiting for a browser to connect. */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureEngine } = await import('./lib/server/engine');
    ensureEngine();
  }
}
