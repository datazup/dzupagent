import type { EvalInput, Scorer, ScorerConfig, ScorerResult } from '../types.js';

// --- JSON Schema Scorer ---

export interface JSONSchemaScorerConfig {
  id?: string;
  schema: Record<string, unknown>;
}

/**
 * Scores output by validating it against a JSON schema (required fields + property types).
 */
export function createJSONSchemaScorer(config: JSONSchemaScorerConfig): Scorer<EvalInput> {
  const scorerId = config.id ?? `json-schema-${Date.now()}`;
  const scorerConfig: ScorerConfig = {
    id: scorerId,
    name: 'json-schema',
    description: 'Validates output against a JSON schema',
    type: 'deterministic',
  };

  return {
    config: scorerConfig,

    async score(input: EvalInput): Promise<ScorerResult> {
      const startTime = Date.now();
      const { output } = input;
      const schema = config.schema;

      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        return makeResult(scorerId, startTime, 0, 'Output is not valid JSON');
      }

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return makeResult(scorerId, startTime, 0, 'Output is not a JSON object');
      }

      const obj = parsed as Record<string, unknown>;

      // Check required fields
      const requiredFields = schema['required'];
      if (Array.isArray(requiredFields)) {
        for (const field of requiredFields) {
          if (typeof field === 'string' && !(field in obj)) {
            return makeResult(scorerId, startTime, 0, `Missing required field: ${field}`);
          }
        }
      }

      // Check property types
      const properties = schema['properties'];
      if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
        const props = properties as Record<string, unknown>;
        for (const [key, spec] of Object.entries(props)) {
          if (key in obj && spec && typeof spec === 'object') {
            const propSpec = spec as Record<string, unknown>;
            const expectedType = propSpec['type'];
            if (typeof expectedType === 'string') {
              const actualType = Array.isArray(obj[key]) ? 'array' : typeof obj[key];
              if (actualType !== expectedType) {
                return makeResult(
                  scorerId,
                  startTime,
                  0,
                  `Field "${key}" expected type "${expectedType}" but got "${actualType}"`,
                );
              }
            }
          }
        }
      }

      return makeResult(scorerId, startTime, 1, 'Output matches JSON schema');
    },
  };
}

// --- Keyword Scorer ---

export interface KeywordScorerConfig {
  id?: string;
  required?: string[];
  forbidden?: string[];
  caseSensitive?: boolean;
}

/**
 * Scores output by checking for required and forbidden keywords.
 */
export function createKeywordScorer(config: KeywordScorerConfig): Scorer<EvalInput> {
  const scorerId = config.id ?? `keyword-${Date.now()}`;
  const scorerConfig: ScorerConfig = {
    id: scorerId,
    name: 'keyword',
    description: 'Checks for required and forbidden keywords',
    type: 'deterministic',
  };

  return {
    config: scorerConfig,

    async score(input: EvalInput): Promise<ScorerResult> {
      const startTime = Date.now();
      const caseSensitive = config.caseSensitive ?? false;
      const text = caseSensitive ? input.output : input.output.toLowerCase();
      const scores: Array<{ criterion: string; score: number; reasoning: string }> = [];

      // Check required keywords
      const required = config.required ?? [];
      for (const keyword of required) {
        const needle = caseSensitive ? keyword : keyword.toLowerCase();
        const found = text.includes(needle);
        scores.push({
          criterion: `required:${keyword}`,
          score: found ? 1 : 0,
          reasoning: found
            ? `Required keyword "${keyword}" found`
            : `Required keyword "${keyword}" missing`,
        });
      }

      // Check forbidden keywords
      const forbidden = config.forbidden ?? [];
      for (const keyword of forbidden) {
        const needle = caseSensitive ? keyword : keyword.toLowerCase();
        const found = text.includes(needle);
        scores.push({
          criterion: `forbidden:${keyword}`,
          score: found ? 0 : 1,
          reasoning: found
            ? `Forbidden keyword "${keyword}" detected`
            : `Forbidden keyword "${keyword}" absent`,
        });
      }

      const totalChecks = scores.length;
      const aggregateScore = totalChecks > 0
        ? scores.reduce((sum, s) => sum + s.score, 0) / totalChecks
        : 1;

      const durationMs = Date.now() - startTime;

      return {
        scorerId,
        scores,
        aggregateScore,
        passed: aggregateScore >= 1.0,
        durationMs,
      };
    },
  };
}

