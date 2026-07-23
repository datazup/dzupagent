import { FLOW_NODE_KINDS } from "@dzupagent/flow-ast";
import {
  BUILT_IN_PRIMITIVES,
  BUILT_IN_SDL_FRAGMENT_DEFINITIONS,
} from "@dzupagent/flow-dsl";
import { EXECUTION_LEAF_KINDS } from "@dzupagent/runtime-contracts/orchestration";
import { describe, expect, it } from "vitest";

import {
  generateFlowSemanticCatalog,
  renderFlowSemanticCatalogMarkdown,
} from "../index.js";

describe("flow semantic catalog", () => {
  it("unifies every built-in semantic surface without drift diagnostics", () => {
    const catalog = generateFlowSemanticCatalog();

    expect(catalog.schema).toBe("dzupagent.flowSemanticCatalog/v1");
    expect(catalog.status).toBe("valid");
    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.summary).toEqual({
      nodes: FLOW_NODE_KINDS.length,
      primitives: BUILT_IN_PRIMITIVES.length,
      fragments: BUILT_IN_SDL_FRAGMENT_DEFINITIONS.length,
      executionLeaves: EXECUTION_LEAF_KINDS.length,
    });
    expect(catalog.nodes.map((entry) => entry.kind).sort()).toEqual(
      [...FLOW_NODE_KINDS].sort(),
    );
    expect(catalog.executionLeaves.map((entry) => entry.kind)).toEqual(
      [...EXECUTION_LEAF_KINDS].sort(),
    );
  });

  it("classifies framework, primitive, execution, profile, and product surfaces", () => {
    const catalog = generateFlowSemanticCatalog();
    const classification = Object.fromEntries(
      catalog.nodes.map((entry) => [entry.kind, entry.classification]),
    );

    expect(classification.sequence).toBe("kernel");
    expect(classification.validate).toBe("primitive");
    expect(classification.prompt).toBe("execution-leaf");
    expect(classification["knowledge.query"]).toBe("profile-action");
    expect(classification["spdd.project_plan"]).toBe("product-action");
  });

  it("binds primitive executors and expansion aliases to known semantics", () => {
    const catalog = generateFlowSemanticCatalog();
    const adapter = catalog.primitives.find(
      (entry) => entry.identity === "primitive:adapter.run@1",
    );
    const reviewLoop = catalog.primitives.find(
      (entry) => entry.identity === "primitive:collab.review_loop@2",
    );

    expect(adapter?.execution).toEqual({
      mode: "execution-leaf",
      target: "adapter.run",
    });
    expect(adapter?.contract).toMatchObject({
      schema: "dzupagent.primitiveDefinition/v2",
      ref: "primitive://adapter.run@1",
      acceptedInputClassifications: ["public", "internal"],
      credentialInputs: "handle-only",
      outputPorts: {
        result: {
          classification: "internal",
          persistence: "state",
        },
      },
      compatibility: {
        semanticHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    expect(
      reviewLoop?.expandsTo.find((target) => target.authored === "if"),
    ).toEqual({
      authored: "if",
      resolvedNodeKind: "branch",
      primitiveRefs: [],
    });
  });

  it("records fragment ports and all nested node kinds", () => {
    const catalog = generateFlowSemanticCatalog();
    const fragment = catalog.fragments.find(
      (entry) => entry.id === "sdlc.batch_validation",
    );

    expect(fragment).toMatchObject({
      identity: "fragment:sdlc.batch_validation@1",
      namespace: "sdlc",
      catalogRef: "dzup.sdlc@1",
      params: ["concurrency", "failFast", "items"],
      exports: ["statuses"],
      nodeKinds: ["for_each", "sequence", "validate.schema"],
      fragmentRefs: [],
    });

    expect(
      catalog.fragments.find((entry) => entry.id === "sdlc.packet_fanout"),
    ).toMatchObject({
      fragmentRefs: ["sdlc.gated_packet@1"],
    });
  });

  it("renders a deterministic generated reference", () => {
    const first = renderFlowSemanticCatalogMarkdown();
    const second = renderFlowSemanticCatalogMarkdown();

    expect(second).toBe(first);
    expect(first).toContain("# Flow Semantic Catalog");
    expect(first).toContain("Status: **valid**");
    expect(first).toContain(`- Nodes: ${FLOW_NODE_KINDS.length}`);
    expect(first).toContain("`collab.review_loop@2`");
    expect(first).toContain("`sdlc.validation_gate@1`");
    expect(first).toContain("No catalog drift diagnostics.");
  });
});
