import { randomUUID } from "node:crypto";
import type { DzupEventBus } from "@dzupagent/core/events";
import type { AgentExecutionSpec, RunStore } from "@dzupagent/core/persistence";
import type { CostLedgerClient } from "@dzupagent/agent";
import type { RunTraceStore } from "../persistence/run-trace-store.js";
import type { RunJob } from "../queue/run-queue.js";
import type { InputGuard } from "../security/input-guard.js";
import type { TenantRunQuota } from "../security/tenant-run-quota.js";
import { closeTraceWithTerminalStep } from "./run-stages-utils.js";
import { recordPendingContact } from "./pending-contacts.js";

/** Default per-tenant concurrent-run cap when none is supplied on the job. */
const DEFAULT_TENANT_RUN_LIMIT = 20;

/**
 * P3 — return a derived agent spec with the distributed guardrail client
 * attached as both the fleet-wide rate-limiter and cost-ledger backend.
 *
 * The incoming spec is NEVER mutated: a shallow copy is layered so callers
 * (and the cached registry/store object) keep their original guardrails.
 * When no client is supplied the original spec is returned unchanged so the
 * single-node path is byte-for-byte identical to its prior behaviour.
 */
function withDistributedGuardrails(
  agent: AgentExecutionSpec,
  guardrailClient: CostLedgerClient | undefined,
  guardrailMaxCostUsd?: number
): AgentExecutionSpec {
  if (!guardrailClient) return agent;
  const guardrails = (agent.guardrails ?? {}) as Record<string, unknown>;
  const distributed = (guardrails["distributed"] ?? {}) as Record<
    string,
    unknown
  >;
  const costLedger =
    (distributed["costLedger"] as Record<string, unknown>) ?? {};
  return {
    ...agent,
    guardrails: {
      ...guardrails,
      distributed: {
        ...distributed,
        rateLimiter: {
          ...((distributed["rateLimiter"] as Record<string, unknown>) ?? {}),
          client: guardrailClient,
        },
        costLedger: {
          ...costLedger,
          client: guardrailClient,
          // AGENT-H-28: apply the deployment-wide ceiling. A per-agent spec
          // value wins, so an agent can tighten (or widen) its own cap; the
          // server default only fills the gap. Absent on both ⇒ the ledger's
          // own `Infinity` default (track-only), unchanged.
          ...(costLedger["maxCostUsd"] === undefined &&
          guardrailMaxCostUsd !== undefined
            ? { maxCostUsd: guardrailMaxCostUsd }
            : {}),
        },
      },
    },
  };
}

import { stampTenant } from "./tenant-event-stamp.js";

export type AdmissionStageResult =
  | { agent: AgentExecutionSpec; input: unknown; rejected: false }
  | { agent?: AgentExecutionSpec; input: unknown; rejected: true };

