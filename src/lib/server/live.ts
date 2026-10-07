/**
 * What the models are writing right now, per running task. Kept in memory only:
 * it is a preview for the browser, and the finished response is what gets stored.
 */
const globalForLive = globalThis as unknown as { __officeLive?: Map<string, string> };
const live: Map<string, string> = (globalForLive.__officeLive ??= new Map());

/** Longest tail of a response sent to the browser on each poll. */
const MAX_LIVE_CHARS = 6000;

export const startLive = (taskId: string) => {
  live.set(taskId, '');
};

export const appendLive = (taskId: string, text: string) => {
  if (live.has(taskId)) live.set(taskId, live.get(taskId) + text);
};

export const endLive = (taskId: string) => {
  live.delete(taskId);
};

/** Task id → the end of what has been written so far. */
export const liveSnapshot = (): Record<string, string> =>
  Object.fromEntries(Array.from(live, ([taskId, text]) => [taskId, text.slice(-MAX_LIVE_CHARS)]));
