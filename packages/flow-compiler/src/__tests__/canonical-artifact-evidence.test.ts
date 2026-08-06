import { describe, expect, it } from "vitest";
import { InMemoryDomainToolRegistry } from "@dzupagent/app-tools";

import {
  FLOW_CANONICAL_ARTIFACT_SCHEMA,
  canonicalizeArtifact,
  createFlowCompiler,
} from "../index.js";
import { hashSource } from "../compile-orchestrator/evidence.js";
import type { CompileSuccess } from "../types.js";

/**
 * F-R3 — canonical-artifact identity as required compile evidence.
 *
 * `evidence.canonicalArtifact` names the versioned normalization
 * (`dzupagent.flowCanonicalArtifact/v1` = strip `compileId` recursively,
 * nothing else) and carries a hash over the artifact in that form. It is a
 * THIRD identity, deliberately separate from `sourceHash` (input provenance)
 * and `semanticHash` (requirement identity): two frontends with different
 * provenance must still agree on it, and recompiling the same input must
 * reproduce it even though `compileId` is a fresh UUID each run. F-R5
 * byte-identity is asserted over the same normalized form.
 *
 * Vacuity guards: the hash must CHANGE when the flow genuinely changes, and
 * `canonicalizeArtifact` is pinned to strip only `compileId` — widening the
 * strip is how this evidence would go silently meaningless.
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

const DSL_SOURCE = `
dsl: dzupflow/v1
id: canonical_artifact_flow
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

const DOCUMENT_SOURCE = {
  dsl: "dzupflow/v1",
  id: "canonical_artifact_flow",
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

function makeCompiler() {
  return createFlowCompiler({ toolResolver: makeResolver(["tasks.run"]) });
}

async function compileSuccess(
  run: () => Promise<unknown>,
): Promise<CompileSuccess> {
  const result = (await run()) as CompileSuccess | { errors: unknown };
  expect("errors" in result, JSON.stringify(result, null, 2)).toBe(false);
  return result as CompileSuccess;
}

describe("F-R3 — canonical-artifact evidence", () => {
  it("carries the versioned canonical-artifact identity, separate from source and semantic identity", async () => {
    const compiler = makeCompiler();
    const result = await compileSuccess(() => compiler.compileDsl(DSL_SOURCE));

    expect(result.evidence.canonicalArtifact.schema).toBe(
      FLOW_CANONICAL_ARTIFACT_SCHEMA,
    );
    expect(result.evidence.canonicalArtifact.hash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );

    // Three DISTINCT identities — sharing a value would mean one of them is
    // wired from the wrong input.
    expect(result.evidence.canonicalArtifact.hash).not.toBe(
      result.evidence.sourceHash,
    );
    expect(result.evidence.canonicalArtifact.hash).not.toBe(
      result.evidence.semanticHash,
    );
  });

  it("hashes exactly the canonical form — recomputable from the artifact with compileId stripped", async () => {
    const compiler = makeCompiler();
    const result = await compileSuccess(() => compiler.compileDsl(DSL_SOURCE));

    expect(result.evidence.canonicalArtifact.hash).toBe(
      hashSource(canonicalizeArtifact(result.artifact)),
    );
    // The artifact really does embed the run-variant id (inside the
    // classification envelope), so the strip is doing real work here — this
    // recompute would still pass with an identity "canonicalization", the
    // stability case below would not.
    expect(JSON.stringify(result.artifact)).toContain(result.compileId);
  });

  it("is stable across recompiles of the same input while compileId varies", async () => {
    const compiler = makeCompiler();
    const first = await compileSuccess(() => compiler.compileDsl(DSL_SOURCE));
    const second = await compileSuccess(() => compiler.compileDsl(DSL_SOURCE));

    expect(second.compileId).not.toBe(first.compileId);
    expect(second.evidence.canonicalArtifact.hash).toBe(
      first.evidence.canonicalArtifact.hash,
    );
  });

  it("agrees across the DSL and document frontends despite divergent provenance", async () => {
    const compiler = makeCompiler();
    const fromDsl = await compileSuccess(() => compiler.compileDsl(DSL_SOURCE));
    const fromDocument = await compileSuccess(() =>
      compiler.compileDocument(DOCUMENT_SOURCE),
    );

    expect(fromDsl.evidence.sourceHash).not.toBe(
      fromDocument.evidence.sourceHash,
    );
    expect(fromDsl.evidence.canonicalArtifact.hash).toBe(
      fromDocument.evidence.canonicalArtifact.hash,
    );
  });

  it("changes when the flow genuinely changes — the identity is not vacuous", async () => {
    const compiler = makeCompiler();
    const baseline = await compileSuccess(() =>
      compiler.compileDsl(DSL_SOURCE),
    );
    const changed = await compileSuccess(() =>
      compiler.compileDsl(DSL_SOURCE.replace("mode: run", "mode: retry")),
    );

    expect(changed.evidence.canonicalArtifact.hash).not.toBe(
      baseline.evidence.canonicalArtifact.hash,
    );
  });

  it("pins the normalizer itself — compileId stripped at every depth, nothing else", () => {
    // The fixture deliberately carries the realistic sibling keys a widened
    // strip would plausibly reach for (`name`, `input`, the other two hash
    // identities) — every one of them must SURVIVE canonicalization, so any
    // widening beyond `compileId` fails here, not just exotic keys.
    const input = {
      compileId: "11111111-1111-1111-1111-111111111111",
      name: "keep-name",
      sourceHash: "sha256:keep-source",
      semanticHash: "sha256:keep-semantic",
      input: { mode: "keep-input" },
      nested: {
        compileId: "22222222-2222-2222-2222-222222222222",
        semanticHash: "sha256:keep-nested-semantic",
        keep: true,
      },
      list: [{ compileId: "33333333-3333-3333-3333-333333333333", n: 1 }],
    };

    expect(canonicalizeArtifact(input)).toEqual({
      name: "keep-name",
      sourceHash: "sha256:keep-source",
      semanticHash: "sha256:keep-semantic",
      input: { mode: "keep-input" },
      nested: {
        semanticHash: "sha256:keep-nested-semantic",
        keep: true,
      },
      list: [{ n: 1 }],
    });
  });

  it("derives sensitivity from the canonicalized body, not merely an embedded digest", async () => {
    // Vacuity guard for the vacuity guard. "changes when the flow genuinely
    // changes" above compares two full compiles, and the artifact embeds a
    // PRE-COMPUTED `classificationHash` that already differs between them.
    // That digest alone is enough to move the evidence hash, so that case stays
    // green even if canonicalization strips the entire flow body — verified
    // empirically: stripping `input` left `classificationHash` as the ONLY
    // surviving difference and the case still passed.
    //
    // So assert sensitivity where no embedded digest can carry it: hash two
    // artifact-shaped objects that differ ONLY in a body field, with every
    // digest field held equal.
    const withDigestsHeldEqual = (mode: string) => ({
      compileId: "11111111-1111-1111-1111-111111111111",
      classificationHash: "sha256:held-equal",
      semanticHash: "sha256:held-equal",
      sourceHash: "sha256:held-equal",
      root: { type: "sequence", nodes: [{ id: "run", input: { mode } }] },
    });

    expect(hashSource(canonicalizeArtifact(withDigestsHeldEqual("retry")))).not.toBe(
      hashSource(canonicalizeArtifact(withDigestsHeldEqual("run"))),
    );
  });
});
