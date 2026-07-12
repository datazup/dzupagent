/**
 * POST /api/runs — create a new run and optionally enqueue it for execution.
 *
 * Extracted from `routes/runs.ts` (RF-22). The handler validates the request
 * body, runs the input-guard, performs quota admission, classifies the input
 * via the optional cost-aware router, sanitises caller-supplied metadata,
 * stamps owner / tenant ids, persists the run record, and either enqueues to
 * the configured `runQueue` or emits the `agent:started` event for in-process
 * execution.
 */
import type { Context } from "hono";
import { injectTraceContext } from "@dzupagent/core/utils";

import type { ForgeServerConfig } from "../../composition/types.js";
import type { AppEnv } from "../../types.js";
import { createInputGuard } from "../../security/input-guard.js";
import {
  sanitizeRunForResponse,
  sanitizeRunMetadataForPersistence,
} from "../../security/run-metadata-secrets.js";
import { getSerializedJsonSizeBytes } from "../../validation/route-validator.js";
import { RunCreateSchema, validateBodyCompat } from "../schemas.js";
import {
  RUN_INPUT_MAX_BYTES,
  RUN_METADATA_MAX_BYTES,
  getRequestingKeyId,
  getRequestingTenantId,
} from "./shared.js";

/** POST /api/runs — create a new run and optionally enqueue it. */
export async function handleCreateRun(
  c: Context,
  config: ForgeServerConfig
): Promise<Response> {
  const { runStore, eventBus, executableAgentResolver } = config;

  const parsed = await validateBodyCompat(c, RunCreateSchema);
  if (parsed instanceof Response) return parsed;
  const body = parsed;

  // Guard against oversized metadata payloads before any database writes.
  // 64 KB is ample for routing hints, trace context, and user tags while
  // keeping rogue clients from bloating the run record.
  if (getSerializedJsonSizeBytes(body.input) > RUN_INPUT_MAX_BYTES) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "input too large (max 256 KB)",
        },
      },
      400
    );
  }

  if (
    body.metadata &&
    getSerializedJsonSizeBytes(body.metadata) > RUN_METADATA_MAX_BYTES
  ) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "metadata too large (max 64 KB)",
        },
      },
      400
    );
  }

  let admittedInput: unknown = body.input;
  let inputWasRedacted = false;
  if (config.security?.inputGuard !== false) {
    const inputGuard = createInputGuard(config.security?.inputGuard);
    const guardResult = await inputGuard.scan(body.input);
    if (!guardResult.allowed) {
      return c.json(
        {
          error: {
            code: "SECURITY_POLICY_DENIED",
            message: guardResult.reason ?? "Rejected by input guard",
          },
        },
        400
      );
    }
    if (guardResult.redactedInput !== undefined) {
      admittedInput = guardResult.redactedInput;
      inputWasRedacted = true;
    }
  }

  const agent = executableAgentResolver
    ? await executableAgentResolver.resolve(body.agentId)
    : await config.agentStore.get(body.agentId);
  if (!agent) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Agent not found" } },
      404
    );
  }

  // R3-ISO-02: an authenticated caller may only execute agents in its own
  // tenant scope. Agents without a recorded tenant (pre-MC-S02 rows) stay
  // executable by everyone, mirroring the legacy-ownerless leniency in
  // enforceOwnerAccess. Respond 404 (not 403) so agent ids are not probeable.
  const requestingApiKey = (c as Context<AppEnv>).get("apiKey");
  if (
    requestingApiKey &&
    typeof agent.tenantId === "string" &&
    agent.tenantId.length > 0 &&
    agent.tenantId !== getRequestingTenantId(c)
  ) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Agent not found" } },
      404
    );
  }

  // MC-S01: Enforce the per-key hourly token budget before accepting the
  // run. The API key record carries both a per-run cap (`maxTokensPerRun`)
  // and an hourly ceiling (`maxRunsPerHour`, expressed in tokens). We use
  // the per-run cap as the estimate so rejection happens up-front if the
  // caller would blow through their budget. When no quota manager is
  // configured this block is a no-op — preserving the library default.
  //
  // We also project `guardrails.maxTokens` onto the run metadata so the
  // executor enforces the same cap. When the caller already supplied a
  // tighter limit we keep theirs (the smaller of the two).
  const apiKey = requestingApiKey;
  const rawPerRunCap = apiKey?.["maxTokensPerRun"];
  const perRunCap =
    typeof rawPerRunCap === "number" &&
    Number.isFinite(rawPerRunCap) &&
    rawPerRunCap > 0
      ? Math.floor(rawPerRunCap)
      : null;
  const rawHourlyLimit = apiKey?.["maxRunsPerHour"];
  const hourlyLimit =
    typeof rawHourlyLimit === "number" &&
    Number.isFinite(rawHourlyLimit) &&
    rawHourlyLimit > 0
      ? Math.floor(rawHourlyLimit)
      : null;

  if (config.resourceQuota) {
    const keyId = getRequestingKeyId(c) ?? getRequestingTenantId(c);
    const estimate = perRunCap ?? 0;
    const decision = config.resourceQuota.checkQuota(
      keyId,
      estimate,
      hourlyLimit
    );
    if (!decision.allowed) {
      return c.json(
        {
          error: {
            code: "QUOTA_EXCEEDED",
            message: decision.reason ?? "Token quota exceeded",
          },
        },
        429
      );
    }
  }

  // --- Cost-aware routing: classify input to determine optimal model tier ---
  let routingMetadata: Record<string, unknown> = {};
  if (config.router) {
    const inputObj = admittedInput as
      | Record<string, unknown>
      | null
      | undefined;
    const text =
      typeof admittedInput === "string"
        ? admittedInput
        : inputObj && typeof inputObj === "object" && !Array.isArray(inputObj)
        ? typeof inputObj["message"] === "string"
          ? inputObj["message"]
          : typeof inputObj["content"] === "string"
          ? inputObj["content"]
          : typeof inputObj["prompt"] === "string"
          ? inputObj["prompt"]
          : JSON.stringify(admittedInput)
        : JSON.stringify(admittedInput ?? "");

    try {
      const result = await config.router.classify(text);
      routingMetadata = {
        modelTier: result.modelTier,
        routingReason: result.routingReason,
        complexity: result.complexity,
      };

      // Track routing decision distribution
      config.metrics?.increment("forge_routing_total", {
        tier: result.modelTier,
        reason: result.routingReason,
        complexity: result.complexity,
      });
    } catch {
      // Router failure is non-fatal — fall through without routing metadata
    }
  }

  const sanitizedRequestMetadata =
    sanitizeRunMetadataForPersistence(body.metadata) ?? {};
  const mergedMetadata: Record<string, unknown> = {
    ...sanitizedRequestMetadata,
    ...routingMetadata,
  };

  // MC-S01: project the per-key `maxTokensPerRun` onto `guardrails.maxTokens`
  // so the executor enforces the same ceiling that the quota admission
  // check used. Keep the caller's value when it is tighter — never
  // upgrade a caller-specified cap to the key's (looser) ceiling.
  if (perRunCap !== null) {
    const existingGuardrails =
      mergedMetadata["guardrails"] &&
      typeof mergedMetadata["guardrails"] === "object"
        ? (mergedMetadata["guardrails"] as Record<string, unknown>)
        : {};
    const existingMax =
      typeof existingGuardrails["maxTokens"] === "number"
        ? (existingGuardrails["maxTokens"] as number)
        : undefined;
    const finalMax =
      typeof existingMax === "number"
        ? Math.min(existingMax, perRunCap)
        : perRunCap;
    mergedMetadata["guardrails"] = {
      ...existingGuardrails,
      maxTokens: finalMax,
    };
  }

  // Inject trace context so every run has a traceId from birth.
  // injectTraceContext is idempotent — if metadata already has _trace, it's preserved.
  let tracedMetadata: Record<string, unknown>;
  try {
    tracedMetadata = injectTraceContext(mergedMetadata);
  } catch {
    // Trace injection is non-fatal — proceed without it
    tracedMetadata = mergedMetadata;
  }

  // RF-S02: stamp the owning API key on creation so downstream handlers can
  // reject cross-key access. When auth is disabled, ownerId is null and
  // every caller is allowed through — preserving the library default.
  const ownerId = getRequestingKeyId(c) ?? null;

  // MC-S02: carry the tenant scope from the authenticated key so list
  // queries can isolate runs between tenants.
  const tenantId = getRequestingTenantId(c);

  // R3-ISO-01: the worker pipeline (cost ledger, event stamping, reflection
  // attribution, context transfer) reads tenant/owner from `job.metadata`.
  // Server-side stamp always wins (mirrors benchmark-tenant-scope) so an
  // authenticated caller cannot spoof another tenant's id through metadata.
  // When auth is disabled there is no authority — caller metadata passes
  // through untouched, preserving the library default.
  if (apiKey) {
    tracedMetadata["tenantId"] = tenantId;
    if (ownerId) {
      tracedMetadata["ownerId"] = ownerId;
    } else {
      // No key id to attribute to — drop any caller-supplied ownerId rather
      // than let quota/reflection attribution follow a spoofed value.
      delete tracedMetadata["ownerId"];
    }
  }

  const run = await runStore.create({
    agentId: body.agentId,
    input: admittedInput,
    metadata: tracedMetadata,
    ownerId,
    tenantId,
  });

  if (inputWasRedacted) {
    await runStore.addLog(run.id, {
      level: "info",
      phase: "security",
      message: "Input guard redacted PII in run input",
    });
  }

  if (config.runQueue) {
    if (!config.runExecutor) {
      return c.json(
        {
          error: {
            code: "RUN_EXECUTOR_NOT_CONFIGURED",
            message: "runQueue is configured but no runExecutor is available",
          },
        },
        503
      );
    }

    const metadata = run.metadata ?? {};
    const priorityRaw =
      typeof metadata["priority"] === "number" ? metadata["priority"] : 5;
    const priority = Number.isFinite(priorityRaw)
      ? Math.max(0, Math.floor(priorityRaw))
      : 5;

    const job = await config.runQueue.enqueue({
      runId: run.id,
      agentId: run.agentId,
      input: run.input,
      metadata: run.metadata,
      // R3-ISO-01: queue-level tenant, stamped from the run record (which in
      // turn carries the authenticated key's tenant), so consumers do not
      // have to trust `metadata.tenantId`.
      ...(run.tenantId ? { tenantId: run.tenantId } : {}),
      priority,
    });

    await runStore.addLog(run.id, {
      level: "info",
      phase: "queue",
      message: "Run enqueued",
      data: { jobId: job.id, priority },
    });

    return c.json(
      {
        data: sanitizeRunForResponse(run),
        queue: { accepted: true, jobId: job.id, priority },
      },
      202
    );
  }

  eventBus.emit({ type: "agent:started", agentId: run.agentId, runId: run.id });

  return c.json({ data: sanitizeRunForResponse(run) }, 201);
}
