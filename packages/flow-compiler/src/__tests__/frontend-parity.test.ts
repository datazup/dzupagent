import { describe, expect, it } from "vitest";
import { InMemoryDomainToolRegistry } from "@dzupagent/app-tools";

import { createFlowCompiler } from "../index.js";
import type { CompileSuccess } from "../types.js";

/**
 * F-R3 — frontend parity over the canonical compile path.
 *
 * `compileDsl()` and `compileDocument()` are two *frontends* onto one pipeline:
 * both build a `CompileOrchestratorDeps` and dispatch into the same four-stage
 * `compile-orchestrator/`. Nothing pinned that. Every pre-existing spec that
 * touches both exercises them one at a time, and the only equivalence assertion
 * in the suite (`compile.test.ts` "equivalent bounded v1 and v2 DSL") compares
 * two *DSL* sources through `compileDsl` — never DSL against document.
 *
 * So a change to either frontend could silently diverge the compiled result and
 * the whole suite would stay green. F-R5 asserts byte-identity over the
 * normalized artifact; this file defines the normalization that claim is over.
 *
 * ## The normalization is deliberately narrow
 *
 * The failure mode for a parity test is **vacuity**: a normalizer that strips
 * everything reduces both sides to `{}` and proves nothing. So this file splits
 * the surface in two and asserts BOTH halves:
 *
 *   - `stripNondeterminism` removes ONLY `compileId` — a fresh `crypto.randomUUID()`
 *     per compile. It is not merely a top-level field: it is embedded inside
 *     `artifact.classificationEnvelope.compileId` and duplicated into
 *     `evidence.correlationIds`, so a shallow strip leaves the artifacts unequal.
 *   - `sourceKind` / `sourceHash` are *provenance* and MUST differ — a DSL compile
 *     is not a document compile and evidence must say so. Those are asserted as
 *     inequalities, not normalized away.
 *
 * Everything else is asserted equal in full, by value.
 */

function makeResolver(tools: string[]) {
  const registry = new InMemoryDomainToolRegistry();
  for (const name of tools) {
    const namespace = name.split(".")[0] ?? name;
    registry.register({
      name,
      description: `test skill ${name}`,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      permissionLevel: "read",
      sideEffects: [],
      namespace,
    });
  }
  return {
    resolve(ref: string) {
      const def = registry.get(ref);
      if (!def) return null;
      return {
        ref,
        kind: "skill" as const,
        inputSchema: def.inputSchema,
        handle: def,
      };
    },
    listAvailable: () => registry.list().map((t) => t.name),
  };
}

/**
 * Strip the ONLY legitimately nondeterministic field: `compileId`. Recursive
 * because the id is also embedded in `artifact.classificationEnvelope` and in
 * `evidence.correlationIds` — a top-level `delete` leaves both unequal.
 *
 * Nothing else is removed. Widening this function is how this spec would go
 * vacuous, so `pins the normalizer itself` below fails if it strips more.
 */
function stripNondeterminism<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key, val) =>
    key === "compileId" ? undefined : val
  ) as T;
}

const FLOW_ID = "parity_flow";

/** Text-DSL frontend. */
const DSL_SOURCE = `
dsl: dzupflow/v1
id: ${FLOW_ID}
version: 1
policy:
  budgetCents: 2500
steps:
  - action:
      id: run
      ref: tasks.run
      input:
        mode: run
`;

/** Canonical-document frontend — the same flow, authored as an object. */
const DOCUMENT_SOURCE = {
  dsl: "dzupflow/v1",
  id: FLOW_ID,
  version: 1,
  policy: { budgetCents: 2500 },
  root: {
    type: "sequence",
    id: "root",
    nodes: [
      {
        type: "action",
        id: "run",
        toolRef: "tasks.run",
        input: { mode: "run" },
      },
    ],
  },
};

async function compileBothFrontends() {
  const compiler = createFlowCompiler({
    toolResolver: makeResolver(["tasks.run"]),
  });
  const fromDsl = await compiler.compileDsl(DSL_SOURCE);
  const fromDocument = await compiler.compileDocument(DOCUMENT_SOURCE);

  // Surface real diagnostics rather than a bare "expected true" if either side
  // fails to compile — a failed compile would otherwise read as a parity break.
  expect("errors" in fromDsl, JSON.stringify(fromDsl, null, 2)).toBe(false);
  expect("errors" in fromDocument, JSON.stringify(fromDocument, null, 2)).toBe(
    false
  );

  return {
    fromDsl: fromDsl as CompileSuccess,
    fromDocument: fromDocument as CompileSuccess,
  };
}

