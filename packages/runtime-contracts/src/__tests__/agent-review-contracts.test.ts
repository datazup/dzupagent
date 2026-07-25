import { describe, expect, it } from "vitest";

import {
  validateAgentRunResult,
  validateReviewDecision,
  validateReviewLoopResult,
  type AgentRunRequest,
  type AgentRunResult,
  type ReviewDecision,
  type ReviewLoopRequest,
  type ReviewLoopResult,
} from "../agent-review.js";

const A = `sha256:${"a".repeat(64)}` as const;
const B = `sha256:${"b".repeat(64)}` as const;

const evidence = {
  uri: "evidence://review/validation",
  digest: A,
  digestOf: "sanitized",
  redactionStatus: "passed",
  contentClass: "validation",
} as const;

function loopRequest(
  overrides: Partial<ReviewLoopRequest> = {},
): ReviewLoopRequest {
  return {
    schema: "dzupagent.reviewLoopRequest/v1",
    requestId: "review-1",
    correlationId: "correlation-1",
    generation: 2,
    baselineDigest: A,
    implementer: {
      actorId: "implementer-1",
      role: "implementer",
      providerId: "codex",
      modelId: "review-model",
      readOnly: false,
      sessionId: "implement-session",
    },
    maxRevisions: 2,
    requiredValidation: true,
    minimumReviewerIndependence: "separate-session",
    requireReadOnlyReviewer: true,
    ...overrides,
  };
}

function decision(
  overrides: Partial<ReviewDecision> = {},
): ReviewDecision {
  return {
    schema: "dzupagent.reviewDecision/v1",
    requestId: "review-1",
    correlationId: "correlation-1",
    generation: 2,
    candidateDigest: B,
    reviewer: {
      actorId: "reviewer-1",
      role: "reviewer",
      providerId: "codex",
      modelId: "review-model",
      readOnly: true,
      sessionId: "review-session",
    },
    independence: "separate-session",
    decision: "accept",
    validation: "passed",
    evidence: [evidence],
    corrections: [],
    blockers: [],
    reason: "Candidate and validation evidence agree.",
    ...overrides,
  };
}

function loopResult(
  overrides: Partial<ReviewLoopResult> = {},
): ReviewLoopResult {
  return {
    schema: "dzupagent.reviewLoopResult/v1",
    requestId: "review-1",
    correlationId: "correlation-1",
    generation: 2,
    finalCandidateDigest: B,
    status: "accepted",
    revisionsUsed: 1,
    lastDecision: decision(),
    progress: { beforeDigest: A, afterDigest: B, changed: true },
    evidence: [evidence],
    terminalReason: "Accepted after host validation.",
    ...overrides,
  };
}

function agentRequest(): AgentRunRequest {
  return {
    schema: "dzupagent.agentRunRequest/v1",
    identity: {
      runId: "run-1",
      nodeId: "implement",
      logicalTurnId: "turn-1",
      attemptId: "attempt-1",
      generation: 1,
      correlationId: "correlation-1",
    },
    actor: {
      actorId: "implementer-1",
      role: "implementer",
      providerId: "codex",
      readOnly: false,
    },
    execution: {
      schema: "dzupagent.executionRequest/v1",
      kind: "adapter.run",
      requestId: "execution-1",
      correlationId: "correlation-1",
      attempt: 1,
      source: { nodeId: "implement", nodePath: "root.implement" },
      prompt: { layers: [{ kind: "task", content: "Implement." }], bindings: {} },
      tools: { mode: "explicit", grants: [] },
      output: { key: "candidate", format: "text" },
      route: {
        id: "route-1",
        requestId: "execution-1",
        strategy: "fixed",
        candidates: [{ id: "codex", provider: "codex" }],
        hardConstraints: [],
        preferenceOrder: [],
        fallback: "none",
        maxSelectionLatencyMs: 1_000,
      },
      policy: {},
      effects: { effectClass: "code_change" },
      cancellation: { mode: "cooperative" },
      evidenceRequirements: [],
      adapter: { promptPreparation: "auto" },
    },
    limits: {
      maxTurns: 2,
      maxToolCalls: 10,
      maxInputTokens: 10_000,
      maxOutputTokens: 2_000,
      maxCostCents: 100,
      deadline: "2026-07-25T12:00:00.000Z",
    },
    requiredEvidenceKinds: ["diff", "validation"],
  };
}

