import { SpawnGate, validateBatchScope } from "../governance/spawn-gate.js";
import type {
  SpawnBatchRequest,
  SpawnPolicy,
} from "../governance/spawn-gate.js";
import type { SubagentSpec } from "../contracts/background-task.js";
import type { FanoutEvalResult, FanoutScorer } from "./types.js";

/**
 * Ground truth for a single spawn-decision eval case: a batch admission
 * request plus a set of per-item specs the coordinator would dispatch under
 * that template, paired with the EXPECTED outcome for each.
 *
 * The scorer runs the REAL `SpawnGate` (the same class `fanout-tool.ts` and
 * `background-subagent-runtime.ts` call in production) against `request`,
 * then — if the batch is admitted — runs `validateBatchScope` on each item
 * against the admitted template. This is not a re-implementation of the
 * gate's logic; it drives the actual gate and diffs its answer against the
 * declared expectation, so the eval fails the moment the gate's real
 * behaviour drifts from the documented invariant.
 */
export interface SpawnDecisionCase {
  /** Policy under test (e.g. an allow-all, deny-all, or scope-aware policy). */
  policy: SpawnPolicy;
  /** The batch-level admission request a fan-out coordinator would submit. */
  request: SpawnBatchRequest;
  /** Expected batch-level outcome. */
  expectedBatchOutcome: "allowed" | "needs_approval" | "denied";
  /**
   * Per-item specs to scope-check against the admitted template, each with
   * the expected per-item outcome. Only evaluated when the batch itself is
   * admitted (allowed or needs_approval) — a denied batch has no per-item
   * decisions to make (Spec 01/03: zero spawns on denial).
   */
  items?: Array<{
    key: string;
    spec: SubagentSpec;
    expectedOutcome: "allowed" | "denied";
    expectedDenialReason?: string;
  }>;
}

/**
 * Spawn-decision-quality scorer (fanout eval area 1). Ground truth is
 * `validateBatchScope`'s documented invariants plus the policy's own
 * allow/deny/needs-approval contract — both exercised through the real
 * `SpawnGate`, never re-derived heuristically.
 */
export function createSpawnDecisionScorer(): FanoutScorer<SpawnDecisionCase> {
  return {
    config: {
      id: "fanout-spawn-decision-quality",
      name: "Spawn Decision Quality",
      description:
        "Checks SpawnGate.evaluateBatch's admission decision and, for admitted " +
        "batches, validateBatchScope's per-item narrowing decisions against " +
        "declared expectations.",
      type: "deterministic",
    },
    async score(input: SpawnDecisionCase): Promise<FanoutEvalResult> {
      const gate = new SpawnGate(input.policy);
      const admission = await gate.evaluateBatch(input.request);

      if (admission.outcome !== input.expectedBatchOutcome) {
        return {
          score: 0,
          pass: false,
          reasoning:
            `Batch admission mismatch: expected "${input.expectedBatchOutcome}" ` +
            `but SpawnGate returned "${admission.outcome}"` +
            (admission.outcome === "denied" ? ` (${admission.reason})` : ""),
          metadata: { admission },
        };
      }

      // A denied batch has no per-item decisions to check — zero spawns is
      // the correct, complete outcome (fanout-tool.ts denies the whole batch
      // before any item is dispatched).
      if (admission.outcome === "denied") {
        return {
          score: 1,
          pass: true,
          reasoning: "Batch correctly denied before any per-item spawn.",
          metadata: { admission },
        };
      }

      const items = input.items ?? [];
      if (items.length === 0) {
        return {
          score: 1,
          pass: true,
          reasoning:
            "Batch admission matched expectation; no per-item cases declared.",
          metadata: { admission },
        };
      }

      const mismatches: Array<{
        key: string;
        expected: string;
        actual: string;
        reason?: string;
      }> = [];

      for (const item of items) {
        const scope = validateBatchScope(item.spec, input.request.template);
        const actualOutcome = scope.allow ? "allowed" : "denied";
        if (actualOutcome !== item.expectedOutcome) {
          mismatches.push({
            key: item.key,
            expected: item.expectedOutcome,
            actual: actualOutcome,
            ...(scope.allow ? {} : { reason: scope.reason }),
          });
          continue;
        }
        if (
          !scope.allow &&
          item.expectedDenialReason !== undefined &&
          scope.reason !== item.expectedDenialReason
        ) {
          mismatches.push({
            key: item.key,
            expected: `denied:${item.expectedDenialReason}`,
            actual: `denied:${scope.reason}`,
          });
        }
      }

      if (mismatches.length > 0) {
        return {
          score: 1 - mismatches.length / items.length,
          pass: false,
          reasoning:
            `${mismatches.length}/${items.length} per-item scope decisions ` +
            `did not match expectations.`,
          metadata: { admission, mismatches },
        };
      }

      return {
        score: 1,
        pass: true,
        reasoning:
          `Batch admission and all ${items.length} per-item scope decisions ` +
          `matched expectations.`,
        metadata: { admission },
      };
    },
  };
}
