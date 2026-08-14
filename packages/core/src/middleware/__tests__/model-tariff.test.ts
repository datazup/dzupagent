import { describe, expect, it } from "vitest";

import {
  selectTariffRates,
  validateAiTariff,
  type AiTariff,
} from "@dzupagent/runtime-contracts";

import {
  MODEL_RATES_AUTHORITY_ID,
  MODEL_RATES_EFFECTIVE_AT,
  MODEL_RATES_REVISION,
  PROVIDER_RATE_TABLE,
  getModelRate,
  hasKnownModelRate,
} from "../model-rates.js";
import {
  buildKnownModelTariff as buildKnownModelTariffContract,
  buildModelTariff as buildModelTariffContract,
  centsPer1MToMicrosPerToken,
  modelRatesProvenance,
  toAiTokenRates,
} from "../model-tariff.js";

const bindingFor = (id: string) => ({
  offerRef: `offer/${id}`,
  modelRef: `model/${id}`,
  modelRevision: "catalog-2026-08",
});

const buildModelTariff = (id: string) =>
  buildModelTariffContract(id, bindingFor(id));

const buildKnownModelTariff = (id: string) =>
  buildKnownModelTariffContract(id, bindingFor(id));

describe("centsPer1MToMicrosPerToken", () => {
  it("converts cents per 1M tokens to micros per token", () => {
    // 300 cents/1M = $0.03/1M... = 3 micros/token (1 cent = 10_000 micros).
    expect(centsPer1MToMicrosPerToken(300)).toBe(3);
    expect(centsPer1MToMicrosPerToken(1500)).toBe(15);
  });

  it("preserves sub-integer rates instead of rounding them to zero", () => {
    // Gemini is 10 cents/1M. Rounding to an integer would price it at 0 and
    // bill real traffic as free.
    expect(centsPer1MToMicrosPerToken(10)).toBeCloseTo(0.1, 10);
    expect(centsPer1MToMicrosPerToken(10)).toBeGreaterThan(0);
  });

  it("maps a zero rate to zero", () => {
    expect(centsPer1MToMicrosPerToken(0)).toBe(0);
  });
});

describe("toAiTokenRates", () => {
  it("omits cache tiers the rate does not declare", () => {
    const rates = toAiTokenRates({
      inputCentsPer1M: 100,
      outputCentsPer1M: 200,
    });
    expect(rates).toEqual({
      inputMicrosPerToken: 1,
      outputMicrosPerToken: 2,
    });
    expect("cachedInputMicrosPerToken" in rates).toBe(false);
    expect("cacheWriteMicrosPerToken" in rates).toBe(false);
  });

  it("converts declared cache tiers", () => {
    const rates = toAiTokenRates({
      inputCentsPer1M: 300,
      outputCentsPer1M: 1500,
      cachedInputCentsPer1M: 30,
      cacheWriteCentsPer1M: 375,
    });
    expect(rates.cachedInputMicrosPerToken).toBeCloseTo(0.3, 10);
    expect(rates.cacheWriteMicrosPerToken).toBeCloseTo(3.75, 10);
  });
});

