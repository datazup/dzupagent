import {
  FLOW_NODE_KINDS,
  type FlowNode,
  type FlowNodeKind,
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

  it("reports an unregistered partial kind in a hand-built summary as PARTIAL_NODE under release-strict instead of throwing (G62)", () => {
    // External callers may pass a summary they built themselves; a kind that
    // is absent from the registry must block, not crash on the lookup.
    const unknownKind = "quantum.entangle" as string as FlowNodeKind;
    expect(FLOW_NODE_CAPABILITY_REGISTRY[unknownKind]).toBeUndefined();

    const requirements = {
      schema: "dzupagent.flowRequirements/v1" as const,
      target: "pipeline" as const,
      semanticHash: "fixture",
      nodeKinds: [unknownKind],
      requiredCapabilities: [TARGET_CAPABILITY_MANIFESTS.pipeline.capability],
      partialNodeKinds: [unknownKind],
      unsupportedNodeKinds: [],
    };
    // The host accepts the target and every capability string, so the
    // unregistered partial kind is the single dimension that blocks.
    const host = {
      schema: "dzupagent.hostCapabilityManifest/v1" as const,
      host: "fixture-host",
      version: "1.0.0",
      targets: ["pipeline" as const],
      capabilities: [...requirements.requiredCapabilities],
    };

    let strict: ReturnType<typeof resolveHostReadiness> | undefined;
    expect(() => {
      strict = resolveHostReadiness(requirements, host, {
        profile: "release-strict",
      });
    }).not.toThrow();
    expect(strict?.status).toBe("blocked");
    expect(strict?.diagnostics).toEqual([
      expect.objectContaining({
        code: "PARTIAL_NODE",
        nodeKind: "quantum.entangle",
        message: expect.stringContaining("release-strict"),
      }),
    ]);
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

describe("conformance matrix provenance and host columns (WP14)", () => {
  const provenance = {
    sourceRevision: "adc49f84",
    committedAt: "2026-10-21T18:04:11+02:00",
  };

  // Declares exactly what a single-node loop and return_to flow need, so the
  // partial and host-only kinds are executable here and not on the built-in
  // pipeline host.
  const fixtureHost = {
    schema: "dzupagent.hostCapabilityManifest/v1" as const,
    host: "fixture-host",
    version: "1.0.0",
    targets: ["pipeline" as const, "planning-dag" as const],
    capabilities: [
      TARGET_CAPABILITY_MANIFESTS.pipeline.capability,
      TARGET_CAPABILITY_MANIFESTS["planning-dag"].capability,
      "flow.runtime.loop@1",
      "flow.runtime.return_to@1",
    ],
  };

  const executable = (
    matrix: ReturnType<typeof generateFlowConformanceMatrix>,
    host: string,
    kind: FlowNodeKind,
  ) =>
    matrix.hosts
      ?.find((column) => column.host === host)
      ?.nodes.find((cell) => cell.kind === kind)?.executable;

  it("keeps the default matrix free of provenance and host columns", () => {
    const matrix = generateFlowConformanceMatrix();
    expect(matrix).not.toHaveProperty("provenance");
    expect(matrix).not.toHaveProperty("hosts");
    expect(renderFlowConformanceMatrixMarkdown(matrix)).not.toContain(
      "Source revision",
    );
  });

  it("records the git provenance it is given and renders it as a header line", () => {
    const matrix = generateFlowConformanceMatrix({ provenance });
    expect(matrix.provenance).toEqual(provenance);
    expect(renderFlowConformanceMatrixMarkdown(matrix)).toContain(
      "Source revision: `adc49f84` (committed 2026-10-21T18:04:11+02:00)",
    );
  });

  it("computes one column per host, in the order given, covering every node kind", () => {
    const matrix = generateFlowConformanceMatrix({
      hosts: [DZUPAGENT_PIPELINE_HOST_MANIFEST, fixtureHost],
    });
    expect(matrix.hosts?.map((column) => column.host)).toEqual([
      "dzupagent.pipeline-runtime",
      "fixture-host",
    ]);
    for (const column of matrix.hosts ?? []) {
      expect(column.nodes.map((cell) => cell.kind)).toEqual([...FLOW_NODE_KINDS]);
    }
  });

  it("marks a supported kind executable on the pipeline host (set)", () => {
    expect(FLOW_NODE_CAPABILITY_REGISTRY.set.status).toBe("supported");
    const matrix = generateFlowConformanceMatrix({
      hosts: [DZUPAGENT_PIPELINE_HOST_MANIFEST, fixtureHost],
    });
    expect(executable(matrix, "dzupagent.pipeline-runtime", "set")).toBe(true);
    // fixtureHost declares the planning-dag target but not flow.runtime.set@1.
    expect(executable(matrix, "fixture-host", "set")).toBe(false);
  });

  it("marks a partial kind executable only where its runtime capability is declared (loop)", () => {
    expect(FLOW_NODE_CAPABILITY_REGISTRY.loop.status).toBe("partial");
    const matrix = generateFlowConformanceMatrix({
      hosts: [DZUPAGENT_PIPELINE_HOST_MANIFEST, fixtureHost],
    });
    expect(executable(matrix, "dzupagent.pipeline-runtime", "loop")).toBe(false);
    expect(executable(matrix, "fixture-host", "loop")).toBe(true);
  });

  it("marks a host-only kind executable only where its runtime capability is declared (return_to)", () => {
    expect(FLOW_NODE_CAPABILITY_REGISTRY.return_to.status).toBe("host-only");
    const matrix = generateFlowConformanceMatrix({
      hosts: [DZUPAGENT_PIPELINE_HOST_MANIFEST, fixtureHost],
    });
    expect(executable(matrix, "dzupagent.pipeline-runtime", "return_to")).toBe(
      false,
    );
    expect(executable(matrix, "fixture-host", "return_to")).toBe(true);
  });

  it("requires the host to support the kind's route target and its capability", () => {
    const pipelineOnly = {
      ...fixtureHost,
      host: "pipeline-only-host",
      targets: ["pipeline" as const],
    };
    const noTargetCapability = {
      ...fixtureHost,
      host: "no-target-capability-host",
      capabilities: fixtureHost.capabilities.filter(
        (capability) =>
          capability !== TARGET_CAPABILITY_MANIFESTS.pipeline.capability,
      ),
    };
    const matrix = generateFlowConformanceMatrix({
      hosts: [pipelineOnly, noTargetCapability],
    });
    // return_to routes to planning-dag, which pipelineOnly does not accept.
    expect(executable(matrix, "pipeline-only-host", "return_to")).toBe(false);
    expect(executable(matrix, "pipeline-only-host", "loop")).toBe(true);
    // loop routes to pipeline; resolveHostReadiness requires the target's
    // capability string as well as the target itself.
    expect(executable(matrix, "no-target-capability-host", "loop")).toBe(false);
  });

  it("agrees with resolveHostReadiness for single-node flows of the tested kinds", () => {
    const flows: FlowNode[] = [
      { type: "set", assign: { ready: true } },
      {
        type: "loop",
        condition: "{{ state.keepGoing }}",
        body: [{ type: "action", toolRef: "test.run", input: {} }],
      },
      {
        type: "return_to",
        targetId: "start",
        condition: "{{ state.retry }}",
      },
    ];
    const hosts = [DZUPAGENT_PIPELINE_HOST_MANIFEST, fixtureHost];
    const matrix = generateFlowConformanceMatrix({ hosts });

    for (const flow of flows) {
      const requirements = collectFlowRequirements(flow);
      expect(requirements.target).toBe(
        FLOW_NODE_CAPABILITY_REGISTRY[flow.type].currentRoute,
      );
      for (const host of hosts) {
        expect(executable(matrix, host.host, flow.type)).toBe(
          resolveHostReadiness(requirements, host).status === "ready",
        );
      }
    }
  });

  it("renders a host executability table with one column per host", () => {
    const markdown = renderFlowConformanceMatrixMarkdown(
      generateFlowConformanceMatrix({
        provenance,
        hosts: [DZUPAGENT_PIPELINE_HOST_MANIFEST, fixtureHost],
      }),
    );
    expect(markdown).toContain("## Host executability");
    expect(markdown).toContain(
      "| Node | `dzupagent.pipeline-runtime` | `fixture-host` |",
    );
    expect(markdown).toContain("| `set` | yes | no |");
    expect(markdown).toContain("| `loop` | no | yes |");
    expect(markdown).toContain("| `return_to` | no | yes |");
  });

  it("refuses two host columns with the same host id", () => {
    expect(() =>
      generateFlowConformanceMatrix({
        hosts: [DZUPAGENT_PIPELINE_HOST_MANIFEST, DZUPAGENT_PIPELINE_HOST_MANIFEST],
      }),
    ).toThrow(/duplicate host "dzupagent.pipeline-runtime"/);
  });
});
