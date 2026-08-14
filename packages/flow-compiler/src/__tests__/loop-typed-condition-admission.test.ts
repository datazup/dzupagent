/**
 * F-R4 — compiler admission + emission gate for `loop.typedCondition`.
 *
 * Doc 16 mandate: no arbitrary condition strings in unattended profiles —
 * the typed evaluator is the sanctioned path. This file pins the three
 * compiler-side rules that make that real for loops:
 *
 *   1. Semantic stage: a typed loop is analyzed by the STRICT typed-condition
 *      contract (boolean-control), not the legacy string subset — and
 *      unattended admission no longer denies it (the denial is scoped to
 *      arbitrary strings; unattended-loop-denial.test.ts keeps the string
 *      case pinned red).
 *   2. Emission gate: generic targets have no reviewed typed-condition
 *      evaluator, so a VALID typed loop is blocked at stage 4 with
 *      TYPED_CONDITION_TARGET_UNSUPPORTED — same fail-closed contract branch
 *      already carries (route-target/typed-conditions.ts).
 *   3. Shape stage: `loop.maxIterations` must be a positive integer on the
 *      document path — parse/validate admit any number there, so this rule
 *      is the ONLY guard on that entry.
 *
 * Anti-vacuity: the same typed loop that is blocked at stage 4 passes stage 3
 * with zero condition diagnostics (vary the target gate, hold admission
 * accepting), and the maxIterations rule has an accepting control.
 */
import { describe, expect, it } from "vitest";

import { createFlowCompiler } from "../index.js";

const toolResolver = {
  resolve: () => null,
  listAvailable: () => [],
};

/** Ref-free boolean condition: strict analysis needs no state bindings. */
const TYPED_JSON = JSON.stringify({
  schema: "dzupagent.flowTypedCondition/v1",
  expression: {
    op: "eq",
    left: { op: "literal", value: "pending" },
    right: { op: "literal", value: "pending" },
  },
});

function typedLoopDsl(typedCondition: string): string {
  return [
    "dsl: dzupflow/v1",
    "id: typed-loop",
    "version: 1",
    "steps:",
    "  - loop:",
    "      id: retry",
    '      condition: "false"',
    `      typedCondition: ${typedCondition}`,
    "      max_iterations: 3",
    "      body:",
    "        - set:",
    "            id: mark",
    "            assign:",
    "              observed: true",
  ].join("\n");
}

function loopDoc(loopFields: Record<string, unknown>): Record<string, unknown> {
  return {
    dsl: "dzupflow/v1",
    id: "loop-doc",
    version: 1,
    root: {
      type: "sequence",
      id: "root",
      nodes: [
        {
          type: "loop",
          id: "retry",
          condition: "true",
          body: [{ type: "complete", id: "done" }],
          ...loopFields,
        },
      ],
    },
  };
}

describe("F-R4 — loop typed-condition admission", () => {
  it("unattended: a typed loop passes semantic admission and is blocked only by the target gate", async () => {
    const result = await createFlowCompiler({
      toolResolver,
      referencePolicy: "strict",
      admissionProfile: "unattended",
    }).compileDsl(typedLoopDsl(TYPED_JSON));

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) return;

    // The unattended mandate: typed conditions are the sanctioned path —
    // the arbitrary-string denial must NOT fire.
    expect(
      result.errors.some(
        (item) => item.code === "FLOW_LOOP_CONDITION_RUNTIME_ONLY"
      ),
      JSON.stringify(result.errors)
    ).toBe(false);
    // The strict typed analysis accepted it — no condition diagnostics.
    expect(
      result.errors.some((item) => item.code === "INVALID_CONDITION"),
      JSON.stringify(result.errors)
    ).toBe(false);
    // Fail-closed: no generic target has a reviewed evaluator, so emission
    // is blocked exactly where branch typed conditions are blocked.
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TYPED_CONDITION_TARGET_UNSUPPORTED",
          stage: 4,
          nodePath: "root.nodes[0].typedCondition",
        }),
      ])
    );
  });

  it("analyzes the typed form for loops: a non-boolean typed condition is rejected at stage 3", async () => {
    const result = await createFlowCompiler({
      toolResolver,
      referencePolicy: "strict",
      admissionProfile: "unattended",
    }).compileDsl(
      typedLoopDsl(
        JSON.stringify({
          schema: "dzupagent.flowTypedCondition/v1",
          expression: { op: "literal", value: 3 },
        })
      )
    );

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) return;
    const diagnostic = result.errors.find(
      (item) => item.code === "INVALID_CONDITION"
    );
    expect(diagnostic, JSON.stringify(result.errors)).toBeDefined();
    expect(diagnostic?.message).toContain("boolean");
  });

  it("rejects a non-integer maxIterations on the document path", async () => {
    const result = await createFlowCompiler({
      toolResolver,
    }).compileDocument(loopDoc({ maxIterations: 2.5 }));

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) return;
    expect(
      result.errors.some((item) =>
        item.message.includes("loop.maxIterations must be a positive integer")
      ),
      JSON.stringify(result.errors)
    ).toBe(true);
  });

  it("rejects a zero maxIterations on the document path", async () => {
    const result = await createFlowCompiler({
      toolResolver,
    }).compileDocument(loopDoc({ maxIterations: 0 }));

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) return;
    expect(
      result.errors.some((item) =>
        item.message.includes("loop.maxIterations must be a positive integer")
      ),
      JSON.stringify(result.errors)
    ).toBe(true);
  });

  it("accepting control: a positive-integer maxIterations document loop compiles", async () => {
    const result = await createFlowCompiler({
      toolResolver,
    }).compileDocument(loopDoc({ maxIterations: 3 }));

    expect("errors" in result ? JSON.stringify(result.errors) : "ok").toBe(
      "ok"
    );
  });

  it.each([
    ["branch", {
      type: "branch",
      id: "branch",
      condition: "true",
      then: [{ type: "set", id: "then", assign: { result: "then" } }],
    }],
    ["parallel", {
      type: "parallel",
      id: "parallel",
      branches: [[{ type: "set", id: "left", assign: { left: true } }]],
    }],
    ["try_catch", {
      type: "try_catch",
      id: "try",
      body: [{ type: "set", id: "body", assign: { body: true } }],
      catch: [{ type: "set", id: "catch", assign: { caught: true } }],
    }],
  ])("rejects structured %s bodies before typed-loop lowering", async (_kind, bodyNode) => {
    const result = await createFlowCompiler({ toolResolver }).compileDocument(
      loopDoc({
        condition: "false",
        typedCondition: JSON.parse(TYPED_JSON),
        maxIterations: 3,
        body: [bodyNode],
      })
    );

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) return;
    expect(result.errors).toEqual([
      expect.objectContaining({
        stage: 2,
        code: "STRUCTURED_TYPED_LOOP_BODY_UNSUPPORTED",
        nodePath: `root.nodes[0].body[0]`,
      }),
    ]);
  });
});