describe("modelRatesProvenance", () => {
  it("pins the authority and revision the rates came from", () => {
    expect(modelRatesProvenance()).toEqual({
      sourceKind: "hand-maintained",
      authorityId: MODEL_RATES_AUTHORITY_ID,
      revision: MODEL_RATES_REVISION,
      effectiveAt: MODEL_RATES_EFFECTIVE_AT,
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it("exposes a machine-comparable effectiveAt", () => {
    // Reconciliation orders two disagreeing tables by this value, so it must
    // parse as an instant rather than read as prose.
    expect(Number.isNaN(Date.parse(MODEL_RATES_EFFECTIVE_AT))).toBe(false);
  });
});

describe("buildModelTariff", () => {
  it("produces a tariff the contract validator accepts", () => {
    const tariff = buildModelTariff("claude-sonnet-4-6");
    expect(validateAiTariff(tariff)).toEqual([]);
  });

  it("prices a concrete model from its own base rates", () => {
    const tariff = buildModelTariff("claude-sonnet-4-6");
    expect(tariff.baseRates.inputMicrosPerToken).toBe(3);
    expect(tariff.baseRates.outputMicrosPerToken).toBe(15);
  });

  it("carries the cache tiers a concrete model inherits from its family", () => {
    // The concrete entry declares no cache tiers; getModelRate inherits them
    // from `claude`. If that inheritance regressed, cached traffic would be
    // billed at the uncached rate.
    const tariff = buildModelTariff("claude-sonnet-4-6");
    expect(tariff.baseRates.cachedInputMicrosPerToken).toBeCloseTo(0.3, 10);
    expect(tariff.baseRates.cacheWriteMicrosPerToken).toBeCloseTo(3.75, 10);
  });

  it("prices a provider family key", () => {
    const tariff = buildModelTariff("gemini");
    expect(validateAiTariff(tariff)).toEqual([]);
    expect(tariff.baseRates.inputMicrosPerToken).toBeCloseTo(0.1, 10);
  });

  it("requires the caller's exact offer and model catalog identity", () => {
    const tariff = buildModelTariffContract("claude-sonnet-4-6", {
      offerRef: "offer/anthropic/sonnet/api",
      modelRef: "model/claude-sonnet-4-6",
      modelRevision: "catalog-42",
    });
    expect(tariff).toMatchObject({
      offerRef: "offer/anthropic/sonnet/api",
      modelRef: "model/claude-sonnet-4-6",
      modelRevision: "catalog-42",
    });
  });

  it("falls back to the default rate for an unknown model", () => {
    const tariff = buildModelTariff("no-such-model-xyz");
    expect(validateAiTariff(tariff)).toEqual([]);
    expect(tariff.baseRates.inputMicrosPerToken).toBe(2);
  });

  it("pins the revision into the tariff id so two revisions never collide", () => {
    const tariff = buildModelTariff("gpt-5");
    expect(tariff.tariffId).toBe(
      `${MODEL_RATES_AUTHORITY_ID}@${MODEL_RATES_REVISION}:offer/gpt-5`
    );
  });

  it("never disagrees with the canonical table it projects", () => {
    // Guards the ARCH-M-08 failure mode: a second pricing authority drifting
    // from model-rates. Every family key must project its own table entry.
    for (const family of Object.keys(PROVIDER_RATE_TABLE)) {
      const tariff = buildModelTariff(family);
      const rate = getModelRate(family);
      expect(validateAiTariff(tariff)).toEqual([]);
      expect(tariff.baseRates.inputMicrosPerToken).toBeCloseTo(
        rate.inputCentsPer1M / 100,
        10
      );
      expect(tariff.baseRates.outputMicrosPerToken).toBeCloseTo(
        rate.outputCentsPer1M / 100,
        10
      );
    }
  });

  it("selects base rates when the tariff declares no tiers", () => {
    const tariff: AiTariff = buildModelTariff("claude-sonnet-4-6");
    expect(selectTariffRates(tariff, 5_000_000)).toEqual(tariff.baseRates);
  });
});

describe("hasKnownModelRate", () => {
  it("knows concrete model ids and provider families", () => {
    expect(hasKnownModelRate("claude-sonnet-4-6")).toBe(true);
    expect(hasKnownModelRate("gemini")).toBe(true);
  });

  it("does not claim to know an unlisted id", () => {
    expect(hasKnownModelRate("shared-model")).toBe(false);
    expect(hasKnownModelRate("no-such-model-xyz")).toBe(false);
  });

  it("treats the `default` fallback key as not-known", () => {
    // `default` is the fallback bucket, not a model anyone invokes. Reporting
    // it as known would let the generic rate be billed as a real price.
    expect(hasKnownModelRate("default")).toBe(false);
  });
});

describe("buildKnownModelTariff", () => {
  it("returns a tariff for a known model", () => {
    const tariff = buildKnownModelTariff("claude-sonnet-4-6");
    expect(tariff).toBeDefined();
    expect(tariff?.baseRates.inputMicrosPerToken).toBe(3);
  });

  it("returns undefined instead of pricing an unknown model", () => {
    // buildModelTariff would happily return the `default` rate here; billing
    // callers must get nothing rather than an invented number.
    expect(buildModelTariff("shared-model").baseRates.inputMicrosPerToken).toBe(
      2,
    );
    expect(buildKnownModelTariff("shared-model")).toBeUndefined();
  });
});
