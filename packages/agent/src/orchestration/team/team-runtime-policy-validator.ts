/**
 * Policy validation for `TeamRuntime`.
 *
 * Extracted from `team-runtime.ts` so the dispatcher class stays focused
 * on orchestration. The validator is a pure function: it inspects the
 * supplied policies + coordinator pattern and throws if anything is
 * unsupported or malformed.
 *
 * The validator is a *shape + scope* gate, not a feature gate: for policy
 * fields that have a runtime meaning behind a host-injected service (governance
 * / evaluation acceptance gates), it validates the field shape and pattern
 * scope but does NOT reject them — the runtime treats them as inert no-ops when
 * the corresponding service is unwired (mirroring `memory.consolidateOnComplete`).
 * Policy groups with no in-repo runtime consumer at all (isolation / mailbox),
 * and individual scoped-out fields within an otherwise-enforced group
 * (memory.tier / memory.shareAcrossParticipants), are still shape-checked so a
 * malformed declaration fails fast, and documented as consuming-app concerns in
 * `team-policy.ts`.
 */

import type { CoordinatorPattern } from "./team-definition.js";
import type { TeamPolicies } from "./team-policy.js";

/**
 * Validate `TeamPolicies` against the team's coordinator pattern.
 *
 * Throws when:
 *   - an execution policy has a malformed timeoutMs / maxParallelParticipants
 *     value, uses participant retry (retryOnFailure / maxRetries) outside the
 *     'peer_to_peer' pattern where it is enforced, or sets maxRetries without
 *     enabling retryOnFailure;
 *   - a governance policy is supplied for a non-council pattern, or has a
 *     malformed minScore;
 *   - a memory policy is supplied for a non-blackboard pattern, has a malformed
 *     tier / shareAcrossParticipants (shape-checked only — no in-repo runtime
 *     consumer), or contains a malformed blackboardContext budget;
 *   - a contractNet policy is supplied for a non-contract_net pattern, or has a
 *     malformed maxCostCents / bidDeadlineMs / requiredCapabilities /
 *     retryOnNoBids (all fully enforced by ContractNetManager);
 *   - an evaluation policy has a malformed minPassScore or empty scorerModel;
 *   - an isolation / mailbox policy is malformed (both groups are shape-checked
 *     but have no in-repo runtime consumer — see team-policy.ts).
 */
export function validateTeamPolicies(
  pattern: CoordinatorPattern,
  policies: TeamPolicies
): void {
  validateExecutionPolicy(pattern, policies);
  validateGovernancePolicy(pattern, policies);
  validateMemoryPolicy(pattern, policies);
  validateContractNetPolicy(pattern, policies);
  validateIsolationPolicy(policies);
  validateMailboxPolicy(policies);
  validateEvaluationPolicy(policies);
}

function validateExecutionPolicy(
  pattern: CoordinatorPattern,
  policies: TeamPolicies
): void {
  const execution = policies.execution;
  if (!execution) return;

  if (
    execution.timeoutMs !== undefined &&
    (!Number.isInteger(execution.timeoutMs) || execution.timeoutMs < 1)
  ) {
    throw new Error(
      "TeamRuntime execution policy field 'timeoutMs' must be a positive integer"
    );
  }

  const usesRetry =
    execution.retryOnFailure !== undefined ||
    execution.maxRetries !== undefined;
  if (usesRetry && pattern !== "peer_to_peer") {
    throw new Error(
      "TeamRuntime execution policy participant retry (retryOnFailure / maxRetries) is only supported for coordinator pattern 'peer_to_peer'"
    );
  }
  if (
    execution.retryOnFailure !== undefined &&
    typeof execution.retryOnFailure !== "boolean"
  ) {
    throw new Error(
      "TeamRuntime execution policy field 'retryOnFailure' must be a boolean"
    );
  }
  if (execution.maxRetries !== undefined) {
    if (!Number.isInteger(execution.maxRetries) || execution.maxRetries < 1) {
      throw new Error(
        "TeamRuntime execution policy field 'maxRetries' must be a positive integer"
      );
    }
    if (execution.retryOnFailure !== true) {
      throw new Error(
        "TeamRuntime execution policy field 'maxRetries' requires 'retryOnFailure' to be true"
      );
    }
  }

  const maxParallel = execution.maxParallelParticipants;
  if (
    maxParallel !== undefined &&
    (!Number.isInteger(maxParallel) || maxParallel < 1)
  ) {
    throw new Error(
      "TeamRuntime execution policy field 'maxParallelParticipants' must be a positive integer"
    );
  }
}

