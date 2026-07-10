import {
  FLOW_NODE_KINDS,
  type FlowNode,
  type ResolvedTool,
  type ToolResolver,
} from "@dzupagent/flow-ast";
import { describe, expect, it } from "vitest";

import {
  DZUPAGENT_PIPELINE_HOST_MANIFEST,
  FLOW_NODE_CAPABILITY_REGISTRY,
  FLOW_VALIDATION_PROFILES,
  TARGET_CAPABILITY_MANIFESTS,
  collectFlowRequirements,
  createFlowCompiler,
  generateFlowConformanceMatrix,
  renderFlowConformanceMatrixMarkdown,
  resolveHostReadiness,
} from "../index.js";

const resolver: ToolResolver = {
  resolve(ref: string): ResolvedTool | null {
    if (ref !== "test.run") return null;
    return {
      ref,
      kind: "skill",
      inputSchema: { type: "object" },
      handle: { name: ref },
    };
  },
  listAvailable: () => ["test.run"],
};

describe("flow conformance manifest", () => {
  it("covers every public FlowNode kind exactly once", () => {
    expect(Object.keys(FLOW_NODE_CAPABILITY_REGISTRY).sort()).toEqual(
      [...FLOW_NODE_KINDS].sort(),
    );

    const matrix = generateFlowConformanceMatrix();
    expect(matrix.nodes.map((node) => node.kind).sort()).toEqual(
      [...FLOW_NODE_KINDS].sort(),
    );
  });

  it("publishes all compiler targets and validation profiles", () => {
    expect(Object.keys(TARGET_CAPABILITY_MANIFESTS).sort()).toEqual([
      "pipeline",
      "planning-dag",
      "skill-chain",
      "workflow-builder",
    ]);
    expect(Object.keys(FLOW_VALIDATION_PROFILES).sort()).toEqual([
      "authoring-fast",
      "compiler-focused",
      "runtime-fixture",
    ]);
    expect(FLOW_VALIDATION_PROFILES["runtime-fixture"].requiresHostManifest).toBe(
      true,
    );
  });

  it("derives deterministic runtime requirements from the canonical AST", () => {
    const first: FlowNode = {
      type: "sequence",
      nodes: [
        { type: "action", toolRef: "test.run", input: {} },
        {
          type: "agent",
          agentId: "reviewer",
          instructions: "Review the result.",
          output: { key: "review", schema: { type: "object" } },
        },
      ],
    };
    const second = {
      nodes: [
        { input: {}, toolRef: "test.run", type: "action" },
        {
          instructions: "Review the result.",
          agentId: "reviewer",
          output: { schema: { type: "object" }, key: "review" },
          type: "agent",
        },
      ],
      type: "sequence",
    } as FlowNode;

    const requirements = collectFlowRequirements(first);
    expect(requirements).toMatchObject({
      schema: "dzupagent.flowRequirements/v1",
      target: "planning-dag",
      nodeKinds: ["action", "agent", "sequence"],
      requiredCapabilities: [
        "flow.runtime.agent@1",
        "flow.target.planning-dag@1",
      ],
      partialNodeKinds: [],
      unsupportedNodeKinds: [],
    });
    expect(requirements.semanticHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(collectFlowRequirements(second).semanticHash).toBe(
      requirements.semanticHash,
    );
  });

  it("blocks host readiness with actionable target and capability diagnostics", () => {
    const requirements = collectFlowRequirements({
      type: "return_to",
      targetId: "parent",
      condition: "state.retry === true",
    });
    const result = resolveHostReadiness(requirements, {
      schema: "dzupagent.hostCapabilityManifest/v1",
      host: "fixture-host",
      version: "1.0.0",
      targets: ["skill-chain"],
      capabilities: [],
    });

    expect(result.status).toBe("blocked");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "UNSUPPORTED_TARGET",
      "MISSING_CAPABILITY",
      "MISSING_CAPABILITY",
    ]);
    expect(requirements.unsupportedNodeKinds).toEqual([]);
  });

  it("publishes conservative built-in pipeline host readiness", () => {
    const setRequirements = collectFlowRequirements({
      type: "set",
      assign: { ready: true },
    });
    expect(
      resolveHostReadiness(
        setRequirements,
        DZUPAGENT_PIPELINE_HOST_MANIFEST,
      ).status,
    ).toBe("ready");

    const returnRequirements = collectFlowRequirements({
      type: "return_to",
      targetId: "start",
      condition: "{{ state.retry }}",
    });
    const result = resolveHostReadiness(
      returnRequirements,
      DZUPAGENT_PIPELINE_HOST_MANIFEST,
    );
    expect(result.status).toBe("blocked");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "MISSING_CAPABILITY",
        capability: "flow.runtime.return_to@1",
      }),
    ]);
  });

  it("renders stable Markdown with known residual limitations", () => {
    const markdown = renderFlowConformanceMatrixMarkdown();
    expect(markdown).toContain("# Flow Node And Target Conformance Matrix");
    expect(markdown).toContain("`return_to`");
    expect(markdown).toContain("Pure state mutation lowers");
    expect(markdown).toContain("Compatibility leaf for hosts");
    expect(markdown.match(/^\| `[^`]+` \| yes \| yes \|/gm)).toHaveLength(
      FLOW_NODE_KINDS.length,
    );
  });
});

describe("compile requirement summary", () => {
  it("is emitted with source and semantic hashes on successful compilation", async () => {
    const result = await createFlowCompiler({ toolResolver: resolver }).compile({
      type: "action",
      id: "run",
      toolRef: "test.run",
      input: {},
    });

    expect("errors" in result).toBe(false);
    if ("errors" in result) return;

    expect(result.requirements).toMatchObject({
      schema: "dzupagent.flowRequirements/v1",
      target: "skill-chain",
      nodeKinds: ["action"],
      requiredCapabilities: ["flow.target.skill-chain@1"],
    });
    expect(result.evidence.semanticHash).toBe(result.requirements.semanticHash);
    expect(result.evidence.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
