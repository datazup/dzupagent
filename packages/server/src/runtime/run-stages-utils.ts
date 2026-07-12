import type { AgentExecutionSpec } from "@dzupagent/core/persistence";
import type { RunTraceStore } from "../persistence/run-trace-store.js";

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

export async function closeTraceWithTerminalStep(
  traceStore: RunTraceStore | undefined,
  runId: string,
  status: "failed" | "cancelled" | "rejected",
  details?: Record<string, unknown>
): Promise<void> {
  if (!traceStore) return;
  await traceStore.addStep(runId, {
    timestamp: Date.now(),
    type: "system",
    content: { status },
    metadata: details,
  });
  await traceStore.completeTrace(runId);
}

export function resolveSessionId(job: {
  runId: string;
  metadata?: Record<string, unknown>;
}): string {
  const fromMeta = job.metadata?.["sessionId"];
  return typeof fromMeta === "string" && fromMeta.length > 0
    ? fromMeta
    : job.runId;
}

/**
 * R3-ISO: resolve the job's owning tenant. Prefers the queue-level
 * `job.tenantId` (stamped server-side at enqueue), falls back to
 * `job.metadata.tenantId` for pre-stamping producers, then `'default'`.
 */
export function resolveTenantId(job: {
  tenantId?: string;
  metadata?: Record<string, unknown>;
}): string {
  if (typeof job.tenantId === "string" && job.tenantId.length > 0)
    return job.tenantId;
  const fromMeta = job.metadata?.["tenantId"];
  return typeof fromMeta === "string" && fromMeta.length > 0
    ? fromMeta
    : "default";
}

/**
 * R3-ISO-03: session key for cross-intent context transfer, partitioned by
 * tenant. `sessionId` is client-supplied, so two tenants can collide on (or
 * deliberately reuse) the same value — the tenant prefix keeps one tenant's
 * persisted context invisible to another's runs.
 */
export function resolveScopedSessionId(job: {
  runId: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}): string {
  return `${resolveTenantId(job)}:${resolveSessionId(job)}`;
}

export function resolveIntent(
  job: { metadata?: Record<string, unknown> },
  agent: AgentExecutionSpec
): string | undefined {
  const fromJob = job.metadata?.["intent"];
  if (typeof fromJob === "string" && fromJob.length > 0) return fromJob;

  const fromAgent = agent.metadata?.["intent"];
  if (typeof fromAgent === "string" && fromAgent.length > 0) return fromAgent;

  return undefined;
}
