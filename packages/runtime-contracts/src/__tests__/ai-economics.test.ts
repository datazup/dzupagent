import { describe, expect, it } from "vitest";
import {
  AI_QUOTA_SCHEMA,
  AI_TARIFF_SCHEMA,
  MICROS_PER_CENT,
  selectTariffRates,
  validateAiQuotaTruth,
  validateAiTariff,
  type AiPriceProvenance,
  type AiTariff,
} from "../ai-economics.js";

const provenance: AiPriceProvenance = {
  sourceKind: "hand-maintained",
  authorityId: "dzupagent.core/model-rates",
  revision: "ARCH-M-08",
  effectiveAt: "2026-08-01T00:00:00.000Z",
  digest: `sha256:${"a".repeat(64)}`,
};

function tariff(overrides: Partial<AiTariff> = {}): AiTariff {
  return {
    schema: AI_TARIFF_SCHEMA,
    tariffId: "anthropic/opus-5",
    offerRef: "anthropic/opus-5/api",
    modelRef: "model/claude-opus-5",
    modelRevision: "2026-08-01",
    currency: "USD",
    baseRates: { inputMicrosPerToken: 110, outputMicrosPerToken: 440 },
    provenance,
    ...overrides,
  };
}

const codes = (diagnostics: readonly { code: string }[]) =>
  diagnostics.map((diagnostic) => diagnostic.code);

describe("AiTariff", () => {
  it("accepts a minimal well-formed tariff", () => {
    expect(validateAiTariff(tariff())).toEqual([]);
  });

  it("requires an ISO-style currency", () => {
    expect(codes(validateAiTariff(tariff({ currency: "dollars" })))).toContain(
      "AI_TARIFF_INVALID"
    );
  });

  it("rejects a negative rate but allows a free (zero) rate", () => {
    expect(
      codes(
        validateAiTariff(
          tariff({
            baseRates: { inputMicrosPerToken: -1, outputMicrosPerToken: 440 },
          })
        )
      )
    ).toContain("AI_TARIFF_INVALID");
    expect(
      validateAiTariff(
        tariff({
          baseRates: { inputMicrosPerToken: 0, outputMicrosPerToken: 0 },
        })
      )
    ).toEqual([]);
  });

  // Required case: cached input and cache-write tariff.
  it("prices cached input and cache writes separately from base input", () => {
    const cached = tariff({
      baseRates: {
        inputMicrosPerToken: 110,
        outputMicrosPerToken: 440,
        cachedInputMicrosPerToken: 11,
        cacheWriteMicrosPerToken: 137,
      },
    });
    expect(validateAiTariff(cached)).toEqual([]);
    expect(cached.baseRates.cachedInputMicrosPerToken).not.toBe(
      cached.baseRates.inputMicrosPerToken
    );
  });

  // Required case: long-context / tiered tariff.
  it("selects the highest tier whose input-token bound is met", () => {
    const tiered = tariff({
      tiers: [
        {
          fromInputTokens: 200_000,
          rates: { inputMicrosPerToken: 220, outputMicrosPerToken: 880 },
        },
        {
          fromInputTokens: 1_000_000,
          rates: { inputMicrosPerToken: 330, outputMicrosPerToken: 1_320 },
        },
      ],
    });
    expect(validateAiTariff(tiered)).toEqual([]);
    expect(selectTariffRates(tiered, 1_000).inputMicrosPerToken).toBe(110);
    expect(selectTariffRates(tiered, 200_000).inputMicrosPerToken).toBe(220);
    expect(selectTariffRates(tiered, 999_999).inputMicrosPerToken).toBe(220);
    expect(selectTariffRates(tiered, 2_000_000).inputMicrosPerToken).toBe(330);
  });

  it("rejects tiers that do not ascend strictly", () => {
    const unsorted = tariff({
      tiers: [
        {
          fromInputTokens: 1_000_000,
          rates: { inputMicrosPerToken: 330, outputMicrosPerToken: 1_320 },
        },
        {
          fromInputTokens: 200_000,
          rates: { inputMicrosPerToken: 220, outputMicrosPerToken: 880 },
        },
      ],
    });
    expect(codes(validateAiTariff(unsorted))).toContain("AI_TARIFF_TIER_ORDER");
  });

  // Required case: stale / expired tariff.
  it("reports expiry distinctly from malformation, and only when evaluated", () => {
    const expiring = tariff({
      provenance: { ...provenance, expiresAt: "2026-08-02T00:00:00.000Z" },
    });
    expect(validateAiTariff(expiring)).toEqual([]);
    expect(
      codes(validateAiTariff(expiring, { at: "2026-08-04T00:00:00.000Z" }))
    ).toEqual(["AI_TARIFF_EXPIRED"]);
    expect(
      validateAiTariff(expiring, { at: "2026-08-01T12:00:00.000Z" })
    ).toEqual([]);
  });

  it("requires provenance identifying the authority and revision", () => {
    expect(
      codes(
        validateAiTariff(
          tariff({
            provenance: { ...provenance, authorityId: "" },
          })
        )
      )
    ).toContain("AI_PRICE_PROVENANCE_INVALID");
  });

  it("rejects an expiry that precedes the effective time", () => {
    expect(
      codes(
        validateAiTariff(
          tariff({
            provenance: {
              ...provenance,
              expiresAt: "2026-07-01T00:00:00.000Z",
            },
          })
        )
      )
    ).toContain("AI_PRICE_PROVENANCE_INVALID");
  });

  // Guards the ARCH-M-08 divergence C0 found: provenance must distinguish two
  // tables holding different numbers for the same model.
  it("distinguishes two authorities pricing the same model differently", () => {
    const handMaintained = tariff();
    const adapterTable = tariff({
      baseRates: { inputMicrosPerToken: 125, outputMicrosPerToken: 500 },
      provenance: {
        sourceKind: "hand-maintained",
        authorityId: "dzupagent.agent-adapters/cost-models",
        revision: "2026-08-01",
        effectiveAt: "2026-08-01T00:00:00.000Z",
        digest: `sha256:${"b".repeat(64)}`,
      },
    });
    expect(validateAiTariff(handMaintained)).toEqual([]);
    expect(validateAiTariff(adapterTable)).toEqual([]);
    expect(handMaintained.provenance.authorityId).not.toBe(
      adapterTable.provenance.authorityId
    );
    expect(handMaintained.baseRates.inputMicrosPerToken).not.toBe(
      adapterTable.baseRates.inputMicrosPerToken
    );
  });
});