function agentResult(
  overrides: Partial<AgentRunResult> = {},
): AgentRunResult {
  return {
    schema: "dzupagent.agentRunResult/v1",
    identity: agentRequest().identity,
    actorId: "implementer-1",
    status: "completed",
    output: { candidateDigest: B },
    usage: {
      turns: 1,
      toolCalls: 2,
      inputTokens: 1_000,
      outputTokens: 300,
      costCents: 10,
    },
    progress: { beforeDigest: A, afterDigest: B, changed: true },
    evidence: [
      { ...evidence, contentClass: "diff" },
      { ...evidence, uri: "evidence://review/host-validation" },
    ],
    ...overrides,
  };
}

describe("canonical agent and review-loop contracts", () => {
  it("admits bounded agent results and evidence-backed acceptance", () => {
    expect(validateAgentRunResult(agentRequest(), agentResult())).toEqual({
      valid: true,
      diagnostics: [],
    });
    expect(validateReviewDecision(loopRequest(), decision())).toEqual({
      valid: true,
      diagnostics: [],
    });
    expect(validateReviewLoopResult(loopRequest(), loopResult())).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it("rejects identity drift, usage overrun, and false progress", () => {
    const result = validateAgentRunResult(
      agentRequest(),
      agentResult({
        identity: { ...agentRequest().identity, generation: 3 },
        usage: { ...agentResult().usage, toolCalls: 11 },
        progress: { beforeDigest: A, afterDigest: A, changed: true },
      }),
    );
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "AGENT_IDENTITY_MISMATCH",
        "AGENT_LIMIT_EXCEEDED",
        "AGENT_PROGRESS_INCONSISTENT",
      ]),
    );
  });

  it("rejects accepted decisions with skipped validation or contradictions", () => {
    const result = validateReviewDecision(
      loopRequest(),
      decision({
        validation: "skipped",
        evidence: [],
        corrections: ["Run validation."],
        blockers: ["Provider unavailable."],
      }),
    );
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "REVIEW_VALIDATION_NOT_PASSED",
        "REVIEW_EVIDENCE_MISSING",
        "REVIEW_ACCEPT_CONTRADICTORY",
      ]),
    );
  });

  it("rejects mutable or insufficiently independent reviewers", () => {
    const result = validateReviewDecision(
      loopRequest({ minimumReviewerIndependence: "separate-provider" }),
      decision({
        reviewer: {
          ...decision().reviewer,
          actorId: "implementer-1",
          modelId: "review-model",
          sessionId: "implement-session",
          readOnly: false,
        },
        independence: "same-session",
      }),
    );
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "REVIEWER_NOT_READ_ONLY",
        "REVIEWER_INDEPENDENCE_INSUFFICIENT",
      ]),
    );
  });

  it("derives independence and rejects stale decision generations", () => {
    const result = validateReviewDecision(
      loopRequest(),
      decision({
        generation: 1,
        independence: "separate-provider",
      }),
    );
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "REVIEW_GENERATION_MISMATCH",
        "REVIEWER_INDEPENDENCE_MISMATCH",
      ]),
    );
  });

  it("requires actionable revise and blocked decisions", () => {
    expect(
      validateReviewDecision(
        loopRequest(),
        decision({ decision: "revise", corrections: [] }),
      ).diagnostics.map((item) => item.code),
    ).toContain("REVIEW_REVISION_MISSING");
    expect(
      validateReviewDecision(
        loopRequest(),
        decision({ decision: "blocked_external", blockers: [] }),
      ).diagnostics.map((item) => item.code),
    ).toContain("REVIEW_BLOCKER_MISSING");
  });

  it("rejects accepted, exhausted, and stalled terminal inconsistencies", () => {
    const accepted = validateReviewLoopResult(
      loopRequest(),
      loopResult({ lastDecision: decision({ decision: "revise" }) }),
    );
    const exhausted = validateReviewLoopResult(
      loopRequest(),
      loopResult({
        status: "exhausted",
        revisionsUsed: 1,
        lastDecision: decision({ decision: "revise", corrections: ["Fix."] }),
      }),
    );
    const stalled = validateReviewLoopResult(
      loopRequest(),
      loopResult({ status: "stalled" }),
    );
    expect(accepted.diagnostics.map((item) => item.code)).toContain(
      "REVIEW_TERMINAL_INCONSISTENT",
    );
    expect(exhausted.diagnostics.map((item) => item.code)).toContain(
      "REVIEW_TERMINAL_INCONSISTENT",
    );
    expect(stalled.diagnostics.map((item) => item.code)).toContain(
      "REVIEW_PROGRESS_INCONSISTENT",
    );
  });

  it("admits exact exhaustion and unsupported reviewer terminals", () => {
    expect(
      validateReviewLoopResult(
        loopRequest(),
        loopResult({
          status: "exhausted",
          revisionsUsed: 2,
          lastDecision: decision({
            decision: "revise",
            corrections: ["Residual correction remains."],
          }),
          terminalReason: "Revision budget exhausted.",
        }),
      ),
    ).toEqual({ valid: true, diagnostics: [] });
    expect(
      validateReviewLoopResult(
        loopRequest({
          minimumReviewerIndependence: "separate-provider",
        }),
        loopResult({
          status: "reviewer_unavailable",
          revisionsUsed: 0,
          lastDecision: decision({
            decision: "unsupported",
            reviewer: {
              ...decision().reviewer,
              actorId: "implementer-1",
              modelId: "review-model",
              sessionId: "implement-session",
            },
            independence: "same-session",
            evidence: [],
            reason: "Required reviewer independence is unavailable.",
          }),
          terminalReason: "Reviewer requirement unsupported.",
        }),
      ),
    ).toEqual({ valid: true, diagnostics: [] });
  });

  it("admits a truthful invalid-decision terminal without accepting it", () => {
    expect(
      validateReviewLoopResult(
        loopRequest(),
        loopResult({
          status: "invalid_decision",
          lastDecision: decision({
            validation: "skipped",
            evidence: [],
          }),
          terminalReason: "Reviewer decision failed canonical admission.",
        }),
      ),
    ).toEqual({ valid: true, diagnostics: [] });
  });

  it("rejects unknown serialized decisions and terminals", () => {
    const unknownDecision = {
      ...decision(),
      decision: "maybe",
    } as unknown as ReviewDecision;
    const unknownTerminal = {
      ...loopResult(),
      status: "maybe",
    } as unknown as ReviewLoopResult;
    expect(
      validateReviewDecision(loopRequest(), unknownDecision).diagnostics.map(
        (item) => item.code,
      ),
    ).toContain("REVIEW_DECISION_UNKNOWN");
    expect(
      validateReviewLoopResult(loopRequest(), unknownTerminal).diagnostics.map(
        (item) => item.code,
      ),
    ).toContain("REVIEW_TERMINAL_UNKNOWN");
  });

  it("does not let an invalid-decision terminal forgive stale identity", () => {
    const result = validateReviewLoopResult(
      loopRequest(),
      loopResult({
        status: "invalid_decision",
        lastDecision: decision({
          generation: 1,
          validation: "skipped",
        }),
        terminalReason: "Reviewer decision failed canonical admission.",
      }),
    );
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "REVIEW_GENERATION_MISMATCH",
          path: "lastDecision.generation",
        }),
      ]),
    );
  });
});
