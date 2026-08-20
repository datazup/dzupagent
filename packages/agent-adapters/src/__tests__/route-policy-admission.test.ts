import { describe, expect, it } from "vitest";

import {
  admitExecutionRoutePolicy,
  RoutePolicyAdmissionError,
  type RoutePolicyAdmissionCode,
} from "../registry/route-policy-admission.js";
import { selectExecutionRouteWithReceipt } from "../registry/deterministic-candidate-selector.js";

/** A fully-populated, valid external policy in plain-JSON shape. */
function validInput(): Record<string, unknown> {
  return {
    id: "route-policy",
    requestId: "request-1",
    strategy: "rule",
    candidates: [
      {
        id: "alpha:sdk",
        provider: "codex",
        backend: "sdk",
        authMode: "api_key",
        agentHost: "goose",
        model: "codex-1",
        profileRef: "work",
        authSourceRef: "codex-subscription",
        authAvailable: true,
        backendAvailable: true,
        modelAvailable: true,
        health: {
          status: "healthy",
          checkedAt: "2026-07-12T12:00:00.000Z",
          reason: "probe ok",
        },
        costClass: "low",
        privacyClass: "provider",
        locality: "remote",
        accessClass: "subscription",
        policyCompatible: true,
        tags: ["route-weight:1"],
        capabilities: ["tools", "reasoning"],
      },
      { id: "bravo:sdk" },
    ],
    hardConstraints: [
      { kind: "capability", values: ["tools"] },
      { kind: "policy", values: [] },
    ],
    preferenceOrder: ["alpha:sdk", "bravo:sdk"],
    fallback: "ordered-compatible",
    maxSelectionLatencyMs: 25,
    originCandidateId: "alpha:sdk",
    approvedTransitions: ["identity-change", "higher-cost"],
    requirements: {
      providers: ["codex"],
      backends: ["sdk", "cli"],
      agentHosts: ["goose"],
      models: ["codex-1"],
      capabilities: ["tools"],
      profileRefs: ["work"],
      authSourceRefs: ["codex-subscription"],
      maximumCostClass: "high",
      minimumPrivacyClass: "public",
      requireHealthy: false,
    },
  };
}

