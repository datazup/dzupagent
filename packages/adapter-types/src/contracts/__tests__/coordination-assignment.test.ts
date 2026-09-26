import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  CoordinationAttemptExecutionPlan,
  CoordinationAttemptExecutionPlanResult,
  CoordinationAuthReference,
  CoordinationExecutionAssignmentView,
  CoordinationExecutionBinding,
  CoordinationPlanContextFact,
  CoordinationPlanContextItem,
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
    expectTypeOf<CoordinationExecutionBinding["schema"]>().toEqualTypeOf<
      "dzupagent.coordinationExecutionBinding/v2" | "dzupagent.coordinationExecutionBinding/v3"
    >();
    // MVP-07-CP04: v3 pins its digests, required and with no default.
    type V3 = Extract<CoordinationExecutionBinding, { schema: "dzupagent.coordinationExecutionBinding/v3" }>;
    expectTypeOf<Required<V3>>().toEqualTypeOf<keyof V3>();
    expectTypeOf<keyof V3["digests"]>().toEqualTypeOf<"binary" | "profile" | "catalog" | "capability" | "tariff">();
    expectTypeOf<CoordinationExecutionBinding["providerId"]>().toEqualTypeOf<string>();
    expectTypeOf<CoordinationExecutionBinding["backend"]>().toEqualTypeOf<
      "cli" | "local-model" | "sdk" | "api" | "remote"
    >();
    expectTypeOf<CoordinationExecutionBinding["agentHost"]>().toEqualTypeOf<string | null>();
    expectTypeOf<CoordinationAuthReference["mode"]>().toEqualTypeOf<"subscription_cli" | "api_key">();
  });

  it("gives each binding fact exactly one execution plan field", () => {
    const fields: Record<keyof CoordinationPlanExecutionFact, true> = {
      provenance: true,
      providerId: true,
      backend: true,
      agentHost: true,
      backendId: true,
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
      bindingDigests: true,
    };
    expect(Object.keys(fields)).toHaveLength(17);
    expectTypeOf<CoordinationPlanExecutionFact["providerId"]>().toEqualTypeOf<"codex" | "claude">();
    expectTypeOf<CoordinationPlanExecutionFact["backend"]>().toEqualTypeOf<"cli" | "sdk">();
    expectTypeOf<CoordinationPlanExecutionFact>().not.toHaveProperty("approvedFallbackProviders");
    expectTypeOf<CoordinationPlanExecutionFact>().not.toHaveProperty("secret");
  });

  it("carries a content-addressed context pack with both omission receipts", () => {
    expectTypeOf<CoordinationAttemptExecutionPlan["schema"]>().toEqualTypeOf<
      "dzupagent.coordinationAttemptExecutionPlan/v3"
    >();
    expectTypeOf<CoordinationPlanContextItem["freshness"]>().toEqualTypeOf<"current" | "admitted-stale">();
    expectTypeOf<CoordinationPlanContextItem["required"]>().toEqualTypeOf<boolean>();
    expectTypeOf<CoordinationPlanContextFact["omittedRoles"][number]["evidenceRef"]>().toEqualTypeOf<string>();
    expectTypeOf<CoordinationPlanContextFact["receiverOmissions"][number]["reasonCode"]>().toEqualTypeOf<
      "OBJECT_UNAVAILABLE" | "FRESHNESS_UNKNOWN"
    >();
    expectTypeOf<CoordinationPlanContextFact["packDigest"]>().toEqualTypeOf<`sha256:${string}`>();
    expectTypeOf<AdapterTypes.CoordinationPlanReceiverOmission>().toEqualTypeOf<
      CoordinationPlanContextFact["receiverOmissions"][number]
    >();
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
