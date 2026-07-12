import { describe, expect, it } from "vitest";

import {
  validateExecutionRouteDecision,
  type ExecutionRequest,
  type ExecutionRouteDecision,
  type ExecutionRoutePolicy,
  type ExecutionRouteRejectionCode,
  type McpServerDescriptor,
  type ProviderAuthSourceDescriptor,
  type SanitizedEvidenceRef,
} from "../index.js";

const policy: ExecutionRoutePolicy = {
  id: "request-1:route",
  requestId: "request-1",
  strategy: "llm-rank",
  candidates: [
    { id: "claude", provider: "claude" },
    { id: "codex", provider: "codex" },
  ],
  hardConstraints: [{ kind: "capability", values: ["code"] }],
  preferenceOrder: ["quality"],
  fallback: "ordered-compatible",
  maxSelectionLatencyMs: 1_500,
};

describe("canonical execution contracts", () => {
  it("accepts route decisions bounded to the materialized candidate set", () => {
    const decision: ExecutionRouteDecision = {
      id: "decision-1",
      policyId: policy.id,
      requestId: policy.requestId,
      eligibleCandidateIds: ["claude", "codex"],
      rejected: [],
      selectedCandidateId: "codex",
      fallbackCandidateIds: ["claude"],
      strategy: "llm-rank",
      decidedAt: "2026-07-11T00:00:00.000Z",
    };

    expect(validateExecutionRouteDecision(policy, decision)).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it("rejects invented and ineligible route candidates", () => {
    const decision: ExecutionRouteDecision = {
      id: "decision-2",
      policyId: policy.id,
      requestId: policy.requestId,
      eligibleCandidateIds: ["claude"],
      rejected: [{ candidateId: "invented", reasons: ["ranked higher"] }],
      selectedCandidateId: "codex",
      fallbackCandidateIds: ["invented"],
      strategy: "llm-rank",
      decidedAt: "2026-07-11T00:00:00.000Z",
    };

    expect(
      validateExecutionRouteDecision(policy, decision).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual([
      "UNKNOWN_ROUTE_CANDIDATE",
      "UNKNOWN_ROUTE_CANDIDATE",
      "SELECTED_CANDIDATE_NOT_ELIGIBLE",
    ]);
  });

  it("rejects a decision produced under a different routing strategy", () => {
    const decision: ExecutionRouteDecision = {
      id: "decision-strategy-drift",
      policyId: policy.id,
      requestId: policy.requestId,
      eligibleCandidateIds: ["codex"],
      rejected: [{ candidateId: "claude", reasons: ["lower priority"] }],
      selectedCandidateId: "codex",
      fallbackCandidateIds: [],
      strategy: "fixed",
      decidedAt: "2026-07-11T00:00:00.000Z",
    };

    expect(validateExecutionRouteDecision(policy, decision).diagnostics).toEqual([
      expect.objectContaining({ code: "ROUTE_STRATEGY_MISMATCH", path: "strategy" }),
    ]);
  });

  it("makes raw evidence references unrepresentable", () => {
    const evidence: SanitizedEvidenceRef = {
      uri: "artifact://run/evidence.json",
      digest: "sha256:abc",
      digestOf: "sanitized",
      redactionStatus: "redacted",
      contentClass: "execution-evidence",
    };

    expect(evidence.digestOf).toBe("sanitized");
  });

  it("keeps logical provider identity separate from the execution backend", () => {
    expect({ id: "claude-cli", provider: "claude", backend: "cli" } satisfies ExecutionRoutePolicy["candidates"][number]).toEqual({
      id: "claude-cli",
      provider: "claude",
      backend: "cli",
    });
    expect({ id: "claude-api", provider: "claude", backend: "api" } satisfies ExecutionRoutePolicy["candidates"][number]).toEqual({
      id: "claude-api",
      provider: "claude",
      backend: "api",
    });
  });

  it("represents auth and MCP configuration only through references", () => {
    const auth = {
      id: "local-claude",
      provider: "claude",
      location: "local",
      kind: "cli-session",
      ref: "cli-session://claude/default",
    } satisfies ProviderAuthSourceDescriptor;
    const mcp = {
      id: "research",
      transport: {
        kind: "http",
        url: "https://gateway.example.test/mcp/research",
        headerRefs: { Authorization: "secret://gateway/research-token" },
        bearerTokenEnv: {
          envVar: "DZUP_MCP_BEARER_TOKEN",
          tokenRef: "secret://gateway/research-token",
        },
      },
    } satisfies McpServerDescriptor;

    expect(auth).not.toHaveProperty("secret");
    expect(auth).not.toHaveProperty("token");
    expect(mcp.transport).not.toHaveProperty("headers");
  });

  it("exports stable route rejection codes", () => {
    const codes: ExecutionRouteRejectionCode[] = [
      "PROVIDER_UNAVAILABLE",
      "BACKEND_UNAVAILABLE",
      "CAPABILITY_MISSING",
      "AUTH_SOURCE_UNAVAILABLE",
      "POLICY_INCOMPATIBLE",
      "MODEL_UNAVAILABLE",
      "HEALTH_CHECK_FAILED",
    ];

    expect(codes).toHaveLength(7);
  });

  it("carries detailed capability requirements without product semantics", () => {
    const request = {
      schema: "dzupagent.executionRequest/v1",
      kind: "adapter.run",
      requestId: "request-capabilities",
      correlationId: "correlation-capabilities",
      attempt: 1,
      source: { nodeId: "node", nodePath: "node" },
      prompt: { layers: [{ kind: "task", content: "inspect" }], bindings: {} },
      tools: { mode: "none", grants: [] },
      output: { key: "result", format: "text" },
      route: { ...policy, id: "request-capabilities:route", requestId: "request-capabilities" },
      policy: {},
      effects: { effectClass: "read" },
      cancellation: { mode: "cooperative" },
      evidenceRequirements: [],
      capabilityRequirements: [{ capability: "browser.playwright", required: true }],
      adapter: { promptPreparation: "auto" },
    } satisfies ExecutionRequest;

    expect(request.capabilityRequirements[0]?.capability).toBe("browser.playwright");
  });
});