// --- Latency Scorer ---

export interface LatencyScorerConfig {
  id?: string;
  targetMs: number;
  maxMs: number;
}

/**
 * Scores based on latency. Score=1.0 if <= targetMs, linearly decreasing to 0.0 at maxMs.
 */
export function createLatencyScorer(config: LatencyScorerConfig): Scorer<EvalInput> {
  const scorerId = config.id ?? `latency-${Date.now()}`;
  const scorerConfig: ScorerConfig = {
    id: scorerId,
    name: 'latency',
    description: `Target: ${config.targetMs}ms, Max: ${config.maxMs}ms`,
    type: 'deterministic',
  };

  return {
    config: scorerConfig,

    async score(input: EvalInput): Promise<ScorerResult> {
      const startTime = Date.now();
      const latencyMs = input.latencyMs ?? 0;

      let score: number;
      let reasoning: string;

      if (latencyMs <= config.targetMs) {
        score = 1.0;
        reasoning = `Latency ${latencyMs}ms is at or below target ${config.targetMs}ms`;
      } else if (latencyMs >= config.maxMs) {
        score = 0.0;
        reasoning = `Latency ${latencyMs}ms exceeds max ${config.maxMs}ms`;
      } else {
        score = Math.max(0, 1 - (latencyMs - config.targetMs) / (config.maxMs - config.targetMs));
        reasoning = `Latency ${latencyMs}ms is between target ${config.targetMs}ms and max ${config.maxMs}ms`;
      }

      const durationMs = Date.now() - startTime;

      return {
        scorerId,
        scores: [{ criterion: 'latency', score, reasoning }],
        aggregateScore: score,
        passed: score > 0,
        durationMs,
      };
    },
  };
}

// --- Cost Scorer ---

export interface CostScorerConfig {
  id?: string;
  targetCents: number;
  maxCents: number;
}

/**
 * Scores based on cost. Score=1.0 if <= targetCents, linearly decreasing to 0.0 at maxCents.
 */
export function createCostScorer(config: CostScorerConfig): Scorer<EvalInput> {
  const scorerId = config.id ?? `cost-${Date.now()}`;
  const scorerConfig: ScorerConfig = {
    id: scorerId,
    name: 'cost',
    description: `Target: ${config.targetCents}c, Max: ${config.maxCents}c`,
    type: 'deterministic',
  };

  return {
    config: scorerConfig,

    async score(input: EvalInput): Promise<ScorerResult> {
      const startTime = Date.now();
      const costCents = input.costCents ?? 0;

      let score: number;
      let reasoning: string;

      if (costCents <= config.targetCents) {
        score = 1.0;
        reasoning = `Cost ${costCents}c is at or below target ${config.targetCents}c`;
      } else if (costCents >= config.maxCents) {
        score = 0.0;
        reasoning = `Cost ${costCents}c exceeds max ${config.maxCents}c`;
      } else {
        score = Math.max(0, 1 - (costCents - config.targetCents) / (config.maxCents - config.targetCents));
        reasoning = `Cost ${costCents}c is between target ${config.targetCents}c and max ${config.maxCents}c`;
      }

      const durationMs = Date.now() - startTime;

      return {
        scorerId,
        scores: [{ criterion: 'cost', score, reasoning }],
        aggregateScore: score,
        passed: score > 0,
        durationMs,
        costCents,
      };
    },
  };
}

// --- Helper ---

function makeResult(
  scorerId: string,
  startTime: number,
  score: number,
  reasoning: string,
): ScorerResult {
  return {
    scorerId,
    scores: [{ criterion: 'json-schema', score, reasoning }],
    aggregateScore: score,
    passed: score >= 1.0,
    durationMs: Date.now() - startTime,
  };
}