export async function runAdmissionStage(options: {
  job: RunJob;
  inputGuard: InputGuard | null;
  runStore: RunStore;
  eventBus: DzupEventBus;
  traceStore?: RunTraceStore;
  resolveAgent(agentId: string): Promise<AgentExecutionSpec | null>;
  /**
   * P3 — optional fleet-wide guardrail backend. When present, the resolved
   * agent spec is returned with `guardrails.distributed.{rateLimiter,costLedger}.client`
   * set to this client (without mutating the original spec) so the executor
   * shares one rate-limit window and one cost ceiling across replicas.
   */
  guardrailClient?: CostLedgerClient;
  /**
   * AGENT-H-28 — deployment-wide cumulative spend ceiling in USD. Applied to
   * the derived spec's `costLedger.maxCostUsd` unless the agent spec already
   * carries its own value.
   */
  guardrailMaxCostUsd?: number;
  /**
   * Stage 4-D — optional per-tenant concurrent-run cap. When present and the
   * job carries a `metadata.tenantId`, the tenant's active count is checked
   * against `metadata.tenantRunLimit` (default {@link DEFAULT_TENANT_RUN_LIMIT})
   * before the run is admitted. Over-limit runs are rejected with
   * `TENANT_QUOTA_EXCEEDED`. On admission the active count is incremented; the
   * run-worker decrements it at any terminal state.
   */
  tenantRunQuota?: TenantRunQuota;
}): Promise<AdmissionStageResult> {
  const resolvedAgent = await options.resolveAgent(options.job.agentId);
  const agent = resolvedAgent
    ? withDistributedGuardrails(
        resolvedAgent,
        options.guardrailClient,
        options.guardrailMaxCostUsd
      )
    : resolvedAgent;
  if (!agent) {
    await options.runStore.update(options.job.runId, {
      status: "failed",
      error: `Agent "${options.job.agentId}" not found`,
      completedAt: new Date(),
    });
    options.eventBus.emit(
      stampTenant(
        {
          type: "agent:failed",
          agentId: options.job.agentId,
          runId: options.job.runId,
          errorCode: "REGISTRY_AGENT_NOT_FOUND",
          message: `Agent "${options.job.agentId}" not found`,
        },
        options.job
      )
    );
    return { input: options.job.input, rejected: true };
  }

  // Stage 4-D — per-tenant concurrent-run cap. Only enforced when a quota is
  // wired in AND the job carries a tenant id; single-tenant deployments and
  // jobs without a tenant fall through unchanged.
  const tenantId =
    typeof options.job.metadata?.["tenantId"] === "string"
      ? (options.job.metadata["tenantId"] as string)
      : undefined;
  if (options.tenantRunQuota && tenantId !== undefined) {
    const limit =
      typeof options.job.metadata?.["tenantRunLimit"] === "number"
        ? (options.job.metadata["tenantRunLimit"] as number)
        : DEFAULT_TENANT_RUN_LIMIT;
    const verdict = options.tenantRunQuota.check(tenantId, limit);
    if (!verdict.allowed) {
      const reason =
        verdict.reason ??
        `Tenant "${tenantId}" concurrent-run limit reached (${verdict.active}/${verdict.limit}).`;
      await options.runStore.update(options.job.runId, {
        status: "rejected",
        error: reason,
        completedAt: new Date(),
      });
      await options.runStore.addLog(options.job.runId, {
        level: "warn",
        phase: "security",
        message: `Run rejected by tenant quota: ${reason}`,
        data: { active: verdict.active, limit: verdict.limit },
      });
      options.eventBus.emit(
        stampTenant(
          {
            type: "agent:failed",
            agentId: options.job.agentId,
            runId: options.job.runId,
            errorCode: "TENANT_QUOTA_EXCEEDED",
            message: reason,
          },
          options.job
        )
      );
      await closeTraceWithTerminalStep(
        options.traceStore,
        options.job.runId,
        "rejected",
        { reason, guardedBy: "tenant-run-quota" }
      );
      return { agent, input: options.job.input, rejected: true };
    }
  }

  // Admit the run: reserve a slot in the tenant's concurrent-run budget. The
  // run-worker releases it (decrement) at any terminal state.
  const admitRun = (): void => {
    if (options.tenantRunQuota && tenantId !== undefined) {
      options.tenantRunQuota.increment(tenantId);
    }
  };

  let input: unknown = options.job.input;
  if (!options.inputGuard) {
    admitRun();
    return { agent, input, rejected: false };
  }

  const guardResult = await options.inputGuard.scan(options.job.input);
  if (!guardResult.allowed) {
    const reason = guardResult.reason ?? "Rejected by input guard";
    await options.runStore.update(options.job.runId, {
      status: "rejected",
      error: reason,
      completedAt: new Date(),
    });
    await options.runStore.addLog(options.job.runId, {
      level: "warn",
      phase: "security",
      message: `Input guard rejected run: ${reason}`,
      data: {
        violations: guardResult.violations?.map((v) => ({
          category: v.category,
          severity: v.severity,
          action: v.action,
        })),
      },
    });
    options.eventBus.emit(
      stampTenant(
        {
          type: "agent:failed",
          agentId: options.job.agentId,
          runId: options.job.runId,
          errorCode: "POLICY_DENIED",
          message: reason,
        },
        options.job
      )
    );
    await closeTraceWithTerminalStep(
      options.traceStore,
      options.job.runId,
      "rejected",
      { reason, guardedBy: "input-guard" }
    );
    return { agent, input, rejected: true };
  }

  if (guardResult.redactedInput !== undefined) {
    input = guardResult.redactedInput;
    await options.runStore.update(options.job.runId, { input });
    await options.runStore.addLog(options.job.runId, {
      level: "info",
      phase: "security",
      message: "Input guard redacted PII in run input",
    });
  }

  admitRun();
  return { agent, input, rejected: false };
}

