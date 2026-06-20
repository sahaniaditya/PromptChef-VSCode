/**
 * Simple in-memory sliding-window rate limiter — ported from the Chrome
 * extension's `src/background/rate-limit.ts`.
 *
 * Limit: 10 requests per 60 seconds per extension-host process. State resets
 * when the host restarts (e.g. on window reload), exactly like the service
 * worker version.
 */
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;

const timestamps: number[] = [];

export function checkRateLimit(now: number = Date.now()): boolean {
  // Evict timestamps outside the window.
  while (timestamps.length > 0 && now - timestamps[0] > WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= MAX_REQUESTS) return false;
  timestamps.push(now);
  return true;
}
