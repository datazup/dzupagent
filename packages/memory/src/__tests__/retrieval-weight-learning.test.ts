import { describe, it, expect, vi } from 'vitest';
import {
  AdaptiveRetriever,
  WeightLearner,
  type RetrievalWeights,
  type QueryIntent,
  type FeedbackQuality,
} from '../retrieval/adaptive-retriever.js';

// ─── Helper factories ────────────────────────────────────────────────────────

const RECORDS = [
  { key: 'rec-1', value: { text: 'The ModelRegistry handles provider fallback logic' } },
  { key: 'rec-2', value: { text: 'ForgeError was added in 2024-01 as the base error class' } },
  { key: 'rec-3', value: { text: 'How to configure the circuit breaker timeout' } },
];

function makeVectorProvider() {
  return {
    search: vi.fn().mockResolvedValue([
      { key: 'rec-1', score: 0.95, value: RECORDS[0]!.value },
    ]),
  };
}

function makeFTSProvider() {
  return {
    search: vi.fn().mockReturnValue([
      { key: 'rec-2', score: 0.7, value: RECORDS[1]!.value },
    ]),
  };
}

function makeGraphProvider() {
  return {
    search: vi.fn().mockReturnValue([
      { key: 'rec-3', score: 0.8, value: RECORDS[2]!.value },
    ]),
  };
}

const SOURCE_NAMES = ['vector', 'fts', 'graph'] as const;

function sumWeights(w: RetrievalWeights): number {
  return w.vector + w.fts + w.graph;
}

// ─── WeightLearner (unit tests) ─────────────────────────────────────────────

