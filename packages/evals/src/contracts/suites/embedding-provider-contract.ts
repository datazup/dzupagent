/**
 * Embedding Provider Contract Suite — conformance tests for EmbeddingProvider adapters.
 *
 * Tests verify the EmbeddingProvider interface contract defined in @forgeagent/core.
 */

import { ContractSuiteBuilder, timedTest } from '../contract-test-generator.js';
import type { ContractSuite } from '../contract-types.js';

// ---------------------------------------------------------------------------
// Minimal interface shape
// ---------------------------------------------------------------------------

interface EmbeddingProviderShape {
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

function asEmbeddingProvider(adapter: unknown): EmbeddingProviderShape {
  return adapter as EmbeddingProviderShape;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

export function createEmbeddingProviderContract(): ContractSuite {
  const builder = new ContractSuiteBuilder('embedding-provider', 'Embedding Provider Contract')
    .description('Conformance tests for EmbeddingProvider adapter implementations');

  // --- Required ---

  builder.required(
    'has-model-id',
    'Model identifier',
    'Adapter exposes a non-empty modelId string',
    async (adapter) =>
      timedTest(async () => {
        const provider = asEmbeddingProvider(adapter);

        if (typeof provider.modelId !== 'string' || provider.modelId.length === 0) {
          return { passed: false, error: 'modelId must be a non-empty string' };
        }

        return { passed: true, details: { modelId: provider.modelId } };
      }),
  );

  builder.required(
    'has-dimensions',
    'Dimensions',
    'Adapter exposes a positive integer dimensions property',
    async (adapter) =>
      timedTest(async () => {
        const provider = asEmbeddingProvider(adapter);

        if (typeof provider.dimensions !== 'number' || provider.dimensions <= 0) {
          return { passed: false, error: `dimensions must be a positive number, got ${provider.dimensions}` };
        }

        if (!Number.isInteger(provider.dimensions)) {
          return { passed: false, error: 'dimensions must be an integer' };
        }

        return { passed: true, details: { dimensions: provider.dimensions } };
      }),
  );

  builder.required(
    'embed-returns-vectors',
    'Batch embed returns vectors',
    'embed() returns one vector per input text with correct dimensions',
    async (adapter) =>
      timedTest(async () => {
        const provider = asEmbeddingProvider(adapter);
        const texts = ['hello world', 'goodbye world'];

        const vectors = await provider.embed(texts);

        if (!Array.isArray(vectors)) {
          return { passed: false, error: 'embed() must return an array' };
        }

        if (vectors.length !== texts.length) {
          return {
            passed: false,
            error: `Expected ${texts.length} vectors, got ${vectors.length}`,
          };
        }

        for (let i = 0; i < vectors.length; i++) {
          const vec = vectors[i]!;
          if (!Array.isArray(vec)) {
            return { passed: false, error: `Vector at index ${i} is not an array` };
          }

          if (vec.length !== provider.dimensions) {
            return {
              passed: false,
              error: `Vector ${i} has ${vec.length} dimensions, expected ${provider.dimensions}`,
            };
          }

          // All elements must be numbers
          if (!vec.every((v) => typeof v === 'number' && !Number.isNaN(v))) {
            return { passed: false, error: `Vector ${i} contains non-numeric values` };
          }
        }

        return { passed: true, details: { vectorCount: vectors.length, dimensions: vectors[0]!.length } };
      }),
  );

  builder.required(
    'embed-query-returns-vector',
    'Single query embed',
    'embedQuery() returns a single vector with correct dimensions',
    async (adapter) =>
      timedTest(async () => {
        const provider = asEmbeddingProvider(adapter);

        const vector = await provider.embedQuery('test query');

        if (!Array.isArray(vector)) {
          return { passed: false, error: 'embedQuery() must return an array' };
        }

        if (vector.length !== provider.dimensions) {
          return {
            passed: false,
            error: `Expected ${provider.dimensions} dimensions, got ${vector.length}`,
          };
        }

        if (!vector.every((v) => typeof v === 'number' && !Number.isNaN(v))) {
          return { passed: false, error: 'Vector contains non-numeric values' };
        }

        return { passed: true, details: { dimensions: vector.length } };
      }),
  );

  // --- Recommended ---

  builder.recommended(
    'batch-consistency',
    'Batch vs single consistency',
    'embed(["text"])[0] produces the same vector as embedQuery("text")',
    async (adapter) =>
      timedTest(async () => {
        const provider = asEmbeddingProvider(adapter);
        const text = 'consistency test';

        const batchResult = await provider.embed([text]);
        const singleResult = await provider.embedQuery(text);

        const batchVec = batchResult[0]!;

        if (batchVec.length !== singleResult.length) {
          return {
            passed: false,
            error: `Dimension mismatch: batch=${batchVec.length}, single=${singleResult.length}`,
          };
        }

        // Check that vectors are close (allow for floating point differences)
        let maxDiff = 0;
        for (let i = 0; i < batchVec.length; i++) {
          const diff = Math.abs(batchVec[i]! - singleResult[i]!);
          if (diff > maxDiff) maxDiff = diff;
        }

        if (maxDiff > 0.001) {
          return {
            passed: false,
            error: `Vectors differ by up to ${maxDiff.toFixed(6)} — expected near-identical results`,
          };
        }

        return { passed: true, details: { maxDifference: maxDiff } };
      }),
  );

  builder.recommended(
    'empty-batch-handling',
    'Empty batch handling',
    'embed([]) returns an empty array without error',
    async (adapter) =>
      timedTest(async () => {
        const provider = asEmbeddingProvider(adapter);

        try {
          const result = await provider.embed([]);

          if (!Array.isArray(result)) {
            return { passed: false, error: 'embed([]) must return an array' };
          }

          if (result.length !== 0) {
            return { passed: false, error: `Expected 0 vectors for empty input, got ${result.length}` };
          }

          return { passed: true };
        } catch {
          // Throwing for empty input is also acceptable
          return { passed: true, details: { behavior: 'throws-on-empty' } };
        }
      }),
  );

  // --- Optional ---

  builder.optional(
    'large-batch',
    'Large batch embedding',
    'embed() handles a batch of 10+ texts without error',
    async (adapter) =>
      timedTest(async () => {
        const provider = asEmbeddingProvider(adapter);
        const texts = Array.from({ length: 10 }, (_, i) => `Document number ${i + 1}`);

        const vectors = await provider.embed(texts);

        if (vectors.length !== 10) {
          return { passed: false, error: `Expected 10 vectors, got ${vectors.length}` };
        }

        return { passed: true, details: { batchSize: 10 } };
      }),
  );

  builder.optional(
    'semantic-similarity',
    'Semantic similarity ordering',
    'Similar texts produce vectors closer together than dissimilar texts',
    async (adapter) =>
      timedTest(async () => {
        const provider = asEmbeddingProvider(adapter);

        const vectors = await provider.embed([
          'The cat sat on the mat',
          'A feline rested on the rug',
          'Quantum entanglement in particle physics',
        ]);

        // Cosine similarity helper
        const cosine = (a: number[], b: number[]): number => {
          let dot = 0;
          let normA = 0;
          let normB = 0;
          for (let i = 0; i < a.length; i++) {
            dot += a[i]! * b[i]!;
            normA += a[i]! * a[i]!;
            normB += b[i]! * b[i]!;
          }
          return dot / (Math.sqrt(normA) * Math.sqrt(normB));
        };

        const simCatFeline = cosine(vectors[0]!, vectors[1]!);
        const simCatQuantum = cosine(vectors[0]!, vectors[2]!);

        if (simCatFeline <= simCatQuantum) {
          return {
            passed: false,
            error: `Expected "cat/feline" similarity (${simCatFeline.toFixed(4)}) > "cat/quantum" (${simCatQuantum.toFixed(4)})`,
          };
        }

        return {
          passed: true,
          details: { catFeline: simCatFeline, catQuantum: simCatQuantum },
        };
      }),
  );

  return builder.build();
}

/** Pre-built Embedding Provider contract suite */
export const EMBEDDING_PROVIDER_CONTRACT = createEmbeddingProviderContract();
