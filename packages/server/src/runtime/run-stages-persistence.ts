import type { DzupEventBus } from "@dzupagent/core/events";
import type { PersistedIntentContext } from "@dzupagent/core/llm";
import type { AgentExecutionSpec, RunStore } from "@dzupagent/core/persistence";
import type { CostLedgerClient } from "@dzupagent/agent/runtime";
import { DistributedCostLedger } from "@dzupagent/agent/runtime";
import type {
  RunReflectionStore,
  ReflectionSummary,
} from "@dzupagent/agent/reflection";
import type { RunTraceStore } from "../persistence/run-trace-store.js";
import type { RunJob } from "../queue/run-queue.js";
import { reportRetrievalFeedback } from "./retrieval-feedback-hook.js";

/**
 * SEC-M-01-EXTENDED — stamp an event envelope with the job's owning tenant
 * when present. Returns the event unchanged when the job has no
 * `metadata.tenantId`, preserving the gateway's legacy `DEFAULT_TENANT_ID`
 * fallback for single-tenant deployments.
 */
function stampTenant<T extends object>(
  event: T,
  job: RunJob,
): T & { tenantId?: string } {
  const tenantId =
    typeof job.metadata?.["tenantId"] === "string"
      ? (job.metadata["tenantId"] as string)
      : undefined;
  return tenantId !== undefined ? { ...event, tenantId } : event;
}
import type { ExecutionStageResult } from "./run-stages-execution.js";
import {
  closeTraceWithTerminalStep,
  resolveIntent,
  resolveSessionId,
} from "./run-stages-utils.js";
import type {
  ReflectionInput,
  RunExecutorResult,
  StartRunWorkerOptions,
} from "./run-worker-types.js";

