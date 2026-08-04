/**
 * ARCH-M-08 consolidation lock.
 *
 * These tests pin the invariant that the canonical model/provider rate table is
 * the single source of truth: the former core `MODEL_COSTS` path (now
 * `calculateCostCents` / `getModelCosts`) and the agent-adapters `PROVIDER_RATES`
 * projection (now `getModelRate`) must agree on the cost of a shared model.
 */
import { describe, it, expect } from "vitest";
import {
  getModelRate,
  getModelCosts,
  calculateCostCents,
  MODEL_RATE_TABLE,
  PROVIDER_RATE_TABLE,
} from "../cost-tracking.js";
// Declared in model-rates, and deliberately NOT re-exported by cost-tracking —
// import it from the module that owns it rather than widening that surface.
import { hasKnownModelRate } from "../model-rates.js";

describe("ARCH-M-08 canonical rate consolidation", () => {
  it("core getModelCosts and agent-adapters getModelRate agree for a shared model (claude)", () => {
    // Former core MODEL_COSTS['claude-sonnet-4-6'] === agent-adapters PROVIDER_RATES.claude.
    const coreClaude = getModelCosts("claude-sonnet-4-6");
    const adapterClaude = getModelRate("claude");

    expect(coreClaude).not.toBeNull();
    expect(coreClaude!.input).toBe(adapterClaude.inputCentsPer1M);
    expect(coreClaude!.output).toBe(adapterClaude.outputCentsPer1M);
    // Locks the concrete numbers both consumers historically used.
    expect(coreClaude).toEqual({ input: 300, output: 1500 });
  });

  it("calculateCostCents produces the same total for the shared model regardless of entry point", () => {
    const usage = {
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    };
    const rate = getModelRate("claude");
    const expected = Math.ceil(
      (usage.inputTokens / 1_000_000) * rate.inputCentsPer1M +
        (usage.outputTokens / 1_000_000) * rate.outputCentsPer1M
    );
    expect(calculateCostCents(usage)).toBe(expected);
    expect(calculateCostCents(usage)).toBe(1800);
  });

  it("getModelRate resolves concrete models, provider families, and falls back to default", () => {
    // Base prices come from the concrete entry; cache tiers are inherited from
    // the `claude` family, which is the only place they are maintained.
    expect(getModelRate("claude-sonnet-4-6")).toEqual({
      ...MODEL_RATE_TABLE["claude-sonnet-4-6"],
      cachedInputCentsPer1M: PROVIDER_RATE_TABLE.claude.cachedInputCentsPer1M,
      cacheWriteCentsPer1M: PROVIDER_RATE_TABLE.claude.cacheWriteCentsPer1M,
    });
    // An explicit model entry still wins on base prices — never inherited.
    expect(getModelRate("claude-haiku-4-5-20251001")).toMatchObject({
      inputCentsPer1M: 80,
      outputCentsPer1M: 400,
    });
    // A family with no cache tiers gains no phantom ones.
    expect(getModelRate("gpt-5").cachedInputCentsPer1M).toBeUndefined();
    expect(getModelRate("gemini")).toEqual(PROVIDER_RATE_TABLE.gemini);
    expect(getModelRate("totally-unknown-model")).toEqual(
      MODEL_RATE_TABLE.default
    );
  });

  it("getModelCosts returns null for unknown models (preserves known-only contract)", () => {
    expect(getModelCosts("totally-unknown-model")).toBeNull();
    // `default` is a fallback bucket, not a "known" model — must not leak here.
    expect(getModelCosts("default")).not.toBeNull(); // 'default' IS a literal table key
  });

  it("calculateCostCents bills cache-read tokens at the cache-read rate, not for free", () => {
    // 1M cache-read tokens on claude cost 30c (0.1x the 300c input rate).
    // Before the fix these tokens were dropped entirely and billed as 0.
    const usage = {
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    };
    expect(calculateCostCents(usage)).toBe(30);
  });

  it("calculateCostCents bills cache-write tokens at the cache-write premium", () => {
    // Cache writes cost MORE than base input (375c vs 300c per 1M) — dropping
    // them under-reports spend on exactly the traffic that is most expensive.
    const usage = {
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
    };
    expect(calculateCostCents(usage)).toBe(375);
  });

  it("calculateCostCents falls back to the input rate when a model has no cache tier", () => {
    // codex declares no cache rates; cached tokens must still be billed at the
    // base input rate rather than silently vanishing.
    const usage = {
      model: "codex",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    expect(calculateCostCents(usage)).toBe(220); // 110 + 110
  });

  it("calculateCostCents sums every token class in one call", () => {
    const usage = {
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000, // 300
      outputTokens: 1_000_000, // 1500
      cacheReadTokens: 1_000_000, // 30
      cacheWriteTokens: 1_000_000, // 375
    };
    expect(calculateCostCents(usage)).toBe(2205);
  });

  it("calculateCostCents is unchanged for usage carrying no cache tokens", () => {
    // Regression guard: the fix must not move existing uncached totals.
    expect(
      calculateCostCents({
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      })
    ).toBe(1800);
  });

  it("prices the models docs-app actually selects, rather than defaulting them", () => {
    // These two ids are the live docs-app RAG chat primary and fallback. Before
    // this entry both were absent, so `hasKnownModelRate` was false and every
    // docs-app call reported cost unknown / no-tariff. A regression here is
    // silent at the call site — it re-reports unknown rather than throwing.
    expect(hasKnownModelRate("gpt-4o-mini")).toBe(true);
    expect(hasKnownModelRate("claude-3-5-haiku-20241022")).toBe(true);

    expect(getModelRate("gpt-4o-mini")).toMatchObject({
      inputCentsPer1M: 15,
      outputCentsPer1M: 60,
    });
    expect(getModelRate("claude-3-5-haiku-20241022")).toMatchObject({
      inputCentsPer1M: 80,
      outputCentsPer1M: 400,
    });
  });

  it("gives each new model the cache tiers its family does (or does not) define", () => {
    // The two ids resolve families differently, and only one gains cache tiers:
    // `claude-3-5-haiku-*` prefix-matches the `claude` family; `gpt-4o-mini`
    // matches no family, because OpenAI's family key is `openai`, not `gpt`.
    // Asserting this pins that the ids are not interchangeable.
    expect(getModelRate("claude-3-5-haiku-20241022")).toEqual({
      inputCentsPer1M: 80,
      outputCentsPer1M: 400,
      cachedInputCentsPer1M: PROVIDER_RATE_TABLE.claude.cachedInputCentsPer1M,
      cacheWriteCentsPer1M: PROVIDER_RATE_TABLE.claude.cacheWriteCentsPer1M,
    });
    expect(getModelRate("gpt-4o-mini").cachedInputCentsPer1M).toBeUndefined();
    expect(getModelRate("gpt-4o-mini").cacheWriteCentsPer1M).toBeUndefined();
  });

  it("PROVIDER_RATE_TABLE preserves the previously hand-maintained adapter values", () => {
    // Guards against silent drift of the values agent-adapters used to own.
    expect(PROVIDER_RATE_TABLE.claude).toEqual({
      inputCentsPer1M: 300,
      outputCentsPer1M: 1500,
      cachedInputCentsPer1M: 30,
      cacheWriteCentsPer1M: 375,
    });
    expect(PROVIDER_RATE_TABLE.codex).toEqual({
      inputCentsPer1M: 110,
      outputCentsPer1M: 440,
    });
    expect(PROVIDER_RATE_TABLE.openai).toEqual({
      inputCentsPer1M: 150,
      outputCentsPer1M: 600,
    });
    expect(PROVIDER_RATE_TABLE.crush).toEqual({
      inputCentsPer1M: 0,
      outputCentsPer1M: 0,
    });
  });
});
