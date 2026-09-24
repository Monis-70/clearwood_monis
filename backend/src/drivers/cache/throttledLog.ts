import { logger } from '../../config/logger';

const WINDOW_MS = 30_000;
const last = new Map<string, { at: number; suppressed: number }>();

/** At most one warning per `event` every 30 s, so an outage cannot flood the log. */
export function throttledWarn(
  event: string,
  context: Record<string, unknown>,
  message: string,
): void {
  const now = Date.now();
  const entry = last.get(event);

  if (entry && now - entry.at < WINDOW_MS) {
    entry.suppressed += 1;
    return;
  }

  last.set(event, { at: now, suppressed: 0 });
  logger.warn({ ...context, event, suppressedSinceLast: entry?.suppressed ?? 0 }, message);
}
