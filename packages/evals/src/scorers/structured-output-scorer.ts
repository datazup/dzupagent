import type {
  EvalInput,
  Scorer,
  ScorerConfig,
  ScorerResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Structured Output Scorer — richer schema validation with partial scoring
// ---------------------------------------------------------------------------

/** A JSON Schema-compatible property specification */
export interface PropertySpec {
  type?: "string" | "number" | "boolean" | "object" | "array" | "null";
  /** Accepted enum values */
  enum?: unknown[];
  /** Regex pattern (for string fields) */
  pattern?: string;
  /** Whether the field accepts null */
  nullable?: boolean;
  /** Sub-schema for object properties */
  properties?: Record<string, PropertySpec>;
  /** Sub-schema for array items */
  items?: PropertySpec;
  /** Minimum number of items (for array type) */
  minItems?: number;
  /** Maximum number of items (for array type) */
  maxItems?: number;
  /** Whether this field is optional (does not penalise if absent) */
  optional?: boolean;
  /** Weight when computing aggregate score (default: 1) */
  weight?: number;
}

export interface StructuredOutputScorerConfig {
  id?: string;
  /** Required field names */
  required?: string[];
  /** Property specs keyed by field name */
  properties?: Record<string, PropertySpec>;
  /**
   * Whether to allow type coercion.
   * When true, a string "42" is accepted for a number field.
   * Default: false
   */
  coerce?: boolean;
  /**
   * Whether extra properties that are not listed in `properties` should
   * cause a penalty.  Default: false (extra fields are silently ignored).
   */
  penaliseExtraFields?: boolean;
}

interface FieldResult {
  field: string;
  score: number;
  reasoning: string;
  weight: number;
}

/**
 * Validates structured JSON output against a rich schema.
 *
 * Unlike `createJSONSchemaScorer`, this scorer:
 * - Returns **partial scores** (0–1) based on how many field checks pass
 * - Supports enum validation, regex pattern validation, nested objects,
 *   array item type checking, array length constraints, nullable fields,
 *   optional fields, per-field weights, and optional type coercion.
 */
export function createStructuredOutputScorer(
  config: StructuredOutputScorerConfig,
): Scorer<EvalInput> {
  const scorerId = config.id ?? `structured-output-${Date.now()}`;
  const scorerConfig: ScorerConfig = {
    id: scorerId,
    name: "structured-output",
    description: "Validates structured JSON output with partial scoring",
    type: "deterministic",
  };

  return {
    config: scorerConfig,

    async score(input: EvalInput): Promise<ScorerResult> {
      const startTime = Date.now();

      // ── Parse ──────────────────────────────────────────────────────────────
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.output);
      } catch {
        return makeResult(
          scorerId,
          startTime,
          [],
          0,
          false,
          "Output is not valid JSON",
        );
      }

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return makeResult(
          scorerId,
          startTime,
          [],
          0,
          false,
          "Output is not a JSON object",
        );
      }

      const obj = parsed as Record<string, unknown>;
      const fieldResults: FieldResult[] = [];

      // ── Required fields ────────────────────────────────────────────────────
      for (const field of config.required ?? []) {
        if (!(field in obj)) {
          fieldResults.push({
            field,
            score: 0,
            reasoning: `Required field "${field}" is missing`,
            weight: config.properties?.[field]?.weight ?? 1,
          });
        }
        // present required fields are validated below via properties
      }

      // ── Property validation ────────────────────────────────────────────────
      const properties = config.properties ?? {};
      for (const [key, spec] of Object.entries(properties)) {
        const isRequired = (config.required ?? []).includes(key);
        const isPresent = key in obj;

        if (!isPresent) {
          if (spec.optional || !isRequired) {
            // Optional or not required → no penalty for absence
            continue;
          }
          // Required and not present → already captured above
          continue;
        }

        const value = obj[key];
        const weight = spec.weight ?? 1;
        const result = validateValue(key, value, spec, config.coerce ?? false);
        fieldResults.push({ ...result, weight });
      }

      // ── Extra fields ───────────────────────────────────────────────────────
      if (config.penaliseExtraFields) {
        for (const key of Object.keys(obj)) {
          if (!(key in properties)) {
            fieldResults.push({
              field: key,
              score: 0,
              reasoning: `Extra field "${key}" is not allowed by schema`,
              weight: 1,
            });
          }
        }
      }

      // ── Aggregate ──────────────────────────────────────────────────────────
      if (fieldResults.length === 0) {
        // No constraints to check — perfect score
        const scores = [
          {
            criterion: "structured-output",
            score: 1,
            reasoning: "No constraints to validate",
          },
        ];
        return {
          scorerId,
          scores,
          aggregateScore: 1,
          passed: true,
          durationMs: Date.now() - startTime,
        };
      }

      const totalWeight = fieldResults.reduce((s, r) => s + r.weight, 0);
      const weightedScore = fieldResults.reduce(
        (s, r) => s + r.score * r.weight,
        0,
      );
      const aggregateScore = totalWeight > 0 ? weightedScore / totalWeight : 1;

      const scores = fieldResults.map((r) => ({
        criterion: r.field,
        score: r.score,
        reasoning: r.reasoning,
      }));

      return {
        scorerId,
        scores,
        aggregateScore,
        passed: aggregateScore >= 1.0,
        durationMs: Date.now() - startTime,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function validateValue(
  key: string,
  value: unknown,
  spec: PropertySpec,
  coerce: boolean,
): Omit<FieldResult, "weight"> {
  // Nullable check
  if (value === null) {
    if (spec.nullable) {
      return {
        field: key,
        score: 1,
        reasoning: `Field "${key}" is null (nullable allowed)`,
      };
    }
    return {
      field: key,
      score: 0,
      reasoning: `Field "${key}" is null but not nullable`,
    };
  }

  // Type check (with optional coercion)
  if (spec.type && spec.type !== "null") {
    const actualType = Array.isArray(value) ? "array" : typeof value;
    if (actualType !== spec.type) {
      if (coerce && spec.type === "number" && actualType === "string") {
        const n = Number(value);
        if (!isNaN(n)) {
          // coercion succeeds — treat as partial pass (0.8)
          return {
            field: key,
            score: 0.8,
            reasoning: `Field "${key}" coerced from string to number`,
          };
        }
      }
      if (coerce && spec.type === "boolean" && actualType === "string") {
        const v = (value as string).toLowerCase();
        if (v === "true" || v === "false") {
          return {
            field: key,
            score: 0.8,
            reasoning: `Field "${key}" coerced from string to boolean`,
          };
        }
      }
      return {
        field: key,
        score: 0,
        reasoning: `Field "${key}" expected type "${spec.type}" but got "${actualType}"`,
      };
    }
  }

  // Enum check
  if (spec.enum !== undefined) {
    if (!spec.enum.includes(value)) {
      return {
        field: key,
        score: 0,
        reasoning: `Field "${key}" value ${JSON.stringify(value)} is not in enum ${JSON.stringify(spec.enum)}`,
      };
    }
  }

  // Pattern check (string only)
  if (spec.pattern !== undefined && typeof value === "string") {
    const re = new RegExp(spec.pattern);
    if (!re.test(value)) {
      return {
        field: key,
        score: 0,
        reasoning: `Field "${key}" value "${value}" does not match pattern "${spec.pattern}"`,
      };
    }
  }

  // Array checks
  if (spec.type === "array" && Array.isArray(value)) {
    // minItems
    if (spec.minItems !== undefined && value.length < spec.minItems) {
      return {
        field: key,
        score: 0,
        reasoning: `Field "${key}" has ${value.length} items but requires at least ${spec.minItems}`,
      };
    }
    // maxItems
    if (spec.maxItems !== undefined && value.length > spec.maxItems) {
      return {
        field: key,
        score: 0,
        reasoning: `Field "${key}" has ${value.length} items but allows at most ${spec.maxItems}`,
      };
    }
    // items type check
    if (spec.items?.type) {
      const badItems = (value as unknown[]).filter((item) => {
        const t = Array.isArray(item) ? "array" : typeof item;
        return t !== spec.items!.type;
      });
      if (badItems.length > 0) {
        const fraction = (value.length - badItems.length) / value.length;
        return {
          field: key,
          score: fraction,
          reasoning: `Field "${key}" has ${badItems.length}/${value.length} items with wrong type (expected "${spec.items.type}")`,
        };
      }
    }
  }

  // Nested object properties
  if (
    spec.type === "object" &&
    spec.properties &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const nested = value as Record<string, unknown>;
    const nestedResults: Array<{ score: number; weight: number }> = [];
    for (const [nk, nSpec] of Object.entries(spec.properties)) {
      if (!(nk in nested)) {
        if (!nSpec.optional) {
          nestedResults.push({ score: 0, weight: nSpec.weight ?? 1 });
        }
        continue;
      }
      const nr = validateValue(`${key}.${nk}`, nested[nk], nSpec, coerce);
      nestedResults.push({ score: nr.score, weight: nSpec.weight ?? 1 });
    }
    if (nestedResults.length === 0) {
      return {
        field: key,
        score: 1,
        reasoning: `Nested object "${key}" is valid`,
      };
    }
    const totalW = nestedResults.reduce((s, r) => s + r.weight, 0);
    const weightedS = nestedResults.reduce((s, r) => s + r.score * r.weight, 0);
    const nestedScore = totalW > 0 ? weightedS / totalW : 1;
    return {
      field: key,
      score: nestedScore,
      reasoning:
        nestedScore >= 1
          ? `Nested object "${key}" fully valid`
          : `Nested object "${key}" partially valid (score=${nestedScore.toFixed(2)})`,
    };
  }

  return { field: key, score: 1, reasoning: `Field "${key}" is valid` };
}

function makeResult(
  scorerId: string,
  startTime: number,
  scores: Array<{ criterion: string; score: number; reasoning: string }>,
  aggregateScore: number,
  passed: boolean,
  reasoning: string,
): ScorerResult {
  return {
    scorerId,
    scores:
      scores.length > 0
        ? scores
        : [
            {
              criterion: "structured-output",
              score: aggregateScore,
              reasoning,
            },
          ],
    aggregateScore,
    passed,
    durationMs: Date.now() - startTime,
  };
}
