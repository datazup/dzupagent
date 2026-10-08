import { describe, expect, it } from "vitest";
import { InMemoryDomainToolRegistry } from "@dzupagent/app-tools";

import { createFlowCompiler } from "../index.js";
import type { CompileResult, CompileSuccess } from "../types.js";

/**
 * S5-G1-A0 — `compileDsl(source, { correlation })` threads a host run
 * correlation into `evidence.correlationIds` through the compiler's own rule
 * (`compile-orchestrator/evidence.ts`), so hosts no longer re-stamp evidence
 * after the fact.
 */

function makeResolver(tools: string[]) {
  const registry = new InMemoryDomainToolRegistry();
  for (const name of tools) {
    registry.register({
      name,
      description: `test skill ${name}`,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      permissionLevel: "read",
      sideEffects: [],
      namespace: name.split(".")[0] ?? name,
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
id: correlation_flow
version: 1
steps:
  - action:
      id: run
      ref: tasks.run
      input:
        mode: run
`;

function expectSuccess(result: CompileResult): CompileSuccess {
  expect("errors" in result, JSON.stringify(result, null, 2)).toBe(false);
  return result as CompileSuccess;
}

function compiler() {
  return createFlowCompiler({ toolResolver: makeResolver(["tasks.run"]) });
}

describe("S5-G1-A0 — compileDsl invocation correlation", () => {
  it("threads runId and eventCorrelationId into evidence", async () => {
    const result = expectSuccess(
      await compiler().compileDsl(DSL_SOURCE, {
        correlation: { runId: "run-42", eventCorrelationId: "evt-7" },
      })
    );

    expect(result.evidence.correlationIds).toEqual({
      compileId: result.compileId,
      eventCorrelationId: "evt-7",
      runId: "run-42",
    });
    expect(result.evidence.sourceKind).toBe("dzupflow-dsl");
  });

  it("defaults eventCorrelationId to the compileId when only runId is given", async () => {
    const result = expectSuccess(
      await compiler().compileDsl(DSL_SOURCE, {
        correlation: { runId: "run-43" },
      })
    );

    expect(result.evidence.correlationIds).toEqual({
      compileId: result.compileId,
      eventCorrelationId: result.compileId,
      runId: "run-43",
    });
  });

  it("is unchanged without options", async () => {
    const result = expectSuccess(await compiler().compileDsl(DSL_SOURCE));

    expect(result.evidence.correlationIds).toEqual({
      compileId: result.compileId,
      eventCorrelationId: result.compileId,
    });
    expect(result.evidence.sourceKind).toBe("dzupflow-dsl");
  });

  it("keeps the source hash independent of the correlation", async () => {
    const plain = expectSuccess(await compiler().compileDsl(DSL_SOURCE));
    const correlated = expectSuccess(
      await compiler().compileDsl(DSL_SOURCE, {
        correlation: { runId: "run-44" },
      })
    );

    expect(correlated.evidence.sourceHash).toBe(plain.evidence.sourceHash);
  });
});
