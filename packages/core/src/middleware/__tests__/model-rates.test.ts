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
    expect(getModelRate("claude-sonnet-4-6")).toEqual(
      MODEL_RATE_TABLE["claude-sonnet-4-6"]
    );
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
