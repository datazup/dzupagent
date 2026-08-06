import { describe, expect, it } from "vitest";
import { InMemoryDomainToolRegistry } from "@dzupagent/app-tools";

import { compileTextInput, createFlowCompiler } from "../index.js";

/**
 * G-C2 — a DSL-authored `policy.budgetCents` is a real spend ceiling, and until
 * the grammar admitted `policy` it was discarded between authoring and the
 * compiled artifact: the flow compiled cleanly and simply carried no ceiling.
 *
 * `flow-dsl` round-trip coverage proves the field survives normalize/format, but
 * NOT that it reaches the artifact. That is the assertion that matters here — a
 * grammar-only fix that never lands in `CompileSuccess.documentPolicy` is
 * precisely the failure this gap describes, so these pin the compiled result.
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

const FLOW_WITH_CEILING = `
dsl: dzupflow/v1
id: policy_flow
version: 1
policy:
  budgetCents: 2500
  timeoutMs: 60000
steps:
  - action:
      id: run
      ref: tasks.run
      input:
        mode: run
`;

describe("document-level policy reaches the compiled artifact (G-C2)", () => {
  it("carries a DSL-authored budget ceiling into CompileSuccess.documentPolicy", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tasks.run"]),
    });

    const result = await compileTextInput(compiler, FLOW_WITH_CEILING);

    expect("errors" in result).toBe(false);
    const success = result as { documentPolicy?: Record<string, unknown> };
    // Pin the VALUE. Asserting mere presence would pass for a ceiling that
    // arrived as `{}` or with a coerced budget — the same governance failure.
    expect(success.documentPolicy).toEqual({
      budgetCents: 2500,
      timeoutMs: 60000,
    });
  });

  it("omits documentPolicy when the flow authors no policy (no invented ceiling)", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tasks.run"]),
    });

    const result = await compileTextInput(
      compiler,
      FLOW_WITH_CEILING.replace(
        "policy:\n  budgetCents: 2500\n  timeoutMs: 60000\n",
        ""
      )
    );

    expect("errors" in result).toBe(false);
    expect(
      (result as { documentPolicy?: unknown }).documentPolicy
    ).toBeUndefined();
  });
});