describe("AiQuotaTruth", () => {
  it("accepts consumption reported without a disclosed ceiling", () => {
    expect(
      validateAiQuotaTruth({
        schema: AI_QUOTA_SCHEMA,
        unit: "requests",
        consumed: 1,
        observedAt: "2026-08-04T00:00:00.000Z",
      })
    ).toEqual([]);
  });

  it("rejects a remaining value greater than the limit", () => {
    expect(
      codes(
        validateAiQuotaTruth({
          schema: AI_QUOTA_SCHEMA,
          unit: "credits",
          consumed: 5,
          limit: 10,
          remaining: 11,
          observedAt: "2026-08-04T00:00:00.000Z",
        })
      )
    ).toContain("AI_QUOTA_INVALID");
  });

  it("rejects an unrecognised unit and a negative consumption", () => {
    expect(
      codes(
        validateAiQuotaTruth({
          schema: AI_QUOTA_SCHEMA,
          unit: "bananas",
          consumed: -1,
          observedAt: "2026-08-04T00:00:00.000Z",
        })
      )
    ).toEqual(["AI_QUOTA_INVALID", "AI_QUOTA_INVALID"]);
  });

  it("requires an observation time", () => {
    expect(
      codes(
        validateAiQuotaTruth({
          schema: AI_QUOTA_SCHEMA,
          unit: "tokens",
          consumed: 10,
        })
      )
    ).toContain("AI_QUOTA_INVALID");
  });
});

describe("micro-unit convention", () => {
  it("converts cents to micros at the documented factor", () => {
    expect(MICROS_PER_CENT).toBe(10_000);
    expect(1.25 * MICROS_PER_CENT).toBe(12_500);
  });
});
