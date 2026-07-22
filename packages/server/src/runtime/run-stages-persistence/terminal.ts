import type { DzupEventBus } from "@dzupagent/core/events";
import type { RunStore } from "@dzupagent/core/persistence";
import type { RunTraceStore } from "../../persistence/run-trace-store.js";
import type { RunJob } from "../../queue/run-queue.js";
import {
  RUN_ERROR_DETAIL_METADATA_KEY,
  sanitizeFailureMessage,
} from "../../routes/route-error.js";
import { stampTenant } from "../tenant-event-stamp.js";
import type { ExecutionStageResult } from "../run-stages-execution.js";
import { closeTraceWithTerminalStep } from "../run-stages-utils.js";
import type { TerminalPersistenceResult } from "./shared.js";

export async function persistTerminalSuccess(options: {
  runStore: RunStore;
  traceStore?: RunTraceStore;
  job: RunJob;
  execution: ExecutionStageResult;
  startedAt: number;
  traceId?: string;
}): Promise<TerminalPersistenceResult> {
  const durationMs = Date.now() - options.startedAt;
  await options.runStore.update(options.job.runId, {
    status: options.execution.halted ? "halted" : "completed",
    output: options.execution.finalOutput,
    ...(options.execution.tokenUsage
      ? { tokenUsage: options.execution.tokenUsage }
      : {}),
    ...(typeof options.execution.costCents === "number"
      ? { costCents: options.execution.costCents }
      : {}),
    ...(options.execution.mergedMetadata
      ? {
          metadata: {
            ...(options.job.metadata ?? {}),
            ...options.execution.mergedMetadata,
          },
        }
      : {}),
    completedAt: new Date(),
  });

  if (options.traceStore) {
    await options.traceStore.addStep(options.job.runId, {
      timestamp: Date.now(),
      type: "output",
      content: options.execution.output,
      metadata: {
        ...(options.execution.tokenUsage
          ? { tokenUsage: options.execution.tokenUsage }
          : {}),
        ...(typeof options.execution.costCents === "number"
          ? { costCents: options.execution.costCents }
          : {}),
        durationMs,
      },
      durationMs,
    });
    await options.traceStore.completeTrace(options.job.runId);
  }

  await options.runStore.addLog(options.job.runId, {
    level: "info",
    phase: "run",
    message: "Run completed",
    data: {
      durationMs,
      ...(options.traceId ? { traceId: options.traceId } : {}),
    },
  });
  if (options.execution.additionalLogs.length > 0) {
    await options.runStore.addLogs(
      options.job.runId,
      options.execution.additionalLogs.map((log) => ({
        level: log.level,
        phase: log.phase,
        message: log.message,
        data: log.data,
      }))
    );
  }

  return { durationMs };
}

export async function persistCancellation(options: {
  runStore: RunStore;
  eventBus: DzupEventBus;
  traceStore?: RunTraceStore;
  job: RunJob;
}): Promise<void> {
  const run = await options.runStore.get(options.job.runId);
  if (
    run &&
    !["completed", "failed", "cancelled", "rejected", "halted"].includes(
      run.status
    )
  ) {
    await options.runStore.update(options.job.runId, {
      status: "cancelled",
      error: "Cancelled by user",
      completedAt: new Date(),
    });
    await options.runStore.addLog(options.job.runId, {
      level: "warn",
      phase: "run",
      message: "Run cancelled",
    });
    options.eventBus.emit(
      stampTenant(
        {
          type: "agent:failed",
          agentId: options.job.agentId,
          runId: options.job.runId,
          errorCode: "AGENT_ABORTED",
          message: "Cancelled by user",
        },
        options.job
      )
    );
    await closeTraceWithTerminalStep(
      options.traceStore,
      options.job.runId,
      "cancelled",
      { reason: "Cancelled by user" }
    );
  }
}

export async function persistFailure(options: {
  runStore: RunStore;
  eventBus: DzupEventBus;
  traceStore?: RunTraceStore;
  job: RunJob;
  error: unknown;
  traceId?: string;
}): Promise<void> {
  // DZUPAGENT-ERR-H-02: sanitize the raw failure ONCE, here at the point it is
  // first persisted. The client-safe `safe` message is what flows out through
  // every read channel (REST run.error, SSE/WS agent:failed.message); the full
  // `detail` (stack / driver text) is stashed admin-only on run.metadata and
  // retained in the server-side log + trace, both of which are admin surfaces.
  const { safe, detail } = sanitizeFailureMessage(options.error);
  const existing = await options.runStore.get(options.job.runId);
  const baseMetadata = (existing?.metadata ?? {}) as Record<string, unknown>;
  await options.runStore.update(options.job.runId, {
    status: "failed",
    error: safe,
    metadata: {
      ...baseMetadata,
      [RUN_ERROR_DETAIL_METADATA_KEY]: detail,
    },
    completedAt: new Date(),
  });
  await options.runStore.addLog(options.job.runId, {
    level: "error",
    phase: "run",
    message: "Run failed",
    data: {
      // Server-side log store is an admin-only surface, so it keeps full detail.
      error: detail,
      ...(options.traceId ? { traceId: options.traceId } : {}),
    },
  });
  options.eventBus.emit(
    stampTenant(
      {
        type: "agent:failed",
        agentId: options.job.agentId,
        runId: options.job.runId,
        errorCode: "INTERNAL_ERROR",
        message: safe,
      },
      options.job
    )
  );
  await closeTraceWithTerminalStep(
    options.traceStore,
    options.job.runId,
    "failed",
    // Trace is an admin/operator surface; retain full detail there.
    { error: detail }
  );
}
