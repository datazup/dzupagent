import { describe, expect, it } from "vitest";

import type { ExecutionResult } from "../canonical-execution.js";
import {
  AI_EXECUTION_BINDING_SCHEMA,
  AI_EXECUTION_OFFER_SCHEMA,
  AI_EXECUTION_RECEIPT_V2_SCHEMA,
  AI_RESOLVED_TARGET_SCHEMA,
  validateAiExecutionReceipt,
  type AiExecutionReceiptV2,
  type AiModelIdentity,
} from "../ai-execution.js";
import {
  materializeAiExecutionBinding,
  materializeAiExecutionOfferSnapshot,
  materializeAiResolvedTargetSnapshot,
  materializeAiRouteDecisionBinding,
  validateAiExecutionReceiptCustody,
} from "../ai-execution-node.js";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const TARIFF_REF = "tariff/model-default/2026-08";

const target = materializeAiResolvedTargetSnapshot({
  schema: AI_RESOLVED_TARGET_SCHEMA,
  targetId: "docs.summary.default",
  targetRevision: "target-revision-1",
  policyRevision: "policy-revision-1",
  operation: "text.generate",
  placement: "server",
  executionStyle: "inline",
  routeCandidateId: "model-default",
  backend: "sdk",
  provider: "provider",
  model: "provider-model-1",
  resolvedAt: "2026-08-14T00:00:00.000Z",
});

const model: AiModelIdentity = {
  modelRef: "model/summary",
  revision: "2026-08-01",
  providerModelId: "provider-model-1",
  catalogDigest: digest("a"),
};

const offer = materializeAiExecutionOfferSnapshot({
  schema: AI_EXECUTION_OFFER_SCHEMA,
  offerId: "model-default",
  offerRevision: "offer-revision-1",
  model,
  provider: "provider",
  backend: "sdk",
  locality: "remote",
  privacyClass: "provider",
  capabilities: ["text/v1"],
  cacheBehavior: "provider",
  sessionBehavior: "stateless",
  tariffRef: TARIFF_REF,
  health: { status: "healthy", checkedAt: "2026-08-14T00:00:00.000Z" },
  effectiveAt: "2026-08-01T00:00:00.000Z",
  catalogDigest: digest("b"),
});

const result = {
  schema: "dzupagent.executionResult/v1",
  requestId: "request-1",
  correlationId: "correlation-1",
  routeDecision: {
    id: "decision-1",
    policyId: "policy-1",
    requestId: "request-1",
    eligibleCandidateIds: ["model-default"],
    rejected: [],
    selectedCandidateId: "model-default",
    fallbackCandidateIds: [],
    strategy: "fixed",
    decidedAt: "2026-08-14T00:00:00.000Z",
  },
  evidence: [],
  artifacts: [],
  status: "succeeded",
  output: "summary",
} satisfies ExecutionResult;

const binding = materializeAiExecutionBinding({
  schema: AI_EXECUTION_BINDING_SCHEMA,
  routeDecision: materializeAiRouteDecisionBinding(result.routeDecision),
  offer,
  target,
  prompt: {
    blueprintRef: "prompt/summary",
    blueprintRevision: "3",
    blueprintDigest: digest("c"),
    renderedPayloadDigest: digest("d"),
  },
  persona: {
    status: "bound",
    personaId: "persona/researcher",
    revision: "2",
    digest: digest("e"),
  },
  model,
});

const charge = {
  attempt: 1,
  offerRef: offer.offerId,
  tariffRef: TARIFF_REF,
  amountMicros: 25,
  provenance: {
    sourceKind: "provider-published" as const,
    authorityId: "provider/prices",
    revision: "2026-08-01",
    effectiveAt: "2026-08-01T00:00:00.000Z",
    digest: digest("f"),
  },
};

const usage = {
  measurement: "known" as const,
  tokens: { input: 10, output: 5 },
  cost: {
    status: "reconciled" as const,
    currency: "USD",
    amountMicros: 25,
    charges: [charge],
  },
};