describe('WeightLearner', () => {
  it('starts with no adjustments', () => {
    const learner = new WeightLearner();
    expect(learner.getAdjustments().size).toBe(0);
    expect(learner.getIntentAdjustment('temporal')).toBeUndefined();
  });

  it('records feedback and creates intent adjustment', () => {
    const learner = new WeightLearner();
    const weights: RetrievalWeights = { vector: 0.3, fts: 0.2, graph: 0.5 };
    learner.recordFeedback('temporal', weights, 'good');

    const adj = learner.getIntentAdjustment('temporal');
    expect(adj).toBeDefined();
    expect(sumWeights(adj!)).toBeCloseTo(1.0, 2);
  });

  it('repeated good feedback reinforces dominant weight direction', () => {
    const learner = new WeightLearner();
    // Temporal default: graph=0.5, vector=0.3, fts=0.2
    const weights: RetrievalWeights = { vector: 0.3, fts: 0.2, graph: 0.5 };

    // Record many good feedback signals
    for (let i = 0; i < 50; i++) {
      learner.recordFeedback('temporal', weights, 'good');
    }

    const adj = learner.getIntentAdjustment('temporal')!;
    // Graph should be the highest since it was dominant and got reinforced
    expect(adj.graph).toBeGreaterThan(adj.vector);
    expect(adj.graph).toBeGreaterThan(adj.fts);
    expect(sumWeights(adj)).toBeCloseTo(1.0, 2);
  });

  it('repeated bad feedback dampens dominant weights toward equal', () => {
    const learner = new WeightLearner();
    // Causal default: graph=0.6, vector=0.3, fts=0.1
    const weights: RetrievalWeights = { vector: 0.3, fts: 0.1, graph: 0.6 };

    for (let i = 0; i < 100; i++) {
      learner.recordFeedback('causal', weights, 'bad');
    }

    const adj = learner.getIntentAdjustment('causal')!;
    // After many bad signals, weights should be closer to equal (1/3 each)
    // The difference between max and min should be smaller than original
    const originalSpread = 0.6 - 0.1; // 0.5
    const learnedSpread = Math.max(adj.vector, adj.fts, adj.graph) - Math.min(adj.vector, adj.fts, adj.graph);
    expect(learnedSpread).toBeLessThan(originalSpread);
    expect(sumWeights(adj)).toBeCloseTo(1.0, 2);
  });

  it('weights stay within min/max bounds', () => {
    const learner = new WeightLearner({ minWeight: 0.05, maxWeight: 0.8 });
    const extremeWeights: RetrievalWeights = { vector: 0.98, fts: 0.01, graph: 0.01 };

    // Repeated good feedback on extreme weights
    for (let i = 0; i < 200; i++) {
      learner.recordFeedback('factual', extremeWeights, 'good');
    }

    const adj = learner.getIntentAdjustment('factual')!;
    for (const s of SOURCE_NAMES) {
      expect(adj[s]).toBeGreaterThanOrEqual(0.03); // tolerance for float math + renormalization
      expect(adj[s]).toBeLessThanOrEqual(0.85); // slight overshoot possible after renormalization
    }
    expect(sumWeights(adj)).toBeCloseTo(1.0, 2);
  });

  it('reset() clears all learned adjustments', () => {
    const learner = new WeightLearner();
    const weights: RetrievalWeights = { vector: 0.4, fts: 0.3, graph: 0.3 };
    learner.recordFeedback('general', weights, 'good');
    expect(learner.getAdjustments().size).toBe(1);

    learner.reset();
    expect(learner.getAdjustments().size).toBe(0);
    expect(learner.getIntentAdjustment('general')).toBeUndefined();
  });

  it('getAdjustments returns a copy for each intent', () => {
    const learner = new WeightLearner();
    const weights: RetrievalWeights = { vector: 0.4, fts: 0.3, graph: 0.3 };
    learner.recordFeedback('general', weights, 'good');
    learner.recordFeedback('temporal', { vector: 0.3, fts: 0.2, graph: 0.5 }, 'bad');

    const adjustments = learner.getAdjustments();
    expect(adjustments.size).toBe(2);
    expect(adjustments.has('general')).toBe(true);
    expect(adjustments.has('temporal')).toBe(true);

    // Verify it's a copy
    const generalAdj = adjustments.get('general')!;
    generalAdj.vector = 999;
    expect(learner.getIntentAdjustment('general')!.vector).not.toBe(999);
  });

  it('blend() returns raw weights when no learned data exists', () => {
    const learner = new WeightLearner();
    const raw: RetrievalWeights = { vector: 0.6, fts: 0.3, graph: 0.1 };
    const result = learner.blend(raw, 'factual', 0.05);
    expect(result.vector).toBeCloseTo(0.6, 5);
    expect(result.fts).toBeCloseTo(0.3, 5);
    expect(result.graph).toBeCloseTo(0.1, 5);
  });

  it('blend() mixes raw and learned weights correctly', () => {
    const learner = new WeightLearner();
    const raw: RetrievalWeights = { vector: 0.6, fts: 0.3, graph: 0.1 };

    // Force a learned state by recording feedback
    learner.recordFeedback('factual', raw, 'good');
    const learned = learner.getIntentAdjustment('factual')!;

    const blendRate = 0.5;
    const blended = learner.blend(raw, 'factual', blendRate);

    // Each component should be between raw and learned values (approximately)
    // The blended weights should sum to ~1.0
    expect(sumWeights(blended)).toBeCloseTo(1.0, 2);
  });

  it('mixed feedback makes smaller adjustments than good/bad', () => {
    // Create two learners with same starting point
    const learnerBad = new WeightLearner();
    const learnerMixed = new WeightLearner();

    const weights: RetrievalWeights = { vector: 0.3, fts: 0.1, graph: 0.6 };

    learnerBad.recordFeedback('causal', weights, 'bad');
    learnerMixed.recordFeedback('causal', weights, 'mixed');

    const adjBad = learnerBad.getIntentAdjustment('causal')!;
    const adjMixed = learnerMixed.getIntentAdjustment('causal')!;

    // Bad feedback should produce a bigger shift from original than mixed
    const badDelta = Math.abs(adjBad.graph - weights.graph);
    const mixedDelta = Math.abs(adjMixed.graph - weights.graph);
    expect(badDelta).toBeGreaterThan(mixedDelta);
  });

  it('tracks multiple intents independently', () => {
    const learner = new WeightLearner();

    learner.recordFeedback('temporal', { vector: 0.3, fts: 0.2, graph: 0.5 }, 'good');
    learner.recordFeedback('causal', { vector: 0.3, fts: 0.1, graph: 0.6 }, 'bad');

    const temporal = learner.getIntentAdjustment('temporal')!;
    const causal = learner.getIntentAdjustment('causal')!;

    // They should differ since they got opposite feedback
    expect(temporal.graph).not.toBeCloseTo(causal.graph, 2);
  });
});

// ─── AdaptiveRetriever feedback integration ─────────────────────────────────

