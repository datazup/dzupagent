import type { RunJob } from "../queue/run-queue.js";

/**
 * SEC-M-01-EXTENDED — stamp an event envelope with the job's owning tenant
 * when present. Returns the event unchanged when the job has no
 * `metadata.tenantId`, preserving the gateway's legacy `DEFAULT_TENANT_ID`
 * fallback for single-tenant deployments.
 *
 * CODE-M-04: extracted from run-stages-admission.ts and run-stages-persistence.ts
 * to eliminate duplication.
 */
export function stampTenant<T extends object>(
  event: T,
  job: RunJob,
): T & { tenantId?: string } {
  const tenantId =
    typeof job.metadata?.["tenantId"] === "string"
      ? (job.metadata["tenantId"] as string)
      : undefined;
  return tenantId !== undefined ? { ...event, tenantId } : event;
}
