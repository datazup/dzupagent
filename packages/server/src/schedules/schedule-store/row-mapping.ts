/**
 * Row ↔ domain mapping for the Drizzle schedule store.
 *
 * `rowToRecord` projects a persisted scheduleConfigs row into the ISO-string
 * ScheduleRecord contract; `normalizePatch` converts ISO-string date patch
 * fields back to Date instances for the Drizzle columns on update.
 */
import type { ScheduleRecord, ScheduleRow } from "./types.js";

/** Convert a Drizzle scheduleConfigs row to the domain ScheduleRecord. */
export function rowToRecord(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    name: row.name,
    cronExpression: row.cronExpression,
    workflowText: row.workflowText,
    enabled: row.enabled,
    metadata: row.metadata as Record<string, unknown> | null,
    tenantId: row.tenantId,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    running: row.running ?? false,
    claimedBy: row.claimedBy ?? null,
    lastClaimedAt: row.lastClaimedAt ? row.lastClaimedAt.toISOString() : null,
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Convert ISO-string date patch fields to Date for the Drizzle columns. */
export function normalizePatch(
  patch: Partial<Omit<ScheduleRecord, "id" | "createdAt" | "updatedAt">>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...patch };
  if ("nextRunAt" in patch) {
    out.nextRunAt = patch.nextRunAt ? new Date(patch.nextRunAt) : null;
  }
  if ("lastClaimedAt" in patch) {
    out.lastClaimedAt = patch.lastClaimedAt
      ? new Date(patch.lastClaimedAt)
      : null;
  }
  if ("lastFiredAt" in patch) {
    out.lastFiredAt = patch.lastFiredAt ? new Date(patch.lastFiredAt) : null;
  }
  return out;
}