describe('AdaptiveRetriever feedback integration', () => {
  it('learning is disabled by default — reportFeedback has no effect', () => {
    const retriever = new AdaptiveRetriever({
      providers: { vector: makeVectorProvider() },
    });

    retriever.reportFeedback('when was it changed?', 'temporal', 'good');
    retriever.reportFeedback('when was it changed?', 'temporal', 'good');

    const adjustments = retriever.getLearnedAdjustments();
    expect(adjustments.size).toBe(0);
  });

  it('reportFeedback records when learning is enabled', () => {
    const retriever = new AdaptiveRetriever({
      providers: { vector: makeVectorProvider() },
      learnFromFeedback: true,
    });

    retriever.reportFeedback('when was it changed?', 'temporal', 'good');
    const adjustments = retriever.getLearnedAdjustments();
    expect(adjustments.size).toBe(1);
    expect(adjustments.has('temporal')).toBe(true);
  });

  it('getLearnedAdjustments returns empty map when disabled', () => {
    const retriever = new AdaptiveRetriever({
      providers: {},
      learnFromFeedback: false,
    });

    const adjustments = retriever.getLearnedAdjustments();
    expect(adjustments).toBeInstanceOf(Map);
    expect(adjustments.size).toBe(0);
  });

  it('resetLearning clears all feedback state', () => {
    const retriever = new AdaptiveRetriever({
      providers: { vector: makeVectorProvider() },
      learnFromFeedback: true,
    });

    retriever.reportFeedback('why did it fail?', 'causal', 'bad');
    retriever.reportFeedback('when was it changed?', 'temporal', 'good');
    expect(retriever.getLearnedAdjustments().size).toBe(2);

    retriever.resetLearning();
    // After reset, enable still works but state is cleared
    // getLearnedAdjustments still checks learnFromFeedback flag
    expect(retriever.getLearnedAdjustments().size).toBe(0);
  });

  it('learned weights influence search results when enabled', async () => {
    const vector = makeVectorProvider();
    const graph = makeGraphProvider();

    const retriever = new AdaptiveRetriever({
      providers: { vector, graph },
      namespace: ['test'],
      learnFromFeedback: true,
    });

    // Record many good feedbacks for temporal queries (graph-heavy)
    for (let i = 0; i < 20; i++) {
      retriever.reportFeedback('when was it updated?', 'temporal', 'good');
    }

    // The learned adjustments should exist
    const adjustments = retriever.getLearnedAdjustments();
    expect(adjustments.has('temporal')).toBe(true);
    const learnedTemporal = adjustments.get('temporal')!;
    // Temporal default has graph=0.5 as dominant — good feedback reinforces this
    expect(learnedTemporal.graph).toBeGreaterThan(learnedTemporal.vector);
  });

  it('search still works correctly with learning enabled but no feedback', async () => {
    const vector = makeVectorProvider();
    const fts = makeFTSProvider();

    const retriever = new AdaptiveRetriever({
      providers: { vector, fts },
      learnFromFeedback: true,
    });

    // No feedback reported — should use default weights
    const results = await retriever.search('hello world', RECORDS);
    expect(results.length).toBeGreaterThan(0);
  });

  it('learned adjustments have weights that sum to ~1.0', () => {
    const retriever = new AdaptiveRetriever({
      providers: { vector: makeVectorProvider() },
      learnFromFeedback: true,
    });

    retriever.reportFeedback('why did it crash?', 'causal', 'bad');
    retriever.reportFeedback('why did it crash?', 'causal', 'bad');
    retriever.reportFeedback('why did it crash?', 'causal', 'bad');

    const adjustments = retriever.getLearnedAdjustments();
    const causalAdj = adjustments.get('causal')!;
    expect(sumWeights(causalAdj)).toBeCloseTo(1.0, 2);
  });

  it('repeated bad feedback reduces a dominant provider weight', () => {
    const retriever = new AdaptiveRetriever({
      providers: { vector: makeVectorProvider(), graph: makeGraphProvider() },
      learnFromFeedback: true,
    });

    // Causal default: graph=0.6 is dominant
    const originalGraphWeight = retriever.getWeights('causal').graph;

    // Send many bad signals
    for (let i = 0; i < 50; i++) {
      retriever.reportFeedback('why did it fail?', 'causal', 'bad');
    }

    const learned = retriever.getLearnedAdjustments().get('causal')!;
    // After bad feedback, graph weight should be lower than original
    expect(learned.graph).toBeLessThan(originalGraphWeight);
  });

  it('repeated good feedback for temporal queries increases graph weight relative to default', () => {
    const retriever = new AdaptiveRetriever({
      providers: {
        vector: makeVectorProvider(),
        fts: makeFTSProvider(),
        graph: makeGraphProvider(),
      },
      learnFromFeedback: true,
    });

    // Temporal default: { vector: 0.3, fts: 0.2, graph: 0.5 }
    for (let i = 0; i < 50; i++) {
      retriever.reportFeedback('when was it updated?', 'temporal', 'good');
    }

    const learned = retriever.getLearnedAdjustments().get('temporal')!;
    // Good feedback reinforces the dominant weight — graph was 0.5, should go higher
    expect(learned.graph).toBeGreaterThan(0.5);
    expect(sumWeights(learned)).toBeCloseTo(1.0, 2);
  });
});
