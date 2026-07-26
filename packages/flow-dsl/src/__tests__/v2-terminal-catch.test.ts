import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  parseDslToDocument,
} from "../index.js";
import {
  evaluatePrimitiveTerminalCatch,
  FLOW_PRIMITIVE_TERMINAL_CATCH_CAPABILITY,
} from "../v2-terminal-catch.js";

const ADAPTER_RUN = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve(
  "adapter.run",
  "1",
)!;

describe(FLOW_PRIMITIVE_TERMINAL_CATCH_CAPABILITY, () => {
  it("creates content-free typed terminal attempts with explicit outcomes", () => {
    const result = evaluatePrimitiveTerminalCatch(ADAPTER_RUN, [
      {
        match: ["ADAPTER_CANCELLED"],
        action: "fail",
        code: "adapter.cancelled",
      },
    ]);

    expect(result).toEqual({
      ok: true,
      contract: {
        clauses: [
          {
            matches: [
              {
                schema: "dzupagent.primitiveTerminalAttempt/v1",
                primitiveRef: ADAPTER_RUN.ref,
                primitiveSemanticHash:
                  ADAPTER_RUN.compatibility.semanticHash,
                errorCode: "ADAPTER_CANCELLED",
                status: "terminal",
                retryable: false,
                attemptIdentity: "same-invocation",
                classification: "internal",
                rawProviderContent: "excluded",
              },
            ],
            outcome: {
              action: "fail",
              code: "adapter.cancelled",
            },
          },
        ],
      },
    });
    if (!result.ok) throw new Error("expected valid terminal catch");
    expect(Object.isFrozen(result.contract)).toBe(true);
    expect(Object.isFrozen(result.contract.clauses)).toBe(true);
    expect(Object.isFrozen(result.contract.clauses[0]?.matches)).toBe(true);
  });

  it("rejects retryable, undeclared, wildcard, and repeated errors", () => {
    const result = evaluatePrimitiveTerminalCatch(ADAPTER_RUN, [
      {
        match: [
          "ADAPTER_FAILED",
          "NOT_DECLARED",
          "*",
          "ADAPTER_CANCELLED",
        ],
        action: "continue",
      },
      {
        match: ["ADAPTER_CANCELLED"],
        action: "complete",
      },
    ]);

    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "V2_CATCH_ERROR_NOT_TERMINAL",
          field: "[0].match[0]",
        }),
        expect.objectContaining({
          code: "V2_CATCH_ERROR_UNDECLARED",
          field: "[0].match[1]",
        }),
        expect.objectContaining({
          code: "V2_CATCH_MATCH_INVALID",
          field: "[0].match[2]",
        }),
        expect.objectContaining({
          code: "V2_CATCH_MATCH_DUPLICATE",
          field: "[1].match[0]",
        }),
      ]),
    });
  });

  it("requires an explicit valid outcome and a fail-only stable code", () => {
    expect(
      evaluatePrimitiveTerminalCatch(ADAPTER_RUN, [
        {
          match: ["ADAPTER_CANCELLED"],
          action: "fail",
        },
      ]),
    ).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          code: "V2_CATCH_FAILURE_CODE_REQUIRED",
          field: "[0].code",
        }),
      ],
    });

    expect(
      evaluatePrimitiveTerminalCatch(ADAPTER_RUN, [
        {
          match: ["ADAPTER_CANCELLED"],
          action: "continue",
          code: "not.allowed",
        },
      ]),
    ).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          code: "V2_CATCH_FAILURE_CODE_FORBIDDEN",
          field: "[0].code",
        }),
      ],
    });
  });

  it("binds catch metadata without inventing V1 execution semantics", () => {
    const parsed = parseDslToDocument(`
dsl: dzupflow/v2
id: caught-terminal
version: 2.0.0
steps:
  - id: draft
    use: adapter.run@1
    with:
      provider: codex
      instructions: Draft.
    catch:
      - match:
          - ADAPTER_CANCELLED
        action: fail
        code: adapter.cancelled
    save:
      result: state.draft
`);

    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics, null, 2));
    }
    expect(parsed.frontend?.terminalCatches).toEqual([
      {
        authoredPath: "root.steps[0]",
        primitiveRef: ADAPTER_RUN.ref,
        primitiveSemanticHash: ADAPTER_RUN.compatibility.semanticHash,
        catch: {
          clauses: [
            {
              matches: [
                expect.objectContaining({
                  errorCode: "ADAPTER_CANCELLED",
                  status: "terminal",
                  retryable: false,
                  rawProviderContent: "excluded",
                }),
              ],
              outcome: {
                action: "fail",
                code: "adapter.cancelled",
              },
            },
          ],
        },
      },
    ]);
    expect(parsed.document.root.nodes[0]).not.toHaveProperty("catch");
    expect(parsed.document.root.nodes[0]).not.toHaveProperty("on_error");
  });

  it("reports exact terminal-error and kernel catch paths", () => {
    const retryable = parseDslToDocument(`
dsl: dzupflow/v2
id: retryable-catch
version: 2.0.0
steps:
  - id: draft
    use: adapter.run@1
    with:
      provider: codex
      instructions: Draft.
    catch:
      - match:
          - ADAPTER_FAILED
        action: continue
`);
    expect(retryable.ok).toBe(false);
    if (retryable.ok) throw new Error("expected retryable catch rejection");
    expect(retryable.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "V2_CATCH_ERROR_NOT_TERMINAL",
        path: "root.steps[0].catch[0].match[0]",
      }),
    );

    const kernel = parseDslToDocument(`
dsl: dzupflow/v2
id: kernel-catch
version: 2.0.0
steps:
  - id: done
    use: core.complete@1
    with:
      result: done
    catch:
      - match:
          - FAILURE
        action: fail
        code: kernel.failure
`);
    expect(kernel.ok).toBe(false);
    if (kernel.ok) throw new Error("expected kernel catch rejection");
    expect(kernel.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "V2_CATCH_REQUIRES_PRIMITIVE",
        path: "root.steps[0].catch",
      }),
    );
  });
});
