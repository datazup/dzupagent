import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  CoordinationAttemptExecutionPlan,
  CoordinationAttemptExecutionPlanResult,
  CoordinationAuthReference,
  CoordinationExecutionAssignmentView,
  CoordinationExecutionBinding,
  CoordinationPlanExecutionFact,
} from "../coordination-assignment.js";
import type * as AdapterTypes from "../../index.js";

describe("coordination assignment contracts", () => {
  it("exports the consumer types from the package root", () => {
    expectTypeOf<AdapterTypes.CoordinationExecutionBinding>().toEqualTypeOf<CoordinationExecutionBinding>();
    expectTypeOf<AdapterTypes.CoordinationAttemptExecutionPlan>().toEqualTypeOf<CoordinationAttemptExecutionPlan>();
  });

  it("pins the accepted wire schema", () => {
    expectTypeOf<CoordinationExecutionAssignmentView["schema"]>().toEqualTypeOf<
      "datazup.coordination.execution-assignment/v2"
    >();
  });

  it("keeps provider facts out of the assignment view", () => {
    type ProviderFact = "providerId" | "backend" | "model" | "profileRef" | "authMode" | "tariffRef" | "reasoning";
    expectTypeOf<Extract<keyof CoordinationExecutionAssignmentView, ProviderFact>>().toBeNever();
  });

  it("requires every binding fact, with no optional provider fact", () => {
    type Required<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T];
    expectTypeOf<Required<CoordinationExecutionBinding>>().toEqualTypeOf<keyof CoordinationExecutionBinding>();
    expectTypeOf<CoordinationExecutionBinding["providerId"]>().toEqualTypeOf<"codex" | "claude">();
    expectTypeOf<CoordinationExecutionBinding["backend"]>().toEqualTypeOf<"cli" | "sdk">();
    expectTypeOf<CoordinationAuthReference["mode"]>().toEqualTypeOf<"subscription_cli" | "api_key">();
  });

  it("gives each binding fact exactly one execution plan field", () => {
    const fields: Record<keyof CoordinationPlanExecutionFact, true> = {
      provenance: true,
      providerId: true,
      backend: true,
      model: true,
      profileRef: true,
      authMode: true,
      authSourceRef: true,
      capabilityDescriptorId: true,
      nativeCapabilities: true,
      hostEffects: true,
      tariffRef: true,
      sessionRef: true,
      reasoning: true,
      reasoningCatalogFingerprint: true,
    };
    expect(Object.keys(fields)).toHaveLength(14);
    expectTypeOf<CoordinationPlanExecutionFact>().not.toHaveProperty("approvedFallbackProviders");
    expectTypeOf<CoordinationPlanExecutionFact>().not.toHaveProperty("secret");
  });

  it("returns a plan or refusals, never both", () => {
    const refused: CoordinationAttemptExecutionPlanResult = {
      ok: false,
      refusals: [{ code: "COORD_BINDING_FACT_MISSING", path: "$binding.model", message: "missing" }],
    };
    expect(refused.ok).toBe(false);
    expectTypeOf<Extract<CoordinationAttemptExecutionPlanResult, { ok: true }>>().not.toHaveProperty("refusals");
    // @ts-expect-error a refusal result carries no plan
    const invalid: CoordinationAttemptExecutionPlanResult = { ok: false, refusals: [], plan: {} };
    expect(invalid).toBeDefined();
  });
});
