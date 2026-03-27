import type { EvalResult, EvalScorer } from './types.js';

export interface DeterministicScorerConfig {
  name?: string;
  mode: 'exactMatch' | 'contains' | 'regex' | 'jsonSchema';
  /** For regex mode */
  pattern?: RegExp;
  /** For jsonSchema mode — basic schema with required fields and type checks */
  schema?: Record<string, unknown>;
  /** Case-insensitive matching (default: false) */
  caseInsensitive?: boolean;
}

/**
 * Scores outputs using deterministic rules (no LLM needed).
 */
export class DeterministicScorer implements EvalScorer {
  readonly name: string;
  private readonly config: DeterministicScorerConfig;

  constructor(config: DeterministicScorerConfig) {
    this.name = config.name ?? `deterministic-${config.mode}`;
    this.config = config;
  }

  async score(_input: string, output: string, reference?: string): Promise<EvalResult> {
    switch (this.config.mode) {
      case 'exactMatch':
        return this.scoreExactMatch(output, reference);
      case 'contains':
        return this.scoreContains(output, reference);
      case 'regex':
        return this.scoreRegex(output);
      case 'jsonSchema':
        return this.scoreJsonSchema(output);
    }
  }

  private scoreExactMatch(output: string, reference?: string): EvalResult {
    if (reference === undefined) {
      return { score: 0, pass: false, reasoning: 'No reference provided for exactMatch mode' };
    }

    const matches = this.config.caseInsensitive
      ? output.toLowerCase() === reference.toLowerCase()
      : output === reference;

    return {
      score: matches ? 1.0 : 0.0,
      pass: matches,
      reasoning: matches
        ? 'Output exactly matches reference'
        : 'Output does not match reference',
    };
  }

  private scoreContains(output: string, reference?: string): EvalResult {
    if (reference === undefined) {
      return { score: 0, pass: false, reasoning: 'No reference provided for contains mode' };
    }

    const haystack = this.config.caseInsensitive ? output.toLowerCase() : output;
    const needle = this.config.caseInsensitive ? reference.toLowerCase() : reference;
    const found = haystack.includes(needle);

    return {
      score: found ? 1.0 : 0.0,
      pass: found,
      reasoning: found
        ? 'Output contains the reference substring'
        : 'Output does not contain the reference substring',
    };
  }

  private scoreRegex(output: string): EvalResult {
    if (!this.config.pattern) {
      return { score: 0, pass: false, reasoning: 'No pattern provided for regex mode' };
    }

    const matches = this.config.pattern.test(output);
    return {
      score: matches ? 1.0 : 0.0,
      pass: matches,
      reasoning: matches
        ? `Output matches pattern ${String(this.config.pattern)}`
        : `Output does not match pattern ${String(this.config.pattern)}`,
    };
  }

  private scoreJsonSchema(output: string): EvalResult {
    if (!this.config.schema) {
      return { score: 0, pass: false, reasoning: 'No schema provided for jsonSchema mode' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return { score: 0, pass: false, reasoning: 'Output is not valid JSON' };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { score: 0, pass: false, reasoning: 'Output is not a JSON object' };
    }

    const obj = parsed as Record<string, unknown>;
    const schema = this.config.schema;

    // Check required fields
    const requiredFields = schema['required'];
    if (Array.isArray(requiredFields)) {
      for (const field of requiredFields) {
        if (typeof field === 'string' && !(field in obj)) {
          return {
            score: 0,
            pass: false,
            reasoning: `Missing required field: ${field}`,
          };
        }
      }
    }

    // Check property types if "properties" is specified
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
              return {
                score: 0,
                pass: false,
                reasoning: `Field "${key}" expected type "${expectedType}" but got "${actualType}"`,
              };
            }
          }
        }
      }
    }

    return {
      score: 1.0,
      pass: true,
      reasoning: 'Output matches JSON schema',
    };
  }
}
