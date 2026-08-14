import { describe, expect, it } from "vitest";

import {
  AI_TARIFF_SCHEMA,
  type AiTariff,
} from "../ai-economics.js";
import { reserveAiBudget } from "../ai-budget-reservation.js";

const NOW = "2026-08-14T00:00:00.000Z";

function tariff(overrides: Partial<AiTariff> = {}): AiTariff {
  return {
    schema: AI_TARIFF_SCHEMA,
    tariffId: "tariff/offer-1/2026-08",
    offerRef: "offer-1",
    modelRef: "model/example",
    modelRevision: "2026-08",
    currency: "USD",
    baseRates: {
      inputMicrosPerToken: 2,
      outputMicrosPerToken: 3,
      cachedInputMicrosPerToken: 1,
      cacheWriteMicrosPerToken: 4,
      reasoningMicrosPerToken: 5,
    },
    provenance: {
      sourceKind: "provider-published",
      authorityId: "provider/prices",
      revision: "2026-08-01",
      effectiveAt: "2026-08-01T00:00:00.000Z",
      digest: `sha256:${"a".repeat(64)}`,
    },
    ...overrides,
  };
}

function decide(input: {
  tariff?: AiTariff;
  usageCeiling?: {
    uncachedInputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  currency?: string;
  maxAmountMicros?: number;
  reservedAt?: string;
} = {}) {
  return reserveAiBudget({
    tariff: input.tariff ?? tariff(),
    usageCeiling: input.usageCeiling ?? {
      uncachedInputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 50,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
    },
    hardCeiling: {
      currency: input.currency ?? "USD",
      maxAmountMicros: input.maxAmountMicros ?? 1_000,
    },
    reservedAt: input.reservedAt ?? NOW,
  });
}

describe("conservative AI budget reservation", () => {
  it("binds the admitted amount to offer, tariff, model, and provenance", () => {
    expect(decide()).toEqual(expect.objectContaining({
      status: "admitted",
      tariffRef: "tariff/offer-1/2026-08",
      offerRef: "offer-1",
      modelRef: "model/example",
      modelRevision: "2026-08",
      currency: "USD",
      reservedAmountMicros: 375,
      provenance: expect.objectContaining({ authorityId: "provider/prices" }),
    }));
  });

  it("selects a long-context tier from total bounded input", () => {
    const decision = decide({
      tariff: tariff({
        tiers: [{
          fromInputTokens: 150,
          rates: {
            inputMicrosPerToken: 10,
            outputMicrosPerToken: 20,
            cachedInputMicrosPerToken: 5,
            cacheWriteMicrosPerToken: 7,
          },
        }],
      }),
      usageCeiling: {
        uncachedInputTokens: 100,
        cachedInputTokens: 50,
        cacheWriteTokens: 1,
        outputTokens: 2,
      },
      maxAmountMicros: 2_000,
    });
    expect(decision).toEqual(expect.objectContaining({
      status: "admitted",
      reservedAmountMicros: 1_297,
    }));
  });

  it("never interprets a missing non-zero usage-class rate as free", () => {
    expect(decide({
      tariff: tariff({
        baseRates: { inputMicrosPerToken: 2, outputMicrosPerToken: 3 },
      }),
      usageCeiling: {
        uncachedInputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 1,
      },
    })).toEqual(expect.objectContaining({
      status: "rejected",
      reason: "rate-unavailable",
    }));
  });

  it("rounds fractional micro-rates upward instead of pricing them as zero", () => {
    expect(decide({
      tariff: tariff({
        baseRates: { inputMicrosPerToken: 0.1, outputMicrosPerToken: 0 },
      }),
      usageCeiling: { uncachedInputTokens: 1, outputTokens: 0 },
    })).toEqual(expect.objectContaining({
      status: "admitted",
      reservedAmountMicros: 1,
    }));
  });

  it.each([
    ["expired tariff", { tariff: tariff({ provenance: {
      ...tariff().provenance,
      expiresAt: "2026-08-10T00:00:00.000Z",
    } }) }, "tariff-expired"],
    ["currency drift", { currency: "EUR" }, "currency-mismatch"],
    ["insufficient ceiling", { maxAmountMicros: 374 }, "ceiling-exceeded"],
    ["invalid usage bound", { usageCeiling: {
      uncachedInputTokens: -1,
      outputTokens: 0,
    } }, "usage-ceiling-invalid"],
  ] as const)("rejects %s", (_label, input, reason) => {
    expect(decide(input)).toEqual(expect.objectContaining({ status: "rejected", reason }));
  });

  it("rejects unsafe-integer reservation arithmetic", () => {
    expect(decide({
      tariff: tariff({
        baseRates: {
          inputMicrosPerToken: Number.MAX_SAFE_INTEGER,
          outputMicrosPerToken: 0,
        },
      }),
      usageCeiling: { uncachedInputTokens: 2, outputTokens: 0 },
      maxAmountMicros: Number.MAX_SAFE_INTEGER,
    })).toEqual(expect.objectContaining({
      status: "rejected",
      reason: "amount-overflow",
    }));
  });
});
