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

describe("host readiness gates", () => {
  it("treats a node kind missing from the registry as unsupported instead of crashing", () => {
    const forwardVersionAst = {
      type: "sequence",
      nodes: [
        { type: "action", toolRef: "test.run", input: {} },
        { type: "quantum.entangle" },
      ],
    } as unknown as FlowNode;

    const requirements = collectFlowRequirements(forwardVersionAst);
    expect(requirements.unsupportedNodeKinds).toEqual(["quantum.entangle"]);

    // Host accepts the target and every capability string, so the unknown
    // node is the single dimension that blocks readiness.
    const result = resolveHostReadiness(requirements, {
      schema: "dzupagent.hostCapabilityManifest/v1",
      host: "fixture-host",
      version: "1.0.0",
      targets: [requirements.target],
      capabilities: [...requirements.requiredCapabilities],
    });
    expect(result.status).toBe("blocked");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "UNSUPPORTED_NODE",
        nodeKind: "quantum.entangle",
      }),
    ]);
  });

  it("blocks a partial node kind under release-strict unless the host declares its runtime capability, which is the host's statement that it executes the kind", () => {
    const requirements = collectFlowRequirements({
      type: "loop",
      condition: "{{ state.keepGoing }}",
      body: [{ type: "action", toolRef: "test.run", input: {} }],
    });
    expect(requirements.partialNodeKinds).toEqual(["loop"]);
    expect(requirements.requiredCapabilities).toContain("flow.runtime.loop@1");

    // The host accepts the target and every required capability except the
    // loop runtime capability, so it does not claim to execute loops itself.
    const host = {
      schema: "dzupagent.hostCapabilityManifest/v1" as const,
      host: "fixture-host",
      version: "1.0.0",
      targets: [requirements.target],
      capabilities: requirements.requiredCapabilities.filter(
        (capability) => capability !== "flow.runtime.loop@1",
      ),
    };

    // Default profile: only the missing capability string blocks; partial
    // kinds are never reported.
    const fallback = resolveHostReadiness(requirements, host);
    expect(fallback.status).toBe("blocked");
    expect(fallback.diagnostics).toEqual([
      expect.objectContaining({
        code: "MISSING_CAPABILITY",
        capability: "flow.runtime.loop@1",
      }),
    ]);

    const strict = resolveHostReadiness(requirements, host, {
      profile: "release-strict",
    });
    expect(strict.status).toBe("blocked");
    expect(strict.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MISSING_CAPABILITY",
          capability: "flow.runtime.loop@1",
        }),
        expect.objectContaining({
          code: "PARTIAL_NODE",
          nodeKind: "loop",
          message: expect.stringContaining("release-strict"),
        }),
      ]),
    );
    const partial = strict.diagnostics.filter(
      (diagnostic) => diagnostic.code === "PARTIAL_NODE",
    );
    expect(partial).toHaveLength(1);
    expect(partial[0]?.message).toContain("authored condition is runtime-owned");
  });

  describe("release-strict runtime capability skip for emit", () => {
    const emitRequirements = collectFlowRequirements({
      type: "emit",
      event: "flow.completed",
      payload: { ok: true },
    });

    const partialEmitDiagnostics = (
      diagnostics: ReturnType<typeof resolveHostReadiness>["diagnostics"],
    ) =>
      diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === "PARTIAL_NODE" && diagnostic.nodeKind === "emit",
      );

    it("treats emit as partial and requires its runtime capability", () => {
      expect(emitRequirements.partialNodeKinds).toEqual(["emit"]);
      expect(emitRequirements.requiredCapabilities).toContain(
        "flow.runtime.emit@1",
      );
    });

    it("skips PARTIAL_NODE for emit when the host declares flow.runtime.emit@1 and the other required capabilities", () => {
      const host = {
        schema: "dzupagent.hostCapabilityManifest/v1" as const,
        host: "emit-executing-host",
        version: "1.0.0",
        targets: [emitRequirements.target],
        capabilities: [...emitRequirements.requiredCapabilities],
      };
      expect(host.capabilities).toContain("flow.runtime.emit@1");

      const strict = resolveHostReadiness(emitRequirements, host, {
        profile: "release-strict",
      });
      expect(partialEmitDiagnostics(strict.diagnostics)).toEqual([]);
      expect(
        strict.diagnostics.filter(
          (diagnostic) =>
            (diagnostic.code as string) === "HOST_EXECUTED_PARTIAL_NODE",
        ),
      ).toEqual([]);
      expect(strict.status).toBe("ready");
      expect(strict.diagnostics).toEqual([]);
    });

    it("still blocks emit under release-strict against DZUPAGENT_PIPELINE_HOST_MANIFEST", () => {
      expect(DZUPAGENT_PIPELINE_HOST_MANIFEST.capabilities).not.toContain(
        "flow.runtime.emit@1",
      );
      const strict = resolveHostReadiness(
        emitRequirements,
        DZUPAGENT_PIPELINE_HOST_MANIFEST,
        { profile: "release-strict" },
      );
      expect(strict.status).toBe("blocked");
      expect(partialEmitDiagnostics(strict.diagnostics)).toEqual([
        expect.objectContaining({
          code: "PARTIAL_NODE",
          nodeKind: "emit",
          message: expect.stringContaining("release-strict"),
        }),
      ]);
    });

    it("still blocks emit under release-strict when the host omits flow.runtime.emit@1", () => {
      const host = {
        schema: "dzupagent.hostCapabilityManifest/v1" as const,
        host: "emit-unaware-host",
        version: "1.0.0",
        targets: [emitRequirements.target],
        capabilities: emitRequirements.requiredCapabilities.filter(
          (capability) => capability !== "flow.runtime.emit@1",
        ),
      };

      const strict = resolveHostReadiness(emitRequirements, host, {
        profile: "release-strict",
      });
      expect(strict.status).toBe("blocked");
      expect(strict.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "MISSING_CAPABILITY",
            capability: "flow.runtime.emit@1",
          }),
          expect.objectContaining({ code: "PARTIAL_NODE", nodeKind: "emit" }),
        ]),
      );
      expect(partialEmitDiagnostics(strict.diagnostics)).toHaveLength(1);
    });
  });

  describe("D10 (a): release-strict and default agree on status for partial kinds", () => {
    // Baseline for any later host-field design: today release-strict only adds
    // PARTIAL_NODE diagnostics; the readiness status is the same.
    const partialKinds = FLOW_NODE_KINDS.filter(
      (kind) => FLOW_NODE_CAPABILITY_REGISTRY[kind].status === "partial",
    );

    it("covers at least one partial kind", () => {
      expect(partialKinds).toContain("emit");
    });

    for (const kind of partialKinds) {
      const runtimeCapability = `flow.runtime.${kind}@1`;
      const requirements = {
        schema: "dzupagent.flowRequirements/v1" as const,
        target: "pipeline" as const,
        semanticHash: "fixture",
        nodeKinds: [kind],
        requiredCapabilities: [
          TARGET_CAPABILITY_MANIFESTS.pipeline.capability,
          ...FLOW_NODE_CAPABILITY_REGISTRY[kind].runtimeCapabilities,
        ].sort(),
        partialNodeKinds: [kind],
        unsupportedNodeKinds: [],
      };
      const host = (declaresRuntime: boolean) => ({
        schema: "dzupagent.hostCapabilityManifest/v1" as const,
        host: `partial-${kind}-host`,
        version: "1.0.0",
        targets: ["pipeline" as const],
        capabilities: requirements.requiredCapabilities.filter(
          (capability) => declaresRuntime || capability !== runtimeCapability,
        ),
      });

      it(`${kind}: same status under both profiles with and without ${runtimeCapability}`, () => {
        expect(requirements.requiredCapabilities).toContain(runtimeCapability);
        for (const declaresRuntime of [true, false]) {
          const fallback = resolveHostReadiness(requirements, host(declaresRuntime));
          const strict = resolveHostReadiness(requirements, host(declaresRuntime), {
            profile: "release-strict",
          });
          expect(strict.status).toBe(fallback.status);
          expect(fallback.status).toBe(declaresRuntime ? "ready" : "blocked");
          expect(
            strict.diagnostics.some((diagnostic) => diagnostic.code === "PARTIAL_NODE"),
          ).toBe(!declaresRuntime);
        }
      });
    }
  });
});
