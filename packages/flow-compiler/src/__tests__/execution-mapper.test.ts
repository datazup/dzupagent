import { describe, expect, it } from "vitest";

import type { FlowNode } from "@dzupagent/flow-ast";
import {
  materializeAdapterPolicyRefV1,
  materializeWorkspaceHandleRefV1,
  type ExecutionRequest,
} from "@dzupagent/runtime-contracts";

import { mapFlowLeafToExecutionRequest } from "../index.js";

const baseContext = {
  requestId: "request-1",
  correlationId: "correlation-1",
  attempt: 2,
  flowId: "flow-1",
  nodePath: "root.nodes[0]",
  profileRef: "dzup.agent@1",
  capability: "flow.runtime.agent@1",
} as const;

const exactDefinition = {
  rootDefinitionId: "flow/review",
  rootDefinitionDigest: `sha256:${"a".repeat(64)}` as const,
  scopedDefinitionId: "flow/review/root",
  scopedDefinitionDigest: `sha256:${"b".repeat(64)}` as const,
};

const exactPolicy = materializeAdapterPolicyRefV1({
  policyId: "adapter-policy/review",
  authorityId: "policy-authority/framework-test",
  revision: "7",
  policyDigest: `sha256:${"c".repeat(64)}`,
  target: { executionKind: "adapter.run", nodeId: "adapter-strict" },
});

const exactWorkspace = materializeWorkspaceHandleRefV1({
  handleId: "workspace-handle-17",
  authorityId: "workspace-authority/framework-test",
  revision: "4",
  scopeDigest: `sha256:${"d".repeat(64)}`,
});

