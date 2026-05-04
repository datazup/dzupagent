/**
 * RF-08 — Optional tool-output schema validation.
 *
 * Provides a lightweight, additive validation layer over tool results.
 * Validation failures are SOFT — they emit a warning event but never
 * abort tool execution. Tools that don't register a schema are returned
 * unchanged.
 *
 * Two annotation styles are supported:
 *   1. Zod schema (`ZodTypeAny`): the result string is JSON-parsed first,
 *      then validated via `safeParse`. Non-JSON results count as invalid.
 *   2. Predicate (`(result: string) => boolean`): called directly on the
 *      raw string; throws are caught as soft failures.
 */
import type { z } from 'zod'

/** A single tool output schema entry — Zod schema or boolean predicate. */
export type ToolOutputSchema =
  | z.ZodTypeAny
  | ((result: string) => boolean)

/** Result of validating a tool's output. */
export interface ToolOutputValidationResult {
  valid: boolean
  /** Human-readable error when `valid === false`. */
  error?: string
}

/**
 * Lightweight validator for tool outputs. Holds a registry of optional
 * schemas keyed by tool name and exposes a single `validate(...)` entry
 * point used by the policy-enabled executor.
 *
 * Tools without a registered schema always validate as `{ valid: true }`.
 */
export class ToolOutputValidator {
  private readonly schemas: Map<string, ToolOutputSchema>

  constructor(schemas: Record<string, ToolOutputSchema> = {}) {
    this.schemas = new Map(Object.entries(schemas))
  }

  /** Register or replace a schema for a tool. */
  register(toolName: string, schema: ToolOutputSchema): void {
    this.schemas.set(toolName, schema)
  }

  /** Returns `true` if a schema is registered for the given tool. */
  has(toolName: string): boolean {
    return this.schemas.has(toolName)
  }

  /**
   * Validate the given tool result. Returns `{ valid: true }` when no
   * schema is registered. Validation errors are returned, never thrown.
   */
  validate(toolName: string, result: string): ToolOutputValidationResult {
    const schema = this.schemas.get(toolName)
    if (!schema) return { valid: true }

    if (typeof schema === 'function') {
      try {
        const ok = schema(result)
        return ok
          ? { valid: true }
          : { valid: false, error: 'Predicate returned false' }
      } catch (err) {
        return {
          valid: false,
          error: `Predicate threw: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }

    // Zod schema path: try JSON.parse first, then safeParse.
    let parsed: unknown
    try {
      parsed = JSON.parse(result)
    } catch {
      // Non-JSON results may still be valid for string schemas.
      parsed = result
    }
    const outcome = schema.safeParse(parsed)
    if (outcome.success) return { valid: true }
    return {
      valid: false,
      error: outcome.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; '),
    }
  }
}