function validateGovernancePolicy(
  pattern: CoordinatorPattern,
  policies: TeamPolicies
): void {
  const governance = policies.governance;
  if (!governance) return;

  if (pattern !== "council") {
    throw new Error(
      "TeamRuntime governance policy group is only supported for coordinator pattern 'council'"
    );
  }
  // minScore / requireUnanimous are enforced by the governance acceptance gate
  // when a `TeamGovernanceService` is injected (inert no-op otherwise). Shape-
  // check only.
  assertScoreInUnitInterval(
    governance.minScore,
    "governance policy field 'minScore'"
  );
  if (
    governance.requireUnanimous !== undefined &&
    typeof governance.requireUnanimous !== "boolean"
  ) {
    throw new Error(
      "TeamRuntime governance policy field 'requireUnanimous' must be a boolean"
    );
  }
}

function validateMemoryPolicy(
  pattern: CoordinatorPattern,
  policies: TeamPolicies
): void {
  const memory = policies.memory;
  if (!memory) return;

  if (pattern !== "blackboard") {
    throw new Error(
      "TeamRuntime memory policy group is only supported for coordinator pattern 'blackboard'"
    );
  }

  // `tier` and `shareAcrossParticipants` have no in-repo runtime consumer — the
  // runtime owns no store whose lifetime/sharing they could select (see
  // team-policy.ts). Both are required on the interface, so a JS caller or a
  // JSON-loaded policy can still supply a missing/malformed value that
  // TypeScript never sees. Shape-check only.
  const tiers = ["ephemeral", "session", "persistent"] as const;
  if (!tiers.includes(memory.tier)) {
    throw new Error(
      "TeamRuntime memory policy field 'tier' must be one of 'ephemeral' | 'session' | 'persistent'"
    );
  }
  if (typeof memory.shareAcrossParticipants !== "boolean") {
    throw new Error(
      "TeamRuntime memory policy field 'shareAcrossParticipants' must be a boolean"
    );
  }

  const blackboardContext = memory.blackboardContext;
  if (!blackboardContext) return;

  if (
    blackboardContext.maxSerializedChars !== undefined &&
    (!Number.isInteger(blackboardContext.maxSerializedChars) ||
      blackboardContext.maxSerializedChars < 1)
  ) {
    throw new Error(
      "TeamRuntime memory policy field 'blackboardContext.maxSerializedChars' must be a positive integer"
    );
  }
  if (
    blackboardContext.maxEntryChars !== undefined &&
    (!Number.isInteger(blackboardContext.maxEntryChars) ||
      blackboardContext.maxEntryChars < 1)
  ) {
    throw new Error(
      "TeamRuntime memory policy field 'blackboardContext.maxEntryChars' must be a positive integer"
    );
  }
}

/**
 * Validate the `contractNet` policy group.
 *
 * Unlike governance / evaluation (host-injected-service seams) every field here
 * is threaded straight into `ContractNetManager.execute` and is genuinely
 * enforced, so this is a pure shape + scope gate on fields that really bite.
 * The group is scoped to the `contract_net` pattern for the same reason
 * `memory` is scoped to `blackboard`: no other pattern runs a negotiation these
 * knobs could steer, so accepting them elsewhere would silently do nothing.
 */