export interface TerminalPersistenceResult {
  durationMs: number;
}

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
      })),
    );
  }

  return { durationMs };
}

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

  const tenantId =
    typeof options.job.metadata?.["tenantId"] === "string"
      ? (options.job.metadata["tenantId"] as string)
      : "default";

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
      .catch(() => {
        /* swallow nested failure */
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
          .catch(() => {
            /* swallow */
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
    { tier: tierLabel },
  );
}

export async function runPostRunLearningStage(options: {
  workerOptions: StartRunWorkerOptions;
  job: RunJob;
  agent: AgentExecutionSpec;
  input: unknown;
  output: unknown;
  tokenUsage?: { input: number; output: number };
  metadata?: Record<string, unknown>;
  additionalLogs: NonNullable<RunExecutorResult["logs"]>;
  durationMs: number;
}): Promise<void> {
  await scoreRunReflection(options);
  await analyzeRunOutcome(options);
  await saveCrossIntentContext(options);
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
      run.status,
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
        options.job,
      ),
    );
    await closeTraceWithTerminalStep(
      options.traceStore,
      options.job.runId,
      "cancelled",
      { reason: "Cancelled by user" },
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
  const message =
    options.error instanceof Error
      ? options.error.message
      : String(options.error);
  await options.runStore.update(options.job.runId, {
    status: "failed",
    error: message,
    completedAt: new Date(),
  });
  await options.runStore.addLog(options.job.runId, {
    level: "error",
    phase: "run",
    message: "Run failed",
    data: {
      error: message,
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
        message,
      },
      options.job,
    ),
  );
  await closeTraceWithTerminalStep(
    options.traceStore,
    options.job.runId,
    "failed",
    { error: message },
  );
}

async function scoreRunReflection(options: {
  workerOptions: StartRunWorkerOptions;
  job: RunJob;
  agent: AgentExecutionSpec;
  input: unknown;
  output: unknown;
  tokenUsage?: { input: number; output: number };
  additionalLogs: NonNullable<RunExecutorResult["logs"]>;
  durationMs: number;
}): Promise<void> {
  if (!options.workerOptions.reflector) return;

  try {
    const errorCount = options.additionalLogs.filter(
      (l) => l.level === "error",
    ).length;
    const retryCount = options.additionalLogs.filter(
      (l) => l.phase === "retry" || l.message.toLowerCase().includes("retry"),
    ).length;
    const toolCalls = options.additionalLogs
      .filter(
        (l) => l.phase === "tool_call" && l.data && typeof l.data === "object",
      )
      .map((l) => {
        const d = l.data as Record<string, unknown>;
        return {
          name: typeof d["toolName"] === "string" ? d["toolName"] : "unknown",
          success: d["success"] !== false,
          durationMs:
            typeof d["durationMs"] === "number" ? d["durationMs"] : undefined,
        };
      });

    const reflectionInput: ReflectionInput = {
      input: options.job.input,
      output: options.output,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokenUsage: options.tokenUsage,
      durationMs: options.durationMs,
      errorCount,
      retryCount,
    };

    const reflectionScore =
      options.workerOptions.reflector.score(reflectionInput);
    const existingRun = await options.workerOptions.runStore.get(
      options.job.runId,
    );
    const existingMeta = (existingRun?.metadata ?? {}) as Record<
      string,
      unknown
    >;
    await options.workerOptions.runStore.update(options.job.runId, {
      metadata: { ...existingMeta, reflectionScore },
    });

    await options.workerOptions.runStore.addLog(options.job.runId, {
      level: "info",
      phase: "reflection",
      message: `Run quality score: ${reflectionScore.overall.toFixed(3)}`,
      data: {
        overall: reflectionScore.overall,
        dimensions: reflectionScore.dimensions,
        flags: reflectionScore.flags,
      },
    });

    await persistReflectionSummary({
      reflectionStore: options.workerOptions.reflectionStore,
      runStore: options.workerOptions.runStore,
      job: options.job,
      additionalLogs: options.additionalLogs,
      errorCount,
      durationMs: options.durationMs,
      qualityScore: reflectionScore.overall,
    });

    if (options.workerOptions.retrievalFeedback) {
      reportRetrievalFeedback(
        options.workerOptions.retrievalFeedback,
        (options.job.metadata ?? {}) as Record<string, unknown>,
        reflectionScore,
      );
    }

    await maybeEscalateModelTier({
      workerOptions: options.workerOptions,
      job: options.job,
      agent: options.agent,
      score: reflectionScore.overall,
    });
  } catch (_reflErr) {
    await options.workerOptions.runStore
      .addLog(options.job.runId, {
        level: "warn",
        phase: "reflection",
        message: "Failed to compute reflection score",
        data: {
          error:
            _reflErr instanceof Error ? _reflErr.message : String(_reflErr),
        },
      })
      .catch(() => {
        /* swallow nested failure */
      });
  }
}

async function persistReflectionSummary(options: {
  reflectionStore?: RunReflectionStore;
  runStore: RunStore;
  job: RunJob;
  additionalLogs: NonNullable<RunExecutorResult["logs"]>;
  errorCount: number;
  durationMs: number;
  qualityScore: number;
}): Promise<void> {
  if (!options.reflectionStore) return;

  try {
    const toolCallLogs = options.additionalLogs.filter(
      (l) => l.phase === "tool_call" && l.data && typeof l.data === "object",
    );
    /*
     * RUN-REFLECTION-STORE-WIDEN: stamp tenantId + ownerId so the store can
     * filter reflections natively. The runtime threads both through
     * `job.metadata.tenantId` and `job.metadata.ownerId` — see
     * recordTelemetryStage() above for the same derivation. When the job
     * lacks one (single-tenant deployments, or pre-stamping callers) we
     * leave the field undefined; the storage backend supplies the
     * 'default' tenant fallback and `ownerId` stays NULL for legacy rows.
     */
    const tenantId =
      typeof options.job.metadata?.["tenantId"] === "string"
        ? (options.job.metadata["tenantId"] as string)
        : undefined;
    const ownerId =
      typeof options.job.metadata?.["ownerId"] === "string"
        ? (options.job.metadata["ownerId"] as string)
        : undefined;

    const summary: ReflectionSummary = {
      runId: options.job.runId,
      completedAt: new Date(),
      durationMs: options.durationMs,
      totalSteps: options.additionalLogs.length,
      toolCallCount: toolCallLogs.length,
      errorCount: options.errorCount,
      patterns: [],
      qualityScore: options.qualityScore,
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(ownerId !== undefined ? { ownerId } : {}),
    };
    await options.reflectionStore.save(summary);
  } catch (_saveErr) {
    await options.runStore
      .addLog(options.job.runId, {
        level: "warn",
        phase: "reflection",
        message: "Failed to persist reflection summary",
        data: {
          error:
            _saveErr instanceof Error ? _saveErr.message : String(_saveErr),
        },
      })
      .catch(() => {
        /* swallow nested failure */
      });
  }
}

async function maybeEscalateModelTier(options: {
  workerOptions: StartRunWorkerOptions;
  job: RunJob;
  agent: AgentExecutionSpec;
  score: number;
}): Promise<void> {
  if (!options.workerOptions.escalationPolicy) return;

  const currentTier = (options.job.metadata?.["modelTier"] as string) ?? "chat";
  const intent = resolveIntent(options.job, options.agent);
  const escalationKey = `${options.job.agentId}:${intent ?? "default"}`;
  const escalation = options.workerOptions.escalationPolicy.recordScore(
    escalationKey,
    options.score,
    currentTier,
  );

  if (escalation.shouldEscalate && options.workerOptions.agentStore.save) {
    try {
      const agentDef = await options.workerOptions.agentStore.get(
        options.job.agentId,
      );
      if (agentDef) {
        await options.workerOptions.agentStore.save({
          ...agentDef,
          metadata: {
            ...agentDef.metadata,
            modelTier: escalation.toTier,
          },
        });
      }
      options.workerOptions.eventBus.emit(
        stampTenant(
          {
            type: "registry:agent_updated",
            agentId: options.job.agentId,
            fields: ["metadata.modelTier"],
          },
          options.job,
        ),
      );
      await options.workerOptions.runStore.addLog(options.job.runId, {
        level: "info",
        phase: "escalation",
        message: `Model tier escalated: ${escalation.fromTier} -> ${escalation.toTier} (${escalation.reason})`,
        data: {
          fromTier: escalation.fromTier,
          toTier: escalation.toTier,
          consecutiveLowScores: escalation.consecutiveLowScores,
          escalationKey,
        },
      });
    } catch (escalationError) {
      await options.workerOptions.runStore
        .addLog(options.job.runId, {
          level: "warn",
          phase: "escalation",
          message: "Model tier escalation failed",
          data: {
            error:
              escalationError instanceof Error
                ? escalationError.message
                : String(escalationError),
          },
        })
        .catch(() => {
          /* swallow nested failure */
        });
    }
  }
}

async function analyzeRunOutcome(options: {
  workerOptions: StartRunWorkerOptions;
  job: RunJob;
  output: unknown;
}): Promise<void> {
  if (!options.workerOptions.runOutcomeAnalyzer) return;

  try {
    const outputText =
      typeof options.output === "string"
        ? options.output
        : options.output &&
            typeof options.output === "object" &&
            "message" in options.output &&
            typeof (options.output as { message?: unknown }).message ===
              "string"
          ? (options.output as { message: string }).message
          : JSON.stringify(options.output ?? "");
    const inputText =
      typeof options.job.input === "string"
        ? options.job.input
        : JSON.stringify(options.job.input ?? "");
    const analysis = await options.workerOptions.runOutcomeAnalyzer.analyze(
      options.job.runId,
      {
        agentId: options.job.agentId,
        input: inputText,
        output: outputText,
      },
    );
    const summary =
      analysis && typeof analysis === "object"
        ? (analysis as { score?: unknown; passed?: unknown })
        : null;
    const score =
      typeof summary?.score === "number" ? summary.score : undefined;
    const passed =
      typeof summary?.passed === "boolean" ? summary.passed : undefined;
    await options.workerOptions.runStore
      .addLog(options.job.runId, {
        level: "info",
        phase: "run-outcome",
        message:
          score !== undefined
            ? `Run outcome scored: ${score.toFixed(3)} (${
                passed ? "pass" : "fail"
              })`
            : "Run outcome analyzer completed",
        data: {
          ...(score !== undefined ? { score } : {}),
          ...(passed !== undefined ? { passed } : {}),
        },
      })
      .catch(() => {
        /* swallow nested failure */
      });
  } catch (_analyzerErr) {
    await options.workerOptions.runStore
      .addLog(options.job.runId, {
        level: "warn",
        phase: "run-outcome",
        message: "Run outcome analyzer failed",
        data: {
          error:
            _analyzerErr instanceof Error
              ? _analyzerErr.message
              : String(_analyzerErr),
        },
      })
      .catch(() => {
        /* swallow nested failure */
      });
  }
}

async function saveCrossIntentContext(options: {
  workerOptions: StartRunWorkerOptions;
  job: RunJob;
  agent: AgentExecutionSpec;
  output: unknown;
  tokenUsage?: { input: number; output: number };
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!options.workerOptions.contextTransfer) return;

  try {
    const sessionId = resolveSessionId(options.job);
    const intent = resolveIntent(options.job, options.agent);
    if (intent && intent !== "unknown") {
      const outputSummary =
        typeof options.output === "string"
          ? options.output.slice(0, 500)
          : typeof options.output === "object" &&
              options.output !== null &&
              "summary" in options.output
            ? String((options.output as Record<string, unknown>).summary).slice(
                0,
                500,
              )
            : "Run completed";

      const relevantFiles: string[] =
        (options.metadata?.["relevantFiles"] as string[] | undefined) ??
        (options.job.metadata?.["relevantFiles"] as string[] | undefined) ??
        [];

      const workingState: Record<string, unknown> =
        (options.metadata?.["workingState"] as
          | Record<string, unknown>
          | undefined) ??
        (options.job.metadata?.["workingState"] as
          | Record<string, unknown>
          | undefined) ??
        {};

      const persistedContext: PersistedIntentContext = {
        fromIntent: intent,
        summary: outputSummary,
        decisions:
          (options.metadata?.["decisions"] as string[] | undefined) ?? [],
        relevantFiles,
        workingState,
        transferredAt: Date.now(),
        tokenEstimate:
          (options.tokenUsage?.input ?? 0) + (options.tokenUsage?.output ?? 0),
      };

      await options.workerOptions.contextTransfer.save(
        sessionId,
        persistedContext,
      );
      await options.workerOptions.runStore.addLog(options.job.runId, {
        level: "info",
        phase: "context-transfer",
        message: `Saved context for intent "${intent}"`,
        data: { tokenEstimate: persistedContext.tokenEstimate },
      });
    }
  } catch (_err) {
    await options.workerOptions.runStore
      .addLog(options.job.runId, {
        level: "warn",
        phase: "context-transfer",
        message: "Failed to save context after run",
        data: { error: _err instanceof Error ? _err.message : String(_err) },
      })
      .catch(() => {
        /* swallow nested failure */
      });
  }
}
