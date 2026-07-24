/**
 * Policy validation for `TeamRuntime`.
 *
 * Extracted from `team-runtime.ts` so the dispatcher class stays focused
 * on orchestration. The validator is a pure function: it inspects the
 * supplied policies + coordinator pattern and throws if anything is
 * unsupported or malformed.
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
 *   - a governance policy is supplied for a non-council pattern, or uses a
 *     reserved field;
 *   - a memory policy is supplied for a non-blackboard pattern, or contains
 *     a malformed blackboardContext budget;
 *   - any of the unsupported policy groups (isolation / mailbox /
 *     evaluation) is non-empty.
 */
export function validateTeamPolicies(
  pattern: CoordinatorPattern,
  policies: TeamPolicies
): void {
  validateExecutionPolicy(pattern, policies);
  validateGovernancePolicy(pattern, policies);
  validateMemoryPolicy(pattern, policies);
  rejectUnsupportedPolicyGroup("isolation", policies.isolation);
  rejectUnsupportedPolicyGroup("mailbox", policies.mailbox);
  rejectUnsupportedPolicyGroup("evaluation", policies.evaluation);
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
  if (governance.minScore !== undefined) {
    throw new Error(
      "TeamRuntime governance policy field 'minScore' is not supported yet"
    );
  }
  if (governance.requireUnanimous !== undefined) {
    throw new Error(
      "TeamRuntime governance policy field 'requireUnanimous' is not supported yet"
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

function rejectUnsupportedPolicyGroup(
  group: "isolation" | "mailbox" | "evaluation",
  policy: unknown
): void {
  if (policy === undefined) return;
  throw new Error(`TeamRuntime policy group '${group}' is not supported yet`);
}
