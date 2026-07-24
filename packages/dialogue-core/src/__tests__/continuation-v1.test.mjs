import { describe, expect, it } from "vitest";

import {
  CONTINUATION_EVIDENCE_SCHEMA_V1,
  CONTINUATION_POLICY_SCHEMA_V1,
  CONTINUATION_PROPOSAL_SCHEMA_V1,
  canonicalizeContinuationValueV1,
  classifyContinuationAdmissionsV1,
  continuationTransitionAdmissionV1,
  createContinuationTaskKeyV1,
  evaluateContinuationTransitionV1,
  hashContinuationValueV1,
  normalizeContinuationProposalV1,
  normalizeContinuationTaskTextV1,
} from "../continuation/v1.ts";
import { parseDecisionBlock } from "../scheduler/decision-block.ts";

function proposal(overrides = {}) {
  return {
    schema: CONTINUATION_PROPOSAL_SCHEMA_V1,
    verdict: "continue",
    nextTask: "Implement one bounded contract test.",
    rationale: "One bounded task remains.",
    evidenceRefs: [],
    ...overrides,
  };
}

function evidence(overrides = {}) {
  const base = {
    schema: CONTINUATION_EVIDENCE_SCHEMA_V1,
    runIdentity: {
      runId: "run-1",
      planDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      policyDigest:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    progress: {
      iteration: 1,
      priorTaskKeys: [],
      requestedToolCalls: 1,
      successfulToolCalls: 1,
      failedToolCalls: 0,
    },
    validation: {
      status: "passed",
      verifiedRefs: ["validation:focused"],
    },
    blockers: [],
  };

  return {
    ...base,
    ...overrides,
    runIdentity: {
      ...base.runIdentity,
      ...(overrides.runIdentity ?? {}),
    },
    progress: {
      ...base.progress,
      ...(overrides.progress ?? {}),
    },
    validation: {
      ...base.validation,
      ...(overrides.validation ?? {}),
    },
  };
}

function policy(overrides = {}) {
  const base = {
    schema: CONTINUATION_POLICY_SCHEMA_V1,
    terminalBlocked: "allow",
    completionValidation: "passed_or_not_required",
    repeatedTask: {
      maxPriorOccurrences: 1,
      onLimit: "review_again",
    },
  };

  return {
    ...base,
    ...overrides,
    repeatedTask: {
      ...base.repeatedTask,
      ...(overrides.repeatedTask ?? {}),
    },
  };
}

function evaluate(rawProposal, overrides = {}) {
  return evaluateContinuationTransitionV1({
    proposal: normalizeContinuationProposalV1(rawProposal),
    evidence: overrides.evidence ?? evidence(),
    policy: overrides.policy ?? policy(),
    hostControl: overrides.hostControl ?? { action: "run" },
  });
}

describe("continuation v1 normalization", () => {
  it("normalizes a strict proposal object and records applied rules", () => {
    const result = normalizeContinuationProposalV1(
      proposal({
        nextTask: "  Implement the reducer.  ",
        rationale: "  It is the next bounded unit.  ",
      }),
    );

    expect(result).toMatchObject({
      status: "valid",
      appliedRules: ["direct_object", "trim_strings"],
      diagnostics: [],
      proposal: {
        verdict: "continue",
        nextTask: "Implement the reducer.",
        rationale: "It is the next bounded unit.",
      },
    });
  });

  it("accepts one exact JSON fence but rejects prose-wrapped JSON", () => {
    const fenced = normalizeContinuationProposalV1(
      `\`\`\`json\n${JSON.stringify(proposal())}\n\`\`\``,
    );
    const wrapped = normalizeContinuationProposalV1(
      `Decision follows: ${JSON.stringify(proposal())}`,
    );

    expect(fenced).toMatchObject({
      status: "valid",
      appliedRules: ["fenced_json"],
    });
    expect(wrapped).toEqual({
      schema: "dzupagent/continuation-normalization/v1",
      status: "invalid",
      appliedRules: ["json_text"],
      diagnostics: ["proposal.ambiguous_wrapper"],
    });
  });

  it.each([
    ["malformed JSON", "{", "proposal.malformed_json"],
    [
      "unknown verdict",
      proposal({ verdict: "proceed" }),
      "proposal.verdict_unknown",
    ],
    [
      "blank continue task",
      proposal({ nextTask: "   " }),
      "proposal.next_task_required",
    ],
    [
      "terminal task text",
      proposal({ verdict: "complete", nextTask: "one more thing" }),
      "proposal.next_task_must_be_empty",
    ],
    [
      "unknown field",
      proposal({ providerDecision: "continue" }),
      "proposal.unknown_field",
    ],
    [
      "duplicate evidence",
      proposal({ evidenceRefs: ["ref:1", "ref:1"] }),
      "proposal.evidence_ref_duplicate",
    ],
  ])("fails closed for %s", (_label, raw, expectedDiagnostic) => {
    const normalized = normalizeContinuationProposalV1(raw);
    const transition = evaluate(raw);

    expect(normalized.status).toBe("invalid");
    expect(normalized.diagnostics).toContain(expectedDiagnostic);
    expect(transition.action).toBe("reject");
    expect(transition).not.toMatchObject({ action: "continue" });
    expect(transition).not.toMatchObject({
      action: "stop",
      reason: "complete",
    });
  });
});

describe("continuation v1 precedence and admission", () => {
  it("applies authoritative host stop and suspend before proposal validity", () => {
    const invalid = normalizeContinuationProposalV1("{");
    const base = {
      proposal: invalid,
      evidence: evidence(),
      policy: policy(),
    };

    expect(
      evaluateContinuationTransitionV1({
        ...base,
        hostControl: { action: "stop", reason: "budget_exceeded" },
      }),
    ).toMatchObject({
      action: "stop",
      reason: "budget_exceeded",
      diagnostics: ["transition.host_stop"],
    });
    expect(
      evaluateContinuationTransitionV1({
        ...base,
        hostControl: { action: "suspend", reason: "paused" },
      }),
    ).toMatchObject({
      action: "suspend",
      reason: "paused",
      diagnostics: ["transition.host_suspend"],
    });
  });

  it("rejects malformed host control and evidence integrity inputs", () => {
    expect(
      evaluate(proposal(), {
        hostControl: { action: "stop", reason: "cancelled", extra: true },
      }),
    ).toMatchObject({
      action: "reject",
      reason: "invalid_host_control",
    });
    expect(
      evaluate(proposal(), {
        evidence: evidence({
          runIdentity: { planDigest: "not-a-digest" },
        }),
      }),
    ).toMatchObject({
      action: "reject",
      reason: "invalid_evidence",
    });
  });

  it("admits blocked only when policy allows and cited host evidence is verified", () => {
    const blocked = proposal({
      verdict: "blocked",
      nextTask: "",
      evidenceRefs: ["blocker:dependency"],
    });

    expect(
      evaluate(blocked, {
        evidence: evidence({
          blockers: [
            {
              code: "dependency_unavailable",
              verified: false,
              evidenceRef: "blocker:dependency",
            },
          ],
        }),
      }),
    ).toMatchObject({
      action: "review_again",
      reason: "blocker_evidence_unverified",
    });

    expect(
      evaluate(blocked, {
        evidence: evidence({
          blockers: [
            {
              code: "dependency_unavailable",
              verified: true,
              evidenceRef: "blocker:dependency",
            },
          ],
        }),
      }),
    ).toMatchObject({
      action: "stop",
      reason: "blocked",
      blockerCodes: ["dependency_unavailable"],
    });

    expect(
      evaluate(blocked, {
        policy: policy({ terminalBlocked: "review_again" }),
      }),
    ).toMatchObject({
      action: "review_again",
      reason: "blocked_not_permitted",
    });
  });

  it("admits completion only without verified blockers and with policy-satisfying validation", () => {
    const complete = proposal({
      verdict: "complete",
      nextTask: "",
    });

    expect(evaluate(complete)).toMatchObject({
      action: "stop",
      reason: "complete",
    });
    expect(
      evaluate(complete, {
        evidence: evidence({
          blockers: [
            {
              code: "tests_failed",
              verified: true,
              evidenceRef: "validation:failed",
            },
          ],
        }),
      }),
    ).toMatchObject({
      action: "review_again",
      reason: "completion_blocked",
      blockerCodes: ["tests_failed"],
    });
    expect(
      evaluate(complete, {
        evidence: evidence({ validation: { status: "failed" } }),
      }),
    ).toMatchObject({
      action: "review_again",
      reason: "completion_validation_insufficient",
    });
    expect(
      evaluate(complete, {
        evidence: evidence({ validation: { status: "not_required" } }),
        policy: policy({ completionValidation: "passed" }),
      }),
    ).toMatchObject({
      action: "review_again",
      reason: "completion_validation_insufficient",
    });
  });

  it("returns a deterministic task key and gates repeated tasks by policy", () => {
    const nextTask = "ＦＩＸ\u00a0\u00a0THE   TEST";
    const equivalent = "fix the test";
    const taskKey = createContinuationTaskKeyV1(nextTask);

    expect(normalizeContinuationTaskTextV1(nextTask)).toBe(equivalent);
    expect(createContinuationTaskKeyV1(equivalent)).toBe(taskKey);
    expect(evaluate(proposal({ nextTask }))).toMatchObject({
      action: "continue",
      nextTask,
      taskKey,
    });
    expect(
      evaluate(proposal({ nextTask }), {
        evidence: evidence({ progress: { priorTaskKeys: [taskKey] } }),
      }),
    ).toMatchObject({
      action: "review_again",
      reason: "repeated_task",
    });
    expect(
      evaluate(proposal({ nextTask }), {
        evidence: evidence({ progress: { priorTaskKeys: [taskKey] } }),
        policy: policy({ repeatedTask: { onLimit: "stop_stuck" } }),
      }),
    ).toMatchObject({
      action: "stop",
      reason: "stuck",
    });
  });
});

describe("continuation v1 deterministic utilities and compatibility", () => {
  it("classifies host and kernel admissions by safety dominance", () => {
    const admitted = evaluate(proposal());
    const conservative = evaluate(
      proposal({ verdict: "complete", nextTask: "" }),
      { evidence: evidence({ validation: { status: "failed" } }) }
    );
    const hostStop = evaluate(proposal(), {
      hostControl: { action: "stop", reason: "budget_exceeded" },
    });

    expect(continuationTransitionAdmissionV1(admitted)).toBe("continue");
    expect(continuationTransitionAdmissionV1(hostStop)).toBe("host_stop");
    expect(classifyContinuationAdmissionsV1("continue", admitted)).toBe(
      "match"
    );
    expect(classifyContinuationAdmissionsV1("complete", conservative)).toBe(
      "safer_kernel"
    );
    expect(classifyContinuationAdmissionsV1("host_stop", admitted)).toBe(
      "unsafe_kernel"
    );
    expect(classifyContinuationAdmissionsV1("continue", {
      schema: "dzupagent/continuation-transition/v1",
      action: "stop",
      reason: "complete",
      diagnostics: ["transition.complete"],
    })).toBe("reviewed_difference");
  });

  it("canonicalizes key order and hashes equal JSON semantics identically", () => {
    const first = { z: [3, { b: true, a: null }], a: "value" };
    const reordered = { a: "value", z: [3, { a: null, b: true }] };

    expect(canonicalizeContinuationValueV1(first)).toBe(
      canonicalizeContinuationValueV1(reordered),
    );
    expect(hashContinuationValueV1(first)).toBe(
      hashContinuationValueV1(reordered),
    );
    expect(() =>
      canonicalizeContinuationValueV1({ invalid: undefined }),
    ).toThrow(/undefined fields/);
    expect(() => {
      const sparse = [];
      sparse.length = 1;
      canonicalizeContinuationValueV1(sparse);
    }).toThrow(/sparse arrays/);
  });

  it("preserves the frozen legacy parser's fail-open behavior outside v1", () => {
    expect(parseDecisionBlock("{").verdict).toBe("continue");
    expect(parseDecisionBlock('{"verdict":"unknown"}').verdict).toBe(
      "continue",
    );
  });
});