export async function waitForRunApproval(options: {
  agent: AgentExecutionSpec;
  job: RunJob;
  input: unknown;
  runStore: RunStore;
  eventBus: DzupEventBus;
  traceStore?: RunTraceStore;
}): Promise<boolean> {
  if (options.agent.approval !== "required") {
    return true;
  }

  const timeoutMs =
    typeof options.job.metadata?.["approvalTimeoutMs"] === "number"
      ? Number(options.job.metadata["approvalTimeoutMs"])
      : 60_000;

  // Name this approval request so a grant can be scoped to it. Recording it
  // as an outstanding contact is what lets the respond route reject ids it
  // never issued (DZUPAGENT-AGENT-H-14).
  const contactId = randomUUID();

  await options.runStore.update(options.job.runId, {
    status: "awaiting_approval",
    plan: { input: options.input, metadata: options.job.metadata },
  });
  await recordPendingContact(
    options.runStore,
    options.job.runId,
    contactId
  );
  await options.runStore.addLog(options.job.runId, {
    level: "info",
    phase: "approval",
    message: "Awaiting approval before execution",
    data: { timeoutMs, contactId },
  });
  options.eventBus.emit(
    stampTenant(
      {
        type: "approval:requested",
        runId: options.job.runId,
        contactId,
        plan: { input: options.input },
      },
      options.job
    )
  );

  const decision = await waitForApprovalDecision(
    options.eventBus,
    options.job.runId,
    contactId,
    timeoutMs
  );
  if (!decision.approved) {
    await options.runStore.update(options.job.runId, {
      status: "rejected",
      error: decision.reason ?? "Rejected by policy",
      completedAt: new Date(),
    });
    await options.runStore.addLog(options.job.runId, {
      level: "warn",
      phase: "approval",
      message: `Run rejected before execution: ${
        decision.reason ?? "no reason provided"
      }`,
    });
    options.eventBus.emit(
      stampTenant(
        {
          type: "agent:failed",
          agentId: options.job.agentId,
          runId: options.job.runId,
          errorCode: "APPROVAL_REJECTED",
          message: decision.reason ?? "Run rejected by approval policy",
        },
        options.job
      )
    );
    await closeTraceWithTerminalStep(
      options.traceStore,
      options.job.runId,
      "rejected",
      { reason: decision.reason ?? "Run rejected by approval policy" }
    );
    return false;
  }

  await options.runStore.update(options.job.runId, { status: "running" });
  await options.runStore.addLog(options.job.runId, {
    level: "info",
    phase: "approval",
    message: "Approval granted, proceeding with execution",
  });
  return true;
}

async function waitForApprovalDecision(
  eventBus: DzupEventBus,
  runId: string,
  contactId: string,
  timeoutMs: number
): Promise<{ approved: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const unsubGrant = eventBus.on("approval:granted", (event) => {
      if (event.runId !== runId) return;
      // A grant that names a different contact is answering a different
      // request and must not admit this run (DZUPAGENT-AGENT-H-14).
      if (event.contactId !== undefined && event.contactId !== contactId) {
        return;
      }
      unsubGrant();
      unsubReject();
      clearTimeout(timer);
      resolve({ approved: true });
    });

    const unsubReject = eventBus.on("approval:rejected", (event) => {
      if (event.runId !== runId) return;
      // A rejection naming a different contact is answering a different
      // request and must not deny this run -- the mirror of the grant rule
      // above (DZUPAGENT-AGENT-H-14).
      if (event.contactId !== undefined && event.contactId !== contactId) {
        return;
      }
      unsubGrant();
      unsubReject();
      clearTimeout(timer);
      resolve({ approved: false, reason: event.reason });
    });

    const timer = setTimeout(() => {
      unsubGrant();
      unsubReject();
      resolve({
        approved: false,
        reason: `Approval timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
  });
}