function expectRejection(
  input: unknown,
  code: RoutePolicyAdmissionCode,
  path: string,
): void {
  let caught: unknown;
  try {
    admitExecutionRoutePolicy(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RoutePolicyAdmissionError);
  const admission = caught as RoutePolicyAdmissionError;
  expect(admission.name).toBe("RoutePolicyAdmissionError");
  expect(admission.code).toBe(code);
  expect(admission.path).toBe(path);
}

describe("route policy admission boundary", () => {
  it("admits a fully-populated valid policy structurally intact", () => {
    const input = validInput();
    const admitted = admitExecutionRoutePolicy(input);

    // Parse, don't cast: the admitted policy is rebuilt from validated parts,
    // never the input reference — nested collections included.
    expect(admitted).not.toBe(input);
    expect(admitted.candidates).not.toBe(input.candidates);
    expect(admitted.candidates[0]).not.toBe((input.candidates as unknown[])[0]);
    expect(admitted.preferenceOrder).not.toBe(input.preferenceOrder);
    expect(admitted.requirements).not.toBe(input.requirements);

    // And it is structurally the same policy.
    expect(admitted).toEqual(input);
  });

  it("admits a minimal policy carrying only the required fields", () => {
    const admitted = admitExecutionRoutePolicy({
      id: "p",
      requestId: "r",
      strategy: "fixed",
      candidates: [{ id: "only" }],
      hardConstraints: [],
      preferenceOrder: [],
      fallback: "none",
      maxSelectionLatencyMs: 1,
    });

    expect(admitted.candidates).toEqual([{ id: "only" }]);
    expect(admitted.originCandidateId).toBeUndefined();
    expect(admitted.approvedTransitions).toBeUndefined();
    expect(admitted.requirements).toBeUndefined();
  });

  it("feeds the deterministic selector directly after admission", () => {
    const receipt = selectExecutionRouteWithReceipt(
      admitExecutionRoutePolicy(validInput()),
      { decidedAt: "2026-07-12T12:00:00.000Z" },
    );
    expect(receipt.decision.selectedCandidateId).toBe("alpha:sdk");
  });

  it.each([
    [null, "policy"],
    ["policy", "policy"],
    [42, "policy"],
    [["not", "an", "object"], "policy"],
  ] as const)("rejects non-object input %#", (input, path) => {
    expectRejection(input, "ROUTE_POLICY_NOT_AN_OBJECT", path);
  });

  it.each([
    {
      name: "an unknown top-level key",
      mutate: (input: Record<string, unknown>) => {
        input.extra = true;
      },
      code: "ROUTE_POLICY_UNKNOWN_KEY",
      path: "policy.extra",
    },
    {
      name: "an unknown candidate key",
      mutate: (input: Record<string, unknown>) => {
        (input.candidates as Record<string, unknown>[])[1]!.weight = 3;
      },
      code: "ROUTE_POLICY_UNKNOWN_KEY",
      path: "candidates[1].weight",
    },
    {
      name: "an unknown health key",
      mutate: (input: Record<string, unknown>) => {
        (
          (input.candidates as Record<string, unknown>[])[0]!.health as Record<
            string,
            unknown
          >
        ).latencyMs = 12;
      },
      code: "ROUTE_POLICY_UNKNOWN_KEY",
      path: "candidates[0].health.latencyMs",
    },
    {
      name: "an unknown requirements key",
      mutate: (input: Record<string, unknown>) => {
        (input.requirements as Record<string, unknown>).regions = ["eu"];
      },
      code: "ROUTE_POLICY_UNKNOWN_KEY",
      path: "requirements.regions",
    },
    {
      name: "a missing id",
      mutate: (input: Record<string, unknown>) => {
        delete input.id;
      },
      code: "ROUTE_POLICY_INVALID_ID",
      path: "id",
    },
    {
      name: "an empty id",
      mutate: (input: Record<string, unknown>) => {
        input.id = "";
      },
      code: "ROUTE_POLICY_INVALID_ID",
      path: "id",
    },
    {
      name: "a non-string requestId",
      mutate: (input: Record<string, unknown>) => {
        input.requestId = 7;
      },
      code: "ROUTE_POLICY_INVALID_REQUEST_ID",
      path: "requestId",
    },
    {
      name: "an unknown strategy",
      mutate: (input: Record<string, unknown>) => {
        input.strategy = "random";
      },
      code: "ROUTE_POLICY_INVALID_STRATEGY",
      path: "strategy",
    },
    {
      name: "candidates that are not an array",
      mutate: (input: Record<string, unknown>) => {
        input.candidates = { id: "alpha:sdk" };
      },
      code: "ROUTE_POLICY_INVALID_CANDIDATES",
      path: "candidates",
    },
    {
      name: "a candidate without an id",
      mutate: (input: Record<string, unknown>) => {
        delete (input.candidates as Record<string, unknown>[])[1]!.id;
      },
      code: "ROUTE_POLICY_INVALID_CANDIDATE_ID",
      path: "candidates[1].id",
    },
    {
      name: "a candidate that is not an object",
      mutate: (input: Record<string, unknown>) => {
        (input.candidates as unknown[])[1] = "bravo:sdk";
      },
      code: "ROUTE_POLICY_INVALID_CANDIDATE_FIELD",
      path: "candidates[1]",
    },
    {
      name: "a stringly-typed candidate boolean",
      mutate: (input: Record<string, unknown>) => {
        (input.candidates as Record<string, unknown>[])[0]!.authAvailable =
          "true";
      },
      code: "ROUTE_POLICY_INVALID_CANDIDATE_FIELD",
      path: "candidates[0].authAvailable",
    },
    {
      name: "an out-of-vocabulary cost class",
      mutate: (input: Record<string, unknown>) => {
        (input.candidates as Record<string, unknown>[])[0]!.costClass = "cheap";
      },
      code: "ROUTE_POLICY_INVALID_CANDIDATE_FIELD",
      path: "candidates[0].costClass",
    },
    {
      name: "an out-of-vocabulary health status",
      mutate: (input: Record<string, unknown>) => {
        (
          (input.candidates as Record<string, unknown>[])[0]!.health as Record<
            string,
            unknown
          >
        ).status = "ok";
      },
      code: "ROUTE_POLICY_INVALID_CANDIDATE_FIELD",
      path: "candidates[0].health.status",
    },
    {
      name: "a non-string tag",
      mutate: (input: Record<string, unknown>) => {
        (input.candidates as Record<string, unknown>[])[0]!.tags = [
          "route-weight:1",
          3,
        ];
      },
      code: "ROUTE_POLICY_INVALID_CANDIDATE_FIELD",
      path: "candidates[0].tags[1]",
    },
    {
      name: "hard constraints that are not an array",
      mutate: (input: Record<string, unknown>) => {
        input.hardConstraints = null;
      },
      code: "ROUTE_POLICY_INVALID_HARD_CONSTRAINTS",
      path: "hardConstraints",
    },
    {
      name: "a hard constraint with an unknown kind",
      mutate: (input: Record<string, unknown>) => {
        (input.hardConstraints as Record<string, unknown>[])[0]!.kind =
          "region";
      },
      code: "ROUTE_POLICY_INVALID_HARD_CONSTRAINT",
      path: "hardConstraints[0].kind",
    },
    {
      name: "a hard constraint with non-string values",
      mutate: (input: Record<string, unknown>) => {
        (input.hardConstraints as Record<string, unknown>[])[0]!.values = [1];
      },
      code: "ROUTE_POLICY_INVALID_HARD_CONSTRAINT",
      path: "hardConstraints[0].values[0]",
    },
    {
      name: "a non-array preference order",
      mutate: (input: Record<string, unknown>) => {
        input.preferenceOrder = "alpha:sdk";
      },
      code: "ROUTE_POLICY_INVALID_PREFERENCE_ORDER",
      path: "preferenceOrder",
    },
    {
      name: "an unknown fallback mode",
      mutate: (input: Record<string, unknown>) => {
        input.fallback = "retry";
      },
      code: "ROUTE_POLICY_INVALID_FALLBACK",
      path: "fallback",
    },
    {
      name: "an empty origin candidate id",
      mutate: (input: Record<string, unknown>) => {
        input.originCandidateId = "";
      },
      code: "ROUTE_POLICY_INVALID_ORIGIN_CANDIDATE_ID",
      path: "originCandidateId",
    },
    {
      name: "an unknown approved transition",
      mutate: (input: Record<string, unknown>) => {
        input.approvedTransitions = ["identity-change", "teleport"];
      },
      code: "ROUTE_POLICY_INVALID_APPROVED_TRANSITIONS",
      path: "approvedTransitions[1]",
    },
    {
      name: "requirements that are not an object",
      mutate: (input: Record<string, unknown>) => {
        input.requirements = [];
      },
      code: "ROUTE_POLICY_INVALID_REQUIREMENTS",
      path: "requirements",
    },
    {
      name: "an out-of-vocabulary requirements backend",
      mutate: (input: Record<string, unknown>) => {
        (input.requirements as Record<string, unknown>).backends = [
          "sdk",
          "carrier-pigeon",
        ];
      },
      code: "ROUTE_POLICY_INVALID_REQUIREMENTS_FIELD",
      path: "requirements.backends[1]",
    },
    {
      name: "a stringly-typed requireHealthy",
      mutate: (input: Record<string, unknown>) => {
        (input.requirements as Record<string, unknown>).requireHealthy = "yes";
      },
      code: "ROUTE_POLICY_INVALID_REQUIREMENTS_FIELD",
      path: "requirements.requireHealthy",
    },
  ] as const)("rejects $name", ({ mutate, code, path }) => {
    const input = validInput();
    mutate(input);
    expectRejection(input, code, path);
  });

  // Every case here is a value JavaScript would happily coerce; the boundary
  // must parse, never coerce, so each one fails closed with the latency code.
  it.each([
    ["a numeric string", "25"],
    ["a float", 2.5],
    ["zero", 0],
    ["a negative number", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a boolean", true],
    ["null", null],
    ["undefined (missing)", undefined],
  ] as const)(
    "rejects %s as maxSelectionLatencyMs without coercing",
    (_name, latency) => {
      const input = validInput();
      if (latency === undefined) {
        delete input.maxSelectionLatencyMs;
      } else {
        input.maxSelectionLatencyMs = latency;
      }
      expectRejection(
        input,
        "ROUTE_POLICY_INVALID_MAX_SELECTION_LATENCY",
        "maxSelectionLatencyMs",
      );
    },
  );

  it("admits nothing partially: one bad candidate rejects the whole policy", () => {
    const input = validInput();
    (input.candidates as Record<string, unknown>[]).push({ id: "" });

    // The valid candidates must not survive into any output — admission is
    // all-or-nothing, so the only observable outcome is the thrown rejection.
    expectRejection(
      input,
      "ROUTE_POLICY_INVALID_CANDIDATE_ID",
      "candidates[2].id",
    );
  });

  it("caps unbounded external strings instead of admitting them", () => {
    const input = validInput();
    input.id = "x".repeat(1001);
    expectRejection(input, "ROUTE_POLICY_INVALID_ID", "id");
  });
});
