import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  definePrimitiveV2,
  extendPrimitiveRegistryV2,
  type PrimitiveDefinitionV2,
} from "@dzupagent/flow-dsl";
import { describe, expect, it } from "vitest";

import {
  simulateV2InactiveLocalTarget,
  V2_INACTIVE_LOCAL_SIMULATOR_ID,
  V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
  type V2InactiveLocalSimulationRequest,
} from "../v2-inactive-local-target.js";

const resolver = {
  resolve: () => null,
  listAvailable: () => [],
};

function multiPortAdapter(): PrimitiveDefinitionV2 {
  const base = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve("adapter.run", "1");
  if (base === undefined) throw new Error("missing adapter.run@1");
  const {
    compatibility: { semanticHash: _semanticHash, ...compatibility },
    ...contract
  } = base;
  return definePrimitiveV2({
    ...contract,
    ref: "primitive://adapter.run@2",
    version: "2",
    owner: "test.external",
    outputPorts: {
      result: base.outputPorts.result!,
      receipt: {
        schema: {
          type: "object",
          properties: { digest: { type: "string", minLength: 1 } },
          required: ["digest"],
          additionalProperties: false,
        },
        cardinality: "one",
        classification: "internal",
        persistence: "state",
      },
    },
    compatibility: {
      ...compatibility,
      supersedes: [base.ref],
      deprecatedAliases: [],
    },
  });
}

function fixture(
  options: {
    readonly catchAction?: "continue" | "complete" | "fail";
    readonly requireApproval?: boolean;
    readonly timeoutMs?: number;
    readonly maxAttempts?: number;
  } = {}
) {
  const primitive = multiPortAdapter();
  const registry = extendPrimitiveRegistryV2(BUILT_IN_PRIMITIVE_REGISTRY_V2, [
    primitive,
  ]);
  const catchAction = options.catchAction ?? "continue";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const source = `
dsl: dzupflow/v2
id: inactive-local-simulator
version: 2.0.0
inputs:
  ready: boolean
steps:
  - id: run
    use: adapter.run@2
    when:
      ref: inputs.ready
    with:
      provider: codex
      instructions: Draft.
    policy:
      timeoutMs: ${timeoutMs}
      budgetCents: 100
${
  options.requireApproval === true ? "      requireApproval: true\n" : ""
}    retry:
      match:
        - ADAPTER_FAILED
      maxAttempts: ${maxAttempts}
      backoff:
        strategy: fixed
        initialMs: 10
        maxMs: 10
        jitter: none
    catch:
      - match:
          - ADAPTER_CANCELLED
        action: ${catchAction}
${
  catchAction === "fail" ? "        code: LOCAL_ADAPTER_CANCELLED\n" : ""
}    save:
      result: state.result
      receipt: state.receipt
`;
  const base = {
    source,
    compilerOptions: {
      toolResolver: resolver,
      referencePolicy: "strict" as const,
      primitiveRegistry: registry,
      primitiveBindings: {
        "adapter.run": {
          ref: primitive.ref,
          semanticHash: primitive.compatibility.semanticHash,
        },
      },
    },
    hostCapabilities: V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
    conditionBindings: { inputs: { ready: true } },
    initialState: { retained: "before" },
  };
  return { base, primitive };
}

function request(
  attempts: V2InactiveLocalSimulationRequest["attempts"],
  options: Parameters<typeof fixture>[0] = {}
): V2InactiveLocalSimulationRequest {
  return { ...fixture(options).base, attempts };
}

const success = {
  status: "success" as const,
  outputs: { result: { text: "done" }, receipt: { digest: "abc" } },
  durationMs: 200,
  costCents: 2,
};

const retryable = {
  status: "error" as const,
  code: "ADAPTER_FAILED",
  durationMs: 100,
  costCents: 1,
};