describe("F-R3 — compileDsl / compileDocument frontend parity", () => {
  it("produces a byte-identical artifact once compileId is stripped", async () => {
    const { fromDsl, fromDocument } = await compileBothFrontends();

    // The headline claim, and the one F-R5 byte-identity builds on.
    expect(stripNondeterminism(fromDsl.artifact)).toEqual(
      stripNondeterminism(fromDocument.artifact)
    );
  });

  it("agrees on target, semantic hash, and lowering reasons", async () => {
    const { fromDsl, fromDocument } = await compileBothFrontends();

    expect(fromDsl.target).toBe(fromDocument.target);
    // Pin the routing decision itself, not just that the two agree — two
    // frontends that both broke the same way would still "agree".
    expect(fromDsl.target).toBe("skill-chain");

    expect(fromDsl.requirements.semanticHash).toBe(
      fromDocument.requirements.semanticHash
    );
    expect(fromDsl.requirements).toEqual(fromDocument.requirements);
    expect(fromDsl.reasons).toEqual(fromDocument.reasons);
    expect(fromDsl.warnings).toEqual(fromDocument.warnings);
  });

  it("projects the same document-level policy ceiling from both frontends", async () => {
    const { fromDsl, fromDocument } = await compileBothFrontends();

    // Pin the VALUE on both sides. `toEqual(fromDocument.documentPolicy)` alone
    // would pass if BOTH frontends dropped the ceiling to `undefined` — the
    // exact G-C2 regression this is meant to catch.
    expect(fromDsl.documentPolicy).toEqual({ budgetCents: 2500 });
    expect(fromDocument.documentPolicy).toEqual({ budgetCents: 2500 });
  });

  it("agrees on canonical node identity and the lowered target in evidence", async () => {
    const { fromDsl, fromDocument } = await compileBothFrontends();

    // Node ids/paths are what `progressKey` and every downstream correlation
    // are keyed on, so a frontend-dependent path would break run correlation.
    expect(fromDsl.evidence.canonicalNodeIds).toEqual(
      fromDocument.evidence.canonicalNodeIds
    );
    expect(fromDsl.evidence.canonicalNodeIds).toEqual(["root", "run"]);
    expect(fromDsl.evidence.canonicalNodePaths).toEqual(
      fromDocument.evidence.canonicalNodePaths
    );
    expect(fromDsl.evidence.loweredTarget).toBe(
      fromDocument.evidence.loweredTarget
    );
    expect(fromDsl.evidence.semanticHash).toBe(
      fromDocument.evidence.semanticHash
    );
    expect(fromDsl.evidence.schema).toBe(fromDocument.evidence.schema);
  });

  it("emits an equal classification envelope apart from compileId", async () => {
    const { fromDsl, fromDocument } = await compileBothFrontends();

    expect(fromDsl.classificationEnvelope).toBeDefined();
    expect(fromDocument.classificationEnvelope).toBeDefined();
    expect(stripNondeterminism(fromDsl.classificationEnvelope)).toEqual(
      stripNondeterminism(fromDocument.classificationEnvelope)
    );
  });

  // -------------------------------------------------------------------------
  // The other half: what MUST differ. Without these, widening
  // `stripNondeterminism` would silently make every assertion above vacuous.
  // -------------------------------------------------------------------------

  it("keeps provenance distinct — sourceKind and sourceHash must NOT match", async () => {
    const { fromDsl, fromDocument } = await compileBothFrontends();

    expect(fromDsl.evidence.sourceKind).toBe("dzupflow-dsl");
    expect(fromDocument.evidence.sourceKind).toBe("flow-document");
    expect(fromDsl.evidence.sourceHash).not.toBe(
      fromDocument.evidence.sourceHash
    );
  });

  it("issues a distinct compileId per compile, threaded into evidence correlation", async () => {
    const { fromDsl, fromDocument } = await compileBothFrontends();

    expect(fromDsl.compileId).not.toBe(fromDocument.compileId);
    // The id must actually be threaded, not just present at the top level:
    // correlation is what makes an emitted run traceable back to its compile.
    expect(fromDsl.evidence.compileId).toBe(fromDsl.compileId);
    expect(fromDsl.evidence.correlationIds.compileId).toBe(fromDsl.compileId);
    expect(fromDocument.evidence.compileId).toBe(fromDocument.compileId);
  });

  it("pins the normalizer itself — it strips compileId and nothing else", async () => {
    // Guards the vacuity failure mode directly. If `stripNondeterminism` is
    // ever widened (say, to drop `sourceKind` or `semanticHash` to make a
    // failing parity test pass), this fails and says so.
    const probe = {
      compileId: "11111111-1111-1111-1111-111111111111",
      semanticHash: "sha256:keepme",
      sourceKind: "dzupflow-dsl",
      sourceHash: "sha256:alsokeepme",
      nested: {
        compileId: "22222222-2222-2222-2222-222222222222",
        keep: "value",
      },
      list: [{ compileId: "33333333-3333-3333-3333-333333333333", n: 1 }],
    };

    expect(stripNondeterminism(probe)).toEqual({
      semanticHash: "sha256:keepme",
      sourceKind: "dzupflow-dsl",
      sourceHash: "sha256:alsokeepme",
      nested: { keep: "value" },
      list: [{ n: 1 }],
    });
  });

  it("detects a real divergence — parity is not an artifact of normalization", async () => {
    // Positive control. If the two frontends are fed genuinely different flows,
    // the same assertions MUST fail. Without this, a normalizer that flattened
    // both sides into equality would look identical to true parity.
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tasks.run"]),
    });
    const baseline = await compiler.compileDsl(DSL_SOURCE);
    const divergent = await compiler.compileDocument({
      ...DOCUMENT_SOURCE,
      policy: { budgetCents: 9999 },
    });

    expect("errors" in baseline).toBe(false);
    expect("errors" in divergent).toBe(false);
    if ("errors" in baseline || "errors" in divergent) return;

    expect(baseline.documentPolicy).not.toEqual(divergent.documentPolicy);
  });
});