function validateContractNetPolicy(
  pattern: CoordinatorPattern,
  policies: TeamPolicies
): void {
  const contractNet = policies.contractNet;
  if (!contractNet) return;

  if (pattern !== "contract_net") {
    throw new Error(
      "TeamRuntime contractNet policy group is only supported for coordinator pattern 'contract_net'"
    );
  }

  const { maxCostCents, bidDeadlineMs, requiredCapabilities, retryOnNoBids } =
    contractNet;

  if (
    maxCostCents !== undefined &&
    (typeof maxCostCents !== "number" ||
      !Number.isFinite(maxCostCents) ||
      maxCostCents < 0)
  ) {
    throw new Error(
      "TeamRuntime contractNet policy field 'maxCostCents' must be a non-negative finite number"
    );
  }

  if (
    bidDeadlineMs !== undefined &&
    (!Number.isInteger(bidDeadlineMs) || bidDeadlineMs < 1)
  ) {
    throw new Error(
      "TeamRuntime contractNet policy field 'bidDeadlineMs' must be a positive integer"
    );
  }

  if (requiredCapabilities !== undefined) {
    if (
      !Array.isArray(requiredCapabilities) ||
      requiredCapabilities.some((c) => typeof c !== "string" || c.length === 0)
    ) {
      throw new Error(
        "TeamRuntime contractNet policy field 'requiredCapabilities' must be an array of non-empty strings"
      );
    }
  }

  if (retryOnNoBids !== undefined && typeof retryOnNoBids !== "boolean") {
    throw new Error(
      "TeamRuntime contractNet policy field 'retryOnNoBids' must be a boolean"
    );
  }
}

function validateEvaluationPolicy(policies: TeamPolicies): void {
  const evaluation = policies.evaluation;
  if (!evaluation) return;

  if (
    typeof evaluation.scorerModel !== "string" ||
    evaluation.scorerModel.length === 0
  ) {
    throw new Error(
      "TeamRuntime evaluation policy field 'scorerModel' must be a non-empty string"
    );
  }
  if (
    evaluation.scoringCriteria !== undefined &&
    (!Array.isArray(evaluation.scoringCriteria) ||
      evaluation.scoringCriteria.some((c) => typeof c !== "string"))
  ) {
    throw new Error(
      "TeamRuntime evaluation policy field 'scoringCriteria' must be an array of strings"
    );
  }
  // minPassScore is enforced by the evaluation acceptance gate when a
  // `TeamEvaluationService` is injected (inert no-op otherwise). Shape-check only.
  assertScoreInUnitInterval(
    evaluation.minPassScore,
    "evaluation policy field 'minPassScore'"
  );
}

/**
 * Shape-check the `isolation` policy group. Isolation (sandboxing / workspace
 * sharing) has no in-repo TeamRuntime consumer — the runtime spawns agents
 * in-process — so it is documented in team-policy.ts as a consuming-app concern
 * and only validated for shape here.
 */
function validateIsolationPolicy(policies: TeamPolicies): void {
  const isolation = policies.isolation;
  if (!isolation) return;

  if (typeof isolation.sandboxed !== "boolean") {
    throw new Error(
      "TeamRuntime isolation policy field 'sandboxed' must be a boolean"
    );
  }
  if (typeof isolation.sharedWorkspace !== "boolean") {
    throw new Error(
      "TeamRuntime isolation policy field 'sharedWorkspace' must be a boolean"
    );
  }
}

/**
 * Shape-check the `mailbox` policy group. Inter-participant mailbox routing is
 * not wired into team patterns in-repo (the `@dzupagent/agent/mailbox`
 * subsystem is host-driven), so mailbox is documented in team-policy.ts as a
 * consuming-app concern and only validated for shape here.
 */
function validateMailboxPolicy(policies: TeamPolicies): void {
  const mailbox = policies.mailbox;
  if (!mailbox) return;

  const modes = ["broadcast", "targeted", "round_robin"] as const;
  if (!modes.includes(mailbox.deliveryMode)) {
    throw new Error(
      "TeamRuntime mailbox policy field 'deliveryMode' must be one of 'broadcast' | 'targeted' | 'round_robin'"
    );
  }
  if (
    mailbox.maxQueueDepth !== undefined &&
    (!Number.isInteger(mailbox.maxQueueDepth) || mailbox.maxQueueDepth < 1)
  ) {
    throw new Error(
      "TeamRuntime mailbox policy field 'maxQueueDepth' must be a positive integer"
    );
  }
}

function assertScoreInUnitInterval(
  value: number | undefined,
  label: string
): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    Number.isNaN(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(`TeamRuntime ${label} must be a number in [0, 1]`);
  }
}