const receipt = {
  schema: AI_EXECUTION_RECEIPT_V2_SCHEMA,
  requestId: "request-1",
  correlationId: "correlation-1",
  operation: "text.generate",
  requestedTarget: { kind: "target-id", targetId: "docs.summary.default" },
  binding,
  target,
  attempts: [{
    attempt: 1,
    binding,
    target,
    dispatch: { status: "terminal" },
    usage,
    startedAt: "2026-08-14T00:00:00.000Z",
    completedAt: "2026-08-14T00:00:01.000Z",
  }],
  result,
  usage,
  terminalEventSequence: 3,
  completedAt: "2026-08-14T00:00:01.000Z",
} satisfies AiExecutionReceiptV2;

describe("V2 AI execution receipt bindings", () => {
  it("binds route, offer, target, tariff, prompt, payload, persona, and model", () => {
    expect(validateAiExecutionReceipt(receipt)).toEqual({ valid: true, diagnostics: [] });
    expect(validateAiExecutionReceiptCustody(receipt)).toEqual({ valid: true, diagnostics: [] });
  });

  it("keeps legacy V1 readable but requires charge attribution for V2", () => {
    const missing = {
      ...receipt,
      usage: { ...usage, cost: { ...usage.cost, charges: undefined } },
      attempts: [{
        ...receipt.attempts[0],
        usage: { ...usage, cost: { ...usage.cost, charges: undefined } },
      }],
    } as unknown as AiExecutionReceiptV2;
    expect(validateAiExecutionReceipt(missing).diagnostics).toContainEqual(
      expect.objectContaining({ code: "AI_USAGE_TRUTH_INVALID", path: "usage.cost.charges" }),
    );
  });

  it.each([
    ["offer", {
      ...binding,
      offer: { ...offer, offerRevision: "tampered" },
    }],
    ["prompt", {
      ...binding,
      prompt: { ...binding.prompt, blueprintRevision: "tampered" },
    }],
    ["target", {
      ...binding,
      target: { ...target, targetRevision: "tampered" },
    }],
    ["persona", {
      ...binding,
      persona: { ...binding.persona, revision: "tampered" },
    }],
    ["model", {
      ...binding,
      model: { ...binding.model, revision: "tampered" },
    }],
  ] as const)("rejects a tampered %s binding", (_label, tampered) => {
    const invalid = {
      ...receipt,
      binding: tampered,
      attempts: [{ ...receipt.attempts[0], binding: tampered }],
    } as unknown as AiExecutionReceiptV2;
    expect(validateAiExecutionReceiptCustody(invalid).valid).toBe(false);
  });

  it("rejects tariff attribution that differs from the admitted offer", () => {
    const invalidUsage = {
      ...usage,
      cost: {
        ...usage.cost,
        charges: [{ ...charge, tariffRef: "tariff/other" }],
      },
    };
    const invalid = {
      ...receipt,
      usage: invalidUsage,
      attempts: [{ ...receipt.attempts[0], usage: invalidUsage }],
    } as unknown as AiExecutionReceiptV2;
    expect(validateAiExecutionReceipt(invalid).diagnostics).toContainEqual(
      expect.objectContaining({ code: "AI_CHARGE_BINDING_MISMATCH" }),
    );
  });

  it("rejects a route decision changed after its binding was materialized", () => {
    const invalid = {
      ...receipt,
      result: {
        ...result,
        routeDecision: { ...result.routeDecision, decidedAt: "2026-08-14T00:00:00.500Z" },
      },
    } as unknown as AiExecutionReceiptV2;
    expect(validateAiExecutionReceiptCustody(invalid).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "AI_EXECUTION_BINDING_INVALID",
        path: "binding.routeDecision.decisionDigest",
      }),
    );
  });

  it("rejects a final binding that differs from the last attempt", () => {
    const { bindingDigest: _bindingDigest, ...bindingInput } = binding;
    const changed = materializeAiExecutionBinding({
      ...bindingInput,
      prompt: { ...binding.prompt, renderedPayloadDigest: digest("0") },
    });
    const invalid = { ...receipt, binding: changed } as unknown as AiExecutionReceiptV2;
    expect(validateAiExecutionReceipt(invalid).diagnostics).toContainEqual(
      expect.objectContaining({ code: "AI_EXECUTION_BINDING_MISMATCH" }),
    );
  });
});
