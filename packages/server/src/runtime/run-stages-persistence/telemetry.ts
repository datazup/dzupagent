import type { RunStore } from "@dzupagent/core/persistence";
import type { CostLedgerClient } from "@dzupagent/agent/runtime";
import { DistributedCostLedger } from "@dzupagent/agent/runtime";
import type { RunJob } from "../../queue/run-queue.js";
import { resolveTenantId } from "../run-stages-utils.js";
import type { StartRunWorkerOptions } from "../run-worker-types.js";
import { logBestEffortFailure } from "./shared.js";

/**
 * P3 — record the run's final spend against the fleet-wide distributed cost
 * ledger so a multi-replica deployment shares one running total. No-op when
 * no `guardrailClient` is configured or the run produced no cost.
 *
 * Tenant/agent attribution mirrors {@link recordTelemetryStage}: the tenant id
 * is read from `job.metadata.tenantId` (falling back to `'default'`), matching
 * the keying the agent runtime uses for the same ledger. Failures are
 * swallowed and surfaced as a warn log — never fatal, mirroring the ledger's
 * own graceful-degradation contract.
 */
export async function recordDistributedCost(options: {
  guardrailClient?: CostLedgerClient;
  runStore: RunStore;
  job: RunJob;
  costCents?: number;
}): Promise<void> {
  const { guardrailClient, costCents } = options;
  if (!guardrailClient) return;
  if (
    typeof costCents !== "number" ||
    !Number.isFinite(costCents) ||
    costCents <= 0
  ) {
    return;
  }

  // CODE-M-04: reuse the shared resolver (queue tenant → metadata.tenantId →
  // 'default') instead of an inline metadata derivation.
  const tenantId = resolveTenantId(options.job);

  try {
    const ledger = new DistributedCostLedger({ client: guardrailClient });
    await ledger.record(tenantId, options.job.agentId, costCents / 100);
  } catch (err) {
    await options.runStore
      .addLog(options.job.runId, {
        level: "warn",
        phase: "guardrails",
        message: "Failed to record run cost against distributed cost ledger",
        data: { error: err instanceof Error ? err.message : String(err) },
      })
      .catch((logErr) => {
        // CODE-L-01: surface a failing best-effort addLog instead of
        // dropping it silently.
        logBestEffortFailure("recordDistributedCost.addLog", logErr);
      });
  }
}

export async function recordTelemetryStage(options: {
  workerOptions: StartRunWorkerOptions;
  job: RunJob;
  durationMs: number;
  tokenUsage?: { input: number; output: number };
}): Promise<void> {
  if (options.workerOptions.resourceQuota && options.tokenUsage) {
    const totalTokens =
      (options.tokenUsage.input ?? 0) + (options.tokenUsage.output ?? 0);
    const keyId =
      typeof options.job.metadata?.["ownerId"] === "string"
        ? (options.job.metadata["ownerId"] as string)
        : typeof options.job.metadata?.["tenantId"] === "string"
        ? (options.job.metadata["tenantId"] as string)
        : undefined;
    if (keyId && totalTokens > 0) {
      try {
        options.workerOptions.resourceQuota.recordUsage(keyId, totalTokens);
      } catch (err) {
        await options.workerOptions.runStore
          .addLog(options.job.runId, {
            level: "warn",
            phase: "quota",
            message: "Failed to record token usage against quota manager",
            data: { error: err instanceof Error ? err.message : String(err) },
          })
          .catch((logErr) => {
            // CODE-L-01: surface a failing best-effort addLog instead of
            // dropping it silently.
            logBestEffortFailure("recordTelemetry.addLog", logErr);
          });
      }
    }
  }

  const tierLabel =
    (options.job.metadata?.["modelTier"] as string) || "unknown";
  options.workerOptions.metrics?.increment("forge_run_completed_total", {
    tier: tierLabel,
  });
  options.workerOptions.metrics?.observe(
    "forge_run_duration_ms",
    options.durationMs,
    { tier: tierLabel }
  );
}