describe("canonical execution leaf mapper", () => {
  it("snapshots prompt layering, host tools, output, and fixed routing", () => {
    const result = mapFlowLeafToExecutionRequest(
      {
        id: "prompt-1",
        type: "prompt",
        systemPrompt: "Explicit system",
        userPrompt: "Summarize {{ state.diff }}",
        outputKey: "summary",
        provider: "claude",
        model: "sonnet",
        tools: true,
        effectClass: "llm",
      } as FlowNode,
      {
        ...baseContext,
        resolvedPromptSystemLayer: "Inherited system",
        routeCandidates: [{ id: "claude:sonnet", provider: "claude", model: "sonnet" }],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(snapshot(result.request)).toEqual({
      kind: "prompt",
      prompt: {
        layers: [
          { kind: "system", content: "Explicit system" },
          { kind: "task", content: "Summarize {{ state.diff }}" },
        ],
        bindings: {},
      },
      tools: { mode: "host-default", grants: [] },
      output: { key: "summary", format: "text" },
      route: {
        strategy: "fixed",
        candidates: [{ id: "claude:sonnet", provider: "claude", model: "sonnet" }],
        hardConstraints: [{ kind: "provider", values: ["claude"] }],
      },
      policy: {},
      effects: { effectClass: "llm" },
      evidenceRequirements: [],
    });
    expect(result.request.source).toEqual({
      flowId: "flow-1",
      nodeId: "prompt-1",
      nodePath: "root.nodes[0]",
      profileRef: "dzup.agent@1",
      capability: "flow.runtime.agent@1",
    });
    expect(result.request.cancellation).toEqual({ mode: "cooperative" });
  });

  it("snapshots agent tools, structured output, policies, and evidence", () => {
    const result = mapFlowLeafToExecutionRequest(
      {
        id: "agent-1",
        type: "agent",
        agentId: "reviewer",
        template: { ref: "review-template" },
        instructions: "Review the change",
        input: { diff: "{{ state.diff }}" },
        tools: ["repo.read", "tests.run"],
        output: { key: "review", schemaRef: "review/v1" },
        stop: { maxIterations: 4, maxToolCalls: 8 },
        policy: {
          timeoutMs: 30_000,
          budgetCents: 25,
          workingDirectory: "apps/codev-app",
          approval: { requiredFor: ["code_change"] },
        },
        validation: { required: [{ command: "yarn test" }] },
        meta: { evidence: { required: true, class: "test-output" } },
      } as FlowNode,
      {
        ...baseContext,
        routeCandidates: [
          { id: "claude", provider: "claude" },
          { id: "codex", provider: "codex" },
        ],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(snapshot(result.request)).toEqual({
      kind: "agent",
      prompt: {
        layers: [{ kind: "instructions", content: "Review the change" }],
        bindings: { diff: "{{ state.diff }}" },
      },
      tools: {
        mode: "explicit",
        grants: [{ toolRef: "repo.read" }, { toolRef: "tests.run" }],
      },
      output: { key: "review", format: "json", schemaRef: "review/v1" },
      route: {
        strategy: "rule",
        candidates: [
          { id: "claude", provider: "claude" },
          { id: "codex", provider: "codex" },
        ],
        hardConstraints: [],
      },
      policy: {
        timeoutMs: 30_000,
        budgetCents: 25,
        maxIterations: 4,
        maxToolCalls: 8,
        workingDirectory: "apps/codev-app",
        approvalRequiredFor: ["code_change"],
        validationCommands: ["yarn test"],
      },
      effects: {},
      evidenceRequirements: [
        { kind: "declared", declaration: { required: true, class: "test-output" } },
      ],
    });
    expect(result.request.kind === "agent" && result.request.identity).toEqual({
      agentId: "reviewer",
      templateRef: "review-template",
    });
  });

  it("snapshots tag-bounded adapter routing without inherited persona leakage", () => {
    const result = mapFlowLeafToExecutionRequest(
      {
        id: "adapter-1",
        type: "adapter.run",
        tags: ["code", "reasoning"],
        instructions: "Implement the packet",
        persona: "implementer",
        reasoning: "high",
        outputSchema: { type: "object" },
        output: "implementation",
        policy: { maxBudgetUsd: 2 },
      } as FlowNode,
      {
        ...baseContext,
        resolvedPromptSystemLayer: "Must not leak into adapter nodes",
        routeCandidates: [
          { id: "codex", provider: "codex", tags: ["code", "reasoning"] },
          { id: "claude", provider: "claude", tags: ["reasoning"] },
        ],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(snapshot(result.request)).toEqual({
      kind: "adapter.run",
      prompt: {
        layers: [
          { kind: "persona", ref: "implementer" },
          { kind: "instructions", content: "Implement the packet" },
        ],
        bindings: {},
      },
      tools: { mode: "none", grants: [] },
      output: { key: "implementation", format: "json", schema: { type: "object" } },
      route: {
        strategy: "fixed",
        candidates: [{ id: "codex", provider: "codex", tags: ["code", "reasoning"] }],
        hardConstraints: [{ kind: "tags", values: ["code", "reasoning"] }],
      },
      policy: { extensions: { maxBudgetUsd: 2 } },
      effects: {},
      evidenceRequirements: [],
    });
  });

  it("snapshots worker command governance and result schema", () => {
    const result = mapFlowLeafToExecutionRequest(
      {
        id: "worker-1",
        type: "worker.dispatch",
        dispatchId: "dispatch-1",
        provider: "codex",
        model: "gpt-5",
        systemPrompt: "Follow repository policy",
        instructions: "Run the bounded task",
        commandSurface: "code",
        commandAllowlist: ["yarn test"],
        validationCommand: "yarn typecheck",
        outputKey: "workerResult",
        resultFormat: "json",
        resultSchema: "worker-result/v1",
        effectClass: "code_change",
        idempotency: "at-least-once",
      } as FlowNode,
      {
        ...baseContext,
        routeCandidates: [{ id: "codex:gpt-5", provider: "codex", model: "gpt-5" }],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(snapshot(result.request)).toEqual({
      kind: "worker.dispatch",
      prompt: {
        layers: [
          { kind: "system", content: "Follow repository policy" },
          { kind: "instructions", content: "Run the bounded task" },
        ],
        bindings: {},
      },
      tools: {
        mode: "explicit",
        grants: [{ toolRef: "worker.command", operations: ["yarn test"] }],
      },
      output: { key: "workerResult", format: "json", schemaRef: "worker-result/v1" },
      route: {
        strategy: "fixed",
        candidates: [{ id: "codex:gpt-5", provider: "codex", model: "gpt-5" }],
        hardConstraints: [{ kind: "provider", values: ["codex"] }],
      },
      policy: { commandSurface: "code", validationCommands: ["yarn typecheck"] },
      effects: { effectClass: "code_change", idempotency: "at-least-once" },
      evidenceRequirements: [],
    });
  });

  it("returns stable diagnostics for missing candidates and ambiguous schemas", () => {
    const missingCandidates = mapFlowLeafToExecutionRequest(
      {
        id: "prompt-2",
        type: "prompt",
        userPrompt: "Hello",
      } as FlowNode,
      baseContext,
    );
    const ambiguousSchema = mapFlowLeafToExecutionRequest(
      {
        id: "agent-2",
        type: "agent",
        agentId: "agent",
        instructions: "Work",
        output: { key: "result", schemaRef: "result/v1", schema: { type: "object" } },
      } as FlowNode,
      { ...baseContext, routeCandidates: [{ id: "codex", provider: "codex" }] },
    );

    expect(missingCandidates.diagnostics.map((item) => item.code)).toEqual([
      "ROUTE_CANDIDATES_REQUIRED",
    ]);
    expect(ambiguousSchema.diagnostics.map((item) => item.code)).toEqual([
      "AMBIGUOUS_OUTPUT_SCHEMA",
    ]);
  });

  it("never invents a provider-pinned candidate outside the host set", () => {
    const result = mapFlowLeafToExecutionRequest(
      {
        id: "prompt-provider-mismatch",
        type: "prompt",
        provider: "claude",
        model: "sonnet",
        userPrompt: "Review this change",
      } as FlowNode,
      {
        ...baseContext,
        routeCandidates: [{ id: "codex", provider: "codex", model: "gpt-5" }],
      },
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "NO_ELIGIBLE_ROUTE_CANDIDATES",
    ]);
  });

  it("emits exact state, policy, and opaque workspace evidence in strict mode", () => {
    const result = mapFlowLeafToExecutionRequest(
      {
        id: "adapter-strict",
        type: "adapter.run",
        tags: ["code"],
        systemPrompt: "Use {{ state.request }}",
        instructions: "Review {{ state.diff }} and {{ state.request }}",
        input: {
          diff: "{{ state.diff }}",
          explicit: { kind: "flow-reference", source: "state.explicit" },
        },
        output: "review",
      } as FlowNode,
      {
        ...baseContext,
        routeCandidates: [{ id: "codex", provider: "codex", tags: ["code"] }],
        executionBoundary: {
          mode: "strict",
          definition: exactDefinition,
          adapterPolicy: exactPolicy,
          workspace: exactWorkspace,
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.boundaryEvidence?.owner).toEqual({
      ...exactDefinition,
      executionKind: "adapter.run",
      nodeId: "adapter-strict",
      nodePath: "root.nodes[0]",
    });
    expect(result.request.boundaryEvidence?.state.declared).toEqual({
      status: "exact",
      basisDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      reads: ["diff", "explicit", "request"],
      writes: ["review"],
    });
    expect(result.request.boundaryEvidence?.state.observed).toEqual({
      status: "unknown",
      reason: "runtime-observation-unavailable",
    });
    expect(result.request.boundaryEvidence?.adapterPolicy).toEqual(exactPolicy);
    expect(result.request.boundaryEvidence?.workspace).toEqual(exactWorkspace);
    expect(JSON.stringify(result.request.boundaryEvidence)).not.toContain(
      "apps/codev-app",
    );
    expect(result.request.policy).not.toHaveProperty("workingDirectory");
  });

  it("denies missing strict evidence, foreign targets, and raw working directories", () => {
    const node = {
      id: "adapter-strict",
      type: "adapter.run",
      provider: "codex",
      instructions: "Review",
      output: "review",
    } as FlowNode;
    const context = {
      ...baseContext,
      routeCandidates: [{ id: "codex", provider: "codex" }],
    } as const;

    expect(
      mapFlowLeafToExecutionRequest(node, {
        ...context,
        executionBoundary: { mode: "strict" },
      }).diagnostics.map((item) => item.code),
    ).toContain("EXECUTION_BOUNDARY_CONTEXT_REQUIRED");
    expect(
      mapFlowLeafToExecutionRequest(node, {
        ...context,
        executionBoundary: {
          mode: "strict",
          definition: exactDefinition,
          workspace: exactWorkspace,
        },
      }).diagnostics.map((item) => item.code),
    ).toContain("ADAPTER_POLICY_REF_REQUIRED");
    expect(
      mapFlowLeafToExecutionRequest(node, {
        ...context,
        executionBoundary: {
          mode: "strict",
          definition: exactDefinition,
          adapterPolicy: materializeAdapterPolicyRefV1({
            policyId: "adapter-policy/review",
            authorityId: "policy-authority/framework-test",
            revision: "7",
            policyDigest: `sha256:${"c".repeat(64)}`,
            target: { executionKind: "adapter.run", nodeId: "foreign-node" },
          }),
        },
      }).diagnostics.map((item) => item.code),
    ).toContain("EXECUTION_BOUNDARY_INVALID");

    const rawAgent = {
      id: "agent-strict",
      type: "agent",
      agentId: "reviewer",
      instructions: "Review",
      output: { key: "review", schema: { type: "object" } },
      policy: { workingDirectory: "apps/codev-app" },
    } as FlowNode;
    expect(
      mapFlowLeafToExecutionRequest(rawAgent, {
        ...context,
        executionBoundary: {
          mode: "strict",
          definition: exactDefinition,
          workspace: exactWorkspace,
        },
      }).diagnostics.map((item) => item.code),
    ).toContain("RAW_WORKING_DIRECTORY_DISALLOWED");
  });

  it("preserves compatibility mapping of legacy raw working-directory bytes", () => {
    const result = mapFlowLeafToExecutionRequest(
      {
        id: "agent-legacy",
        type: "agent",
        agentId: "reviewer",
        instructions: "Review",
        output: { key: "review", schema: { type: "object" } },
        policy: { workingDirectory: "apps/codev-app" },
      } as FlowNode,
      {
        ...baseContext,
        routeCandidates: [{ id: "codex", provider: "codex" }],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.policy.workingDirectory).toBe("apps/codev-app");
    expect(result.request.boundaryEvidence).toBeUndefined();
  });
});

function snapshot(request: ExecutionRequest) {
  return {
    kind: request.kind,
    prompt: request.prompt,
    tools: request.tools,
    output: request.output,
    route: {
      strategy: request.route.strategy,
      candidates: request.route.candidates,
      hardConstraints: request.route.hardConstraints,
    },
    policy: request.policy,
    effects: request.effects,
    evidenceRequirements: request.evidenceRequirements,
  };
}