describe("inactive provider-free V2 simulator", () => {
  it("executes deterministic retry and atomic multi-port save with zero external authority", async () => {
    const input = request([retryable, success]);
    const first = await simulateV2InactiveLocalTarget(input);
    const second = await simulateV2InactiveLocalTarget(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      receipt: {
        target: V2_INACTIVE_LOCAL_SIMULATOR_ID,
        status: "completed",
        attempts: [
          {
            attempt: 1,
            status: "retryable-error",
            scheduledBackoffMs: 10,
            cumulativeDurationMs: 110,
            cumulativeCostCents: 1,
          },
          {
            attempt: 2,
            status: "success",
            cumulativeDurationMs: 310,
            cumulativeCostCents: 3,
          },
        ],
        state: {
          retained: "before",
          result: { text: "done" },
          receipt: { digest: "abc" },
        },
        authority: {
          scriptedLocalExecution: true,
          runtimeHandlerInvocation: false,
          providerDispatch: false,
          externalStateMutation: false,
          continuation: false,
          deployment: false,
          promotion: false,
          activation: false,
        },
      },
    });
    if (!first.ok) throw new Error("expected completed simulation");
    expect(Object.isFrozen(first.receipt)).toBe(true);
    expect(Object.isFrozen(first.receipt.state)).toBe(true);
  });

  it("skips false guards without consuming the scripted plan", async () => {
    const input = request([success]);
    const result = await simulateV2InactiveLocalTarget({
      ...input,
      conditionBindings: { inputs: { ready: false } },
    });

    expect(result).toMatchObject({
      ok: true,
      receipt: {
        status: "skipped",
        attempts: [],
        state: { retained: "before" },
      },
    });
  });

  it("models every explicit terminal catch outcome without state writes", async () => {
    const terminal = {
      status: "error" as const,
      code: "ADAPTER_CANCELLED",
      durationMs: 50,
      costCents: 0,
    };
    for (const [action, status, code] of [
      ["continue", "caught-continue", "ADAPTER_CANCELLED"],
      ["complete", "caught-complete", "ADAPTER_CANCELLED"],
      ["fail", "failed", "LOCAL_ADAPTER_CANCELLED"],
    ] as const) {
      const result = await simulateV2InactiveLocalTarget(
        request([terminal], { catchAction: action })
      );
      expect(result).toMatchObject({
        ok: true,
        receipt: {
          status,
          terminal: { code, catchAction: action },
          state: { retained: "before" },
        },
      });
    }
  });

  it("makes cancellation dominate approval before the first attempt", async () => {
    const input = request([success], { requireApproval: true });
    const approval = await simulateV2InactiveLocalTarget(input);
    const cancelled = await simulateV2InactiveLocalTarget({
      ...input,
      cancelBeforeAttempt: 1,
    });

    expect(approval).toMatchObject({
      ok: true,
      receipt: { status: "approval-required", attempts: [] },
    });
    expect(cancelled).toMatchObject({
      ok: true,
      receipt: { status: "cancelled", attempts: [] },
    });
  });

  it("checkpoints and deterministically resumes the same exact plan", async () => {
    const input = request([retryable, retryable, success]);
    const suspended = await simulateV2InactiveLocalTarget({
      ...input,
      maxAttemptsThisRun: 1,
    });
    expect(suspended).toMatchObject({
      ok: true,
      receipt: {
        status: "suspended",
        checkpoint: {
          nextAttempt: 2,
          cumulativeDurationMs: 110,
          cumulativeCostCents: 1,
        },
      },
    });
    if (!suspended.ok || suspended.receipt.checkpoint === undefined) {
      throw new Error("expected checkpoint");
    }

    const resumed = await simulateV2InactiveLocalTarget({
      ...input,
      resumeFrom: suspended.receipt.checkpoint,
      resumeSha256: suspended.receipt.checkpoint.checkpointSha256,
    });
    const direct = await simulateV2InactiveLocalTarget(input);
    expect(resumed).toEqual(direct);

    const drifted = await simulateV2InactiveLocalTarget({
      ...input,
      resumeFrom: {
        ...suspended.receipt.checkpoint,
        cumulativeDurationMs: 999,
      },
      resumeSha256: suspended.receipt.checkpoint.checkpointSha256,
    });
    expect(drifted).toMatchObject({
      ok: false,
      errors: [{ code: "V2_SIMULATOR_RESUME_INVALID" }],
    });
  });

  it("enforces cumulative timeout including scheduled retry backoff", async () => {
    const result = await simulateV2InactiveLocalTarget(
      request([retryable, success], { timeoutMs: 105 })
    );
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        status: "failed",
        terminal: { code: "V2_SIMULATION_TIMEOUT_EXCEEDED" },
        attempts: [
          {
            status: "retryable-error",
            cumulativeDurationMs: 100,
          },
        ],
        state: { retained: "before" },
      },
    });
    if (!result.ok) throw new Error("expected policy-stop receipt");
    expect(result.receipt.attempts[0]).not.toHaveProperty("scheduledBackoffMs");
  });

  it("rejects undeclared, unreachable, fractional-cost, and non-JSON plans", async () => {
    const base = request([success]);
    const cases: V2InactiveLocalSimulationRequest[] = [
      request([
        {
          status: "error",
          code: "UNKNOWN",
          durationMs: 1,
          costCents: 0,
        },
      ]),
      request([success, success]),
      request([{ ...success, costCents: 0.5 }]),
      { ...base, initialState: { invalid: new Date(0) } },
    ];
    for (const input of cases) {
      const result = await simulateV2InactiveLocalTarget(input);
      expect(result).toMatchObject({ ok: false });
    }
  });

  it("validates all outputs before committing any state binding", async () => {
    const initialState = { retained: "before" };
    const result = await simulateV2InactiveLocalTarget({
      ...request([
        {
          ...success,
          outputs: { result: { text: "done" }, receipt: { digest: "" } },
        },
      ]),
      initialState,
    });
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: "V2_SIMULATOR_OUTPUT_INVALID" }],
    });
    expect(initialState).toEqual({ retained: "before" });
  });
});
