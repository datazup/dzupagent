import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  parseDslToDocument,
} from "../index.js";
import {
  evaluatePrimitiveRetryPolicy,
  FLOW_PRIMITIVE_RETRY_POLICY_CAPABILITY,
} from "../v2-retry-policy.js";

const ADAPTER_RUN = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve(
  "adapter.run",
  "1",
)!;

describe(FLOW_PRIMITIVE_RETRY_POLICY_CAPABILITY, () => {
  it("accepts exact retryable errors with bounded same-invocation backoff", () => {
    const result = evaluatePrimitiveRetryPolicy(ADAPTER_RUN, {
      match: ["ADAPTER_FAILED"],
      maxAttempts: 3,
      backoff: {
        strategy: "exponential",
        initialMs: 500,
        maxMs: 5_000,
        jitter: "full",
      },
    });

    expect(result).toEqual({
      ok: true,
      policy: {
        match: ["ADAPTER_FAILED"],
        maxAttempts: 3,
        backoff: {
          strategy: "exponential",
          initialMs: 500,
          maxMs: 5_000,
          jitter: "full",
        },
        attemptIdentity: "same-invocation",
      },
    });
    if (!result.ok) throw new Error("expected valid retry policy");
    expect(Object.isFrozen(result.policy)).toBe(true);
    expect(Object.isFrozen(result.policy.match)).toBe(true);
    expect(Object.isFrozen(result.policy.backoff)).toBe(true);
  });

  it("fails closed for undeclared, terminal, wildcard, and duplicate errors", () => {
    const result = evaluatePrimitiveRetryPolicy(ADAPTER_RUN, {
      match: [
        "ADAPTER_FAILED",
        "ADAPTER_FAILED",
        "ADAPTER_CANCELLED",
        "NOT_DECLARED",
        "*",
      ],
      maxAttempts: 2,
    });

    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "V2_RETRY_MATCH_DUPLICATE",
          field: "match[1]",
        }),
        expect.objectContaining({
          code: "V2_RETRY_ERROR_NOT_RETRYABLE",
          field: "match[2]",
        }),
        expect.objectContaining({
          code: "V2_RETRY_ERROR_UNDECLARED",
          field: "match[3]",
        }),
        expect.objectContaining({
          code: "V2_RETRY_MATCH_INVALID",
          field: "match[4]",
        }),
      ]),
    });
  });

  it("rejects unbounded attempts and incomplete or inverted backoff", () => {
    expect(
      evaluatePrimitiveRetryPolicy(ADAPTER_RUN, {
        match: ["ADAPTER_FAILED"],
        maxAttempts: 21,
        backoff: {
          strategy: "random",
          initialMs: 1_000,
          maxMs: 100,
          jitter: "sometimes",
        },
      }),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "V2_RETRY_MAX_ATTEMPTS_INVALID",
          field: "maxAttempts",
        }),
        expect.objectContaining({
          code: "V2_RETRY_BACKOFF_INVALID",
          field: "backoff.strategy",
        }),
        expect.objectContaining({
          code: "V2_RETRY_BACKOFF_INVALID",
          field: "backoff.maxMs",
        }),
        expect.objectContaining({
          code: "V2_RETRY_BACKOFF_INVALID",
          field: "backoff.jitter",
        }),
      ]),
    });
  });

  it("binds exact primitive identity without inventing v1 runtime retry", () => {
    const parsed = parseDslToDocument(`
dsl: dzupflow/v2
id: retry-aware
version: 2.0.0
steps:
  - id: draft
    use: adapter.run@1
    with:
      provider: codex
      instructions: Draft.
    retry:
      match:
        - ADAPTER_FAILED
      maxAttempts: 3
      backoff:
        strategy: fixed
        initialMs: 100
        maxMs: 100
        jitter: none
    save:
      result: state.draft
`);

    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics, null, 2));
    }
    expect(parsed.frontend?.retryPolicies).toEqual([
      {
        authoredPath: "root.steps[0]",
        primitiveRef: ADAPTER_RUN.ref,
        primitiveSemanticHash: ADAPTER_RUN.compatibility.semanticHash,
        retry: {
          match: ["ADAPTER_FAILED"],
          maxAttempts: 3,
          backoff: {
            strategy: "fixed",
            initialMs: 100,
            maxMs: 100,
            jitter: "none",
          },
          attemptIdentity: "same-invocation",
        },
      },
    ]);
    expect(parsed.document.root.nodes[0]).not.toHaveProperty("retry");
  });

  it("reports exact authored paths for terminal errors and kernel retry", () => {
    const terminal = parseDslToDocument(`
dsl: dzupflow/v2
id: terminal-retry
version: 2.0.0
steps:
  - id: draft
    use: adapter.run@1
    with:
      provider: codex
      instructions: Draft.
    retry:
      match:
        - ADAPTER_CANCELLED
      maxAttempts: 2
`);
    expect(terminal.ok).toBe(false);
    if (terminal.ok) throw new Error("expected terminal error rejection");
    expect(terminal.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "V2_RETRY_ERROR_NOT_RETRYABLE",
        path: "root.steps[0].retry.match[0]",
      }),
    );

    const kernel = parseDslToDocument(`
dsl: dzupflow/v2
id: kernel-retry
version: 2.0.0
steps:
  - id: done
    use: core.complete@1
    with:
      result: done
    retry:
      match:
        - ANY
      maxAttempts: 2
`);
    expect(kernel.ok).toBe(false);
    if (kernel.ok) throw new Error("expected kernel retry rejection");
    expect(kernel.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "V2_RETRY_REQUIRES_PRIMITIVE",
        path: "root.steps[0].retry",
      }),
    );
  });
});
