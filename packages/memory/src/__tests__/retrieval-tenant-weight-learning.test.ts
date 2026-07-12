/**
 * Tenant-scoped retrieval weight learning.
 *
 * In a multi-tenant server one AdaptiveRetriever instance is shared across
 * tenants. Learned weight adjustments must be partitioned per tenant so one
 * tenant's feedback can never shift the retrieval weights applied to
 * another tenant's searches.
 */
import { describe, it, expect, vi } from "vitest";
import { AdaptiveRetriever } from "../retrieval/adaptive-retriever.js";

function makeVectorProvider() {
  return {
    search: vi
      .fn()
      .mockResolvedValue([
        { key: "rec-1", score: 0.95, value: { text: "vector hit" } },
      ]),
  };
}

function makeGraphProvider() {
  return {
    search: vi
      .fn()
      .mockReturnValue([
        { key: "rec-2", score: 0.8, value: { text: "graph hit" } },
      ]),
  };
}

const RECORDS = [
  { key: "rec-1", value: { text: "vector hit" } },
  { key: "rec-2", value: { text: "graph hit" } },
];

describe("AdaptiveRetriever tenant-scoped weight learning", () => {
  it("one tenant's feedback does not affect another tenant's learned weights (leak repro)", () => {
    const retriever = new AdaptiveRetriever({
      providers: { vector: makeVectorProvider() },
      learnFromFeedback: true,
    });

    for (let i = 0; i < 50; i++) {
      retriever.reportFeedback("when was it updated?", "temporal", "good", {
        tenantId: "tenant-a",
      });
    }

    expect(retriever.getLearnedAdjustments("tenant-a").size).toBe(1);
    expect(retriever.getLearnedAdjustments("tenant-b").size).toBe(0);
  });

  it("feedback without a tenant is scoped to the default tenant only", () => {
    const retriever = new AdaptiveRetriever({
      providers: { vector: makeVectorProvider() },
      learnFromFeedback: true,
    });

    retriever.reportFeedback("when was it updated?", "temporal", "good");

    expect(retriever.getLearnedAdjustments().size).toBe(1);
    expect(retriever.getLearnedAdjustments("tenant-a").size).toBe(0);
  });

  it("search applies learned weights only for the tenant that reported feedback", async () => {
    const retriever = new AdaptiveRetriever({
      providers: { vector: makeVectorProvider(), graph: makeGraphProvider() },
      learnFromFeedback: true,
    });

    // Temporal default weights are graph-dominant; repeated good feedback
    // for tenant-a reinforces that dominance for tenant-a only.
    for (let i = 0; i < 50; i++) {
      retriever.reportFeedback("when was it updated?", "temporal", "good", {
        tenantId: "tenant-a",
      });
    }

    const resultsA = await retriever.search(
      "when was it updated?",
      RECORDS,
      5,
      {
        tenantId: "tenant-a",
      },
    );
    const resultsB = await retriever.search(
      "when was it updated?",
      RECORDS,
      5,
      {
        tenantId: "tenant-b",
      },
    );

    expect(resultsA.length).toBeGreaterThan(0);
    expect(resultsB.length).toBeGreaterThan(0);
    // Tenant A's search weights are blended toward its learned (reinforced)
    // graph weight; tenant B still searches with the raw defaults.
    expect(resultsA[0]!.weights.graph).toBeGreaterThan(
      resultsB[0]!.weights.graph,
    );
  });

  it("resetLearning(tenantId) clears only that tenant", () => {
    const retriever = new AdaptiveRetriever({
      providers: { vector: makeVectorProvider() },
      learnFromFeedback: true,
    });

    retriever.reportFeedback("when was it updated?", "temporal", "good", {
      tenantId: "tenant-a",
    });
    retriever.reportFeedback("why did it fail?", "causal", "bad", {
      tenantId: "tenant-b",
    });

    retriever.resetLearning("tenant-a");

    expect(retriever.getLearnedAdjustments("tenant-a").size).toBe(0);
    expect(retriever.getLearnedAdjustments("tenant-b").size).toBe(1);
  });

  it("resetLearning() with no argument clears all tenants", () => {
    const retriever = new AdaptiveRetriever({
      providers: { vector: makeVectorProvider() },
      learnFromFeedback: true,
    });

    retriever.reportFeedback("when was it updated?", "temporal", "good", {
      tenantId: "tenant-a",
    });
    retriever.reportFeedback("why did it fail?", "causal", "bad");

    retriever.resetLearning();

    expect(retriever.getLearnedAdjustments("tenant-a").size).toBe(0);
    expect(retriever.getLearnedAdjustments().size).toBe(0);
  });
});
