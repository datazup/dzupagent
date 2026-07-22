/**
 * Cron math shared by the in-memory and Drizzle schedule stores.
 *
 * `computeNextRunAt` derives the next occurrence for a save/claim advance;
 * `resolveOccurrences` implements the skip-and-realign (default) vs. bounded
 * catch-up backfill (maxCatchUp > 0) fire policy used by both stores' claimDue.
 */
import cronParser from "cron-parser";

/**
 * Compute the first cron occurrence strictly after `after`.
 *
 * Uses cron-parser 4.x `parseExpression(...).next().toDate()`. Returns `null`
 * when the expression cannot be parsed so callers can leave nextRunAt unset
 * rather than throwing during a save.
 */
export function computeNextRunAt(
  cronExpression: string,
  after: Date
): Date | null {
  try {
    const it = cronParser.parseExpression(cronExpression, {
      currentDate: after,
    });
    return it.next().toDate();
  } catch {
    return null;
  }
}

/**
 * Resolve the occurrences a single claim fires. Default (no maxCatchUp):
 * skip-and-realign — fire once for the original due occurrence. With
 * maxCatchUp > 0: bounded backfill of missed occurrences up to the cap.
 */
export function resolveOccurrences(
  cronExpression: string,
  dueAt: Date,
  now: Date,
  maxCatchUp?: number
): Date[] {
  if (!maxCatchUp || maxCatchUp <= 0) return [dueAt];
  const occurrences: Date[] = [dueAt];
  let cursor = dueAt;
  while (occurrences.length < maxCatchUp) {
    const next = computeNextRunAt(cronExpression, cursor);
    if (!next || next.getTime() > now.getTime()) break;
    occurrences.push(next);
    cursor = next;
  }
  return occurrences;
}