// ---------------------------------------------------------------------------
// F-R4 acceptance — durability-block parity over a loop-bearing (pipeline
// target) flow. The F-R3 ledger note recorded this exact gap: the fixture
// above carries `policy` but no `durability`, and durability lowering was
// exclusive to `runCompileDocument` (the CR-08 deferral). Both frontends now
// run `applyDocumentDurabilityContract`; this block is the demanded evidence.
//
// The flow routes to the `pipeline` target (loop ⇒ FOR_EACH bit), whose
// artifact node ids are freshly generated per compile — so full byte-identity
// is asserted under ordinal id renaming (`normalizePipelineIds`), with the
// durability fields ALSO pinned by value on both sides so a normalizer bug
// cannot fake parity by erasing them.
// ---------------------------------------------------------------------------

const DURABILITY_FLOW_ID = "durability_parity_flow";

const DURABILITY_DSL_SOURCE = `
dsl: dzupflow/v1
id: ${DURABILITY_FLOW_ID}
version: 1
durability:
  mode: durable
  checkpoint:
    strategy: after_each_node
    storeRef: pg://ck
steps:
  - loop:
      id: poll
      condition: "true"
      max_iterations: 3
      body:
        - action:
            id: run
            ref: tasks.run
            input:
              mode: run
`;

const DURABILITY_DOCUMENT_SOURCE = {
  dsl: "dzupflow/v1",
  id: DURABILITY_FLOW_ID,
  version: 1,
  durability: {
    mode: "durable",
    checkpoint: { strategy: "after_each_node", storeRef: "pg://ck" },
  },
  root: {
    type: "sequence",
    id: "root",
    nodes: [
      {
        type: "loop",
        id: "poll",
        condition: "true",
        maxIterations: 3,
        body: [
          {
            type: "action",
            id: "run",
            toolRef: "tasks.run",
            input: { mode: "run" },
          },
        ],
      },
    ],
  },
};

/**
 * Rename per-compile-random pipeline ids to ordinals (artifact id →
 * "pipeline", node ids → n0, n1, … in emission order) so two compiles of the
 * SAME flow become comparable. Everything else — names, types, config,
 * durability fields, metadata — is left untouched and therefore asserted.
 */
function normalizePipelineIds(artifact: unknown): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
  const nodes = clone["nodes"] as Array<Record<string, unknown>>;
  const idMap = new Map<string, string>();
  nodes.forEach((node, index) => {
    idMap.set(node["id"] as string, `n${index}`);
  });
  const rename = (id: unknown): unknown =>
    typeof id === "string" && idMap.has(id) ? idMap.get(id) : id;

  clone["id"] = "pipeline";
  clone["entryNodeId"] = rename(clone["entryNodeId"]);
  for (const node of nodes) {
    node["id"] = rename(node["id"]);
    if (Array.isArray(node["bodyNodeIds"])) {
      node["bodyNodeIds"] = node["bodyNodeIds"].map(rename);
    }
  }
  for (const edge of (clone["edges"] as Array<Record<string, unknown>>) ?? []) {
    edge["sourceNodeId"] = rename(edge["sourceNodeId"]);
    edge["targetNodeId"] = rename(edge["targetNodeId"]);
  }
  return clone;
}

