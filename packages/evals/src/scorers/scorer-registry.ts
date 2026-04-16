/**
 * Scorer Registry — registry pattern for scoring strategies.
 *
 * Provides a central place to register and look up scorers by type.
 * Built-in scorers (exact-match, contains, llm-judge) are pre-registered.
 * Custom scorers can be registered at runtime.
 */

import type { EvalInput, Scorer, ScorerConfig, ScorerResult } from '../types.js';
import { LlmJudgeScorer } from './llm-judge-scorer.js';
import { EvidenceQualityScorer } from './evidence-quality-scorer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Factory function that creates a scorer from config + dependencies. */
export type ScorerFactory = (deps: ScorerFactoryDeps) => Scorer<EvalInput>;

/** Dependencies injected into scorer factories. */
export interface ScorerFactoryDeps {
  /** LLM function for LLM-based scorers. */
  llm?: (prompt: string) => Promise<string>;
  /** Reference string for comparison-based scorers. */
  reference?: string;
  /** Arbitrary config options. */
  options?: Record<string, unknown>;
}

/** A registered scorer entry in the registry. */
interface ScorerRegistryEntry {
  type: string;
  description: string;
  factory: ScorerFactory;
}

// ---------------------------------------------------------------------------
// Built-in scorer factories
// ---------------------------------------------------------------------------

function createExactMatchScorer(_deps: ScorerFactoryDeps): Scorer<EvalInput> {
  const config: ScorerConfig = {
    id: 'exact-match',
    name: 'exact-match',
    description: 'Scores 1.0 if output exactly matches reference, 0.0 otherwise',
    type: 'deterministic',
  };

  return {
    config,
    async score(input: EvalInput): Promise<ScorerResult> {
      const startTime = Date.now();
      const matches = input.reference !== undefined && input.output === input.reference;

      return {
        scorerId: config.id,
        scores: [{
          criterion: 'exact-match',
          score: matches ? 1.0 : 0.0,
          reasoning: matches
            ? 'Output exactly matches reference'
            : input.reference === undefined
              ? 'No reference provided'
              : 'Output does not match reference',
        }],
        aggregateScore: matches ? 1.0 : 0.0,
        passed: matches,
        durationMs: Date.now() - startTime,
      };
    },
  };
}

function createContainsScorer(_deps: ScorerFactoryDeps): Scorer<EvalInput> {
  const config: ScorerConfig = {
    id: 'contains',
    name: 'contains',
    description: 'Scores 1.0 if output contains the reference substring, 0.0 otherwise',
    type: 'deterministic',
  };

  return {
    config,
    async score(input: EvalInput): Promise<ScorerResult> {
      const startTime = Date.now();
      const found = input.reference !== undefined && input.output.includes(input.reference);

      return {
        scorerId: config.id,
        scores: [{
          criterion: 'contains',
          score: found ? 1.0 : 0.0,
          reasoning: found
            ? 'Output contains the reference substring'
            : input.reference === undefined
              ? 'No reference provided'
              : 'Output does not contain the reference substring',
        }],
        aggregateScore: found ? 1.0 : 0.0,
        passed: found,
        durationMs: Date.now() - startTime,
      };
    },
  };
}

function createLlmJudgeScorerFromRegistry(deps: ScorerFactoryDeps): Scorer<EvalInput> {
  if (!deps.llm) {
    // Return a no-op scorer that always fails when no LLM is provided
    const config: ScorerConfig = {
      id: 'llm-judge',
      name: 'llm-judge',
      description: 'LLM judge scorer (no LLM provided)',
      type: 'llm-judge',
    };

    return {
      config,
      async score(_input: EvalInput): Promise<ScorerResult> {
        return {
          scorerId: config.id,
          scores: [{
            criterion: 'llm-judge',
            score: 0,
            reasoning: 'No LLM function provided to scorer registry',
          }],
          aggregateScore: 0,
          passed: false,
          durationMs: 0,
        };
      },
    };
  }

  return new LlmJudgeScorer({ llm: deps.llm });
}

function createEvidenceQualityScorerFromRegistry(_deps: ScorerFactoryDeps): Scorer<EvalInput> {
  return new EvidenceQualityScorer();
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Registry for scoring strategies. Provides lookup by scorer type and
 * supports registering custom scorers at runtime.
 *
 * Built-in scorers:
 * - `exact-match`: Output must exactly match reference
 * - `contains`: Output must contain reference as a substring
 * - `llm-judge`: 5-dimension LLM judge with Zod validation
 *
 * Usage:
 * ```typescript
 * const registry = new ScorerRegistry();
 * const scorer = registry.create('llm-judge', { llm: myLlmFn });
 * const result = await scorer.score({ input: 'Q', output: 'A' });
 * ```
 */
export class ScorerRegistry {
  private readonly entries = new Map<string, ScorerRegistryEntry>();

  constructor() {
    // Register built-in scorers
    this.register('exact-match', 'Exact string match against reference', createExactMatchScorer);
    this.register('contains', 'Substring containment check against reference', createContainsScorer);
    this.register('llm-judge', '5-dimension LLM judge with Zod-validated structured output', createLlmJudgeScorerFromRegistry);
    this.register('evidence_quality', 'Evidence quality scorer for research output: coverage, corroboration, and source reliability', createEvidenceQualityScorerFromRegistry);
  }

  /**
   * Register a custom scorer factory.
   * Overwrites any previously registered scorer with the same type.
   */
  register(type: string, description: string, factory: ScorerFactory): void {
    this.entries.set(type, { type, description, factory });
  }

  /**
   * Create a scorer instance by type.
   * Throws if the type is not registered.
   */
  create(type: string, deps?: ScorerFactoryDeps): Scorer<EvalInput> {
    const entry = this.entries.get(type);
    if (!entry) {
      const available = [...this.entries.keys()].join(', ');
      throw new Error(
        `Unknown scorer type "${type}". Available types: ${available}`,
      );
    }
    return entry.factory(deps ?? {});
  }

  /**
   * Check whether a scorer type is registered.
   */
  has(type: string): boolean {
    return this.entries.has(type);
  }

  /**
   * List all registered scorer types with descriptions.
   */
  list(): Array<{ type: string; description: string }> {
    return [...this.entries.values()].map(({ type, description }) => ({
      type,
      description,
    }));
  }

  /**
   * Remove a registered scorer type.
   * Returns true if the type was found and removed.
   */
  unregister(type: string): boolean {
    return this.entries.delete(type);
  }
}

/** Shared singleton registry with built-in scorers. */
export const defaultScorerRegistry = new ScorerRegistry();