describe("F-R4 — durability-block frontend parity (loop-bearing pipeline flow)", () => {
  async function compileDurabilityFrontends() {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tasks.run"]),
    });
    const fromDsl = await compiler.compileDsl(DURABILITY_DSL_SOURCE);
    const fromDocument = await compiler.compileDocument(
      DURABILITY_DOCUMENT_SOURCE
    );

    expect("errors" in fromDsl, JSON.stringify(fromDsl, null, 2)).toBe(false);
    expect(
      "errors" in fromDocument,
      JSON.stringify(fromDocument, null, 2)
    ).toBe(false);

    return {
      fromDsl: fromDsl as CompileSuccess,
      fromDocument: fromDocument as CompileSuccess,
    };
  }

  it("routes both frontends to the pipeline target", async () => {
    const { fromDsl, fromDocument } = await compileDurabilityFrontends();

    // Pin the routing decision itself — two frontends broken the same way
    // would still "agree".
    expect(fromDsl.target).toBe("pipeline");
    expect(fromDocument.target).toBe("pipeline");
  });

  it("lowers the SAME durability fields onto both artifacts, pinned by value", async () => {
    const { fromDsl, fromDocument } = await compileDurabilityFrontends();

    // Value pins on BOTH sides: `toEqual(other)` alone would pass if both
    // frontends dropped the strategy — the exact pre-F-R4 DSL behavior.
    const dslArtifact = fromDsl.artifact as Record<string, unknown>;
    const documentArtifact = fromDocument.artifact as Record<string, unknown>;
    expect(dslArtifact["checkpointStrategy"]).toBe("after_each_node");
    expect(documentArtifact["checkpointStrategy"]).toBe("after_each_node");
    expect(dslArtifact["checkpoint"]).toEqual(documentArtifact["checkpoint"]);
    expect(dslArtifact["checkpoint"]).toMatchObject({
      storeRef: "pg://ck",
    });

    expect(fromDsl.documentDurability).toEqual({
      mode: "durable",
      checkpoint: { strategy: "after_each_node", storeRef: "pg://ck" },
    });
    expect(fromDocument.documentDurability).toEqual(fromDsl.documentDurability);
  });

  it("produces an identical artifact under ordinal id renaming", async () => {
    const { fromDsl, fromDocument } = await compileDurabilityFrontends();

    // compileId is embedded in the artifact's classification envelope — the
    // SAME single-field strip the headline parity case uses composes here.
    expect(stripNondeterminism(normalizePipelineIds(fromDsl.artifact))).toEqual(
      stripNondeterminism(normalizePipelineIds(fromDocument.artifact))
    );
  });

  it("agrees on warnings, requirements, and semantic identity", async () => {
    const { fromDsl, fromDocument } = await compileDurabilityFrontends();

    expect(fromDsl.warnings).toEqual(fromDocument.warnings);
    expect(fromDsl.requirements).toEqual(fromDocument.requirements);
    expect(fromDsl.evidence.semanticHash).toBe(
      fromDocument.evidence.semanticHash
    );
  });

  it("positive control: without a durability block neither artifact carries the fields", async () => {
    // Proves the value pins above measure the durability contract, not a
    // default the lowerer would emit anyway.
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tasks.run"]),
    });
    const { durability: _dropped, ...documentWithout } =
      DURABILITY_DOCUMENT_SOURCE;
    const strippedDsl = DURABILITY_DSL_SOURCE.replace(
      "durability:\n  mode: durable\n  checkpoint:\n    strategy: after_each_node\n    storeRef: pg://ck\n",
      ""
    );
    // Guard the string surgery itself — a silent non-match would turn this
    // control into a duplicate of the positive cases.
    expect(strippedDsl).not.toContain("durability:");
    const fromDsl = await compiler.compileDsl(strippedDsl);
    const fromDocument = await compiler.compileDocument(documentWithout);

    expect("errors" in fromDsl, JSON.stringify(fromDsl, null, 2)).toBe(false);
    expect(
      "errors" in fromDocument,
      JSON.stringify(fromDocument, null, 2)
    ).toBe(false);
    if ("errors" in fromDsl || "errors" in fromDocument) return;

    expect(
      (fromDsl.artifact as Record<string, unknown>)["checkpointStrategy"]
    ).toBeUndefined();
    expect(
      (fromDocument.artifact as Record<string, unknown>)["checkpointStrategy"]
    ).toBeUndefined();
    expect(fromDsl.documentDurability).toBeUndefined();
    expect(fromDocument.documentDurability).toBeUndefined();
  });
});
