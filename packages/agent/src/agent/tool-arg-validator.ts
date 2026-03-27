/**
 * Tool argument validator and auto-repairer.
 *
 * Catches malformed LLM tool arguments BEFORE execution and optionally
 * repairs common issues (type coercion, missing defaults, extra fields).
 */

/** Result of validating (and optionally repairing) tool arguments. */
export interface ValidationResult {
  valid: boolean
  /** Repaired args (if auto-repair succeeded). Undefined when valid is false. */
  repairedArgs?: Record<string, unknown>
  /** Validation errors encountered. */
  errors: string[]
}

/** Configuration for the tool argument validator. */
export interface ToolArgValidatorConfig {
  /** Enable auto-repair of common issues (default: true). */
  autoRepair?: boolean
}

/**
 * JSON-Schema-style property descriptor (subset of JSON Schema used by
 * LangChain StructuredTool schemas).
 */
interface SchemaProperty {
  type?: string
  default?: unknown
  items?: { type?: string }
  enum?: unknown[]
  description?: string
}

interface ToolSchema {
  type?: string
  properties?: Record<string, SchemaProperty>
  required?: string[]
}

/**
 * Validate and optionally repair tool arguments against a JSON-Schema-like
 * tool schema.
 *
 * Auto-repair handles:
 * - String-to-number coercion ("42" -> 42)
 * - String-to-boolean coercion ("true" -> true)
 * - Null/undefined replaced with schema defaults
 * - Single values wrapped in arrays when schema expects array
 * - Extra fields not in schema removed (LLM hallucination cleanup)
 *
 * @param args  - Raw arguments from the LLM
 * @param schema - JSON-Schema-like object describing expected args
 * @param config - Validator configuration
 * @returns Validation result with optional repaired args
 */
export function validateAndRepairToolArgs(
  args: unknown,
  schema: Record<string, unknown>,
  config: ToolArgValidatorConfig = {},
): ValidationResult {
  const autoRepair = config.autoRepair ?? true
  const errors: string[] = []

  // --- Step 0: args must be an object ---
  if (args === null || args === undefined || typeof args !== 'object' || Array.isArray(args)) {
    if (autoRepair && (args === null || args === undefined)) {
      // Attempt to build from defaults
      const repaired = buildFromDefaults(schema as ToolSchema)
      if (repaired !== null) {
        return { valid: true, repairedArgs: repaired, errors: [] }
      }
    }
    errors.push(`Expected args to be an object, got ${args === null ? 'null' : typeof args}`)
    return { valid: false, errors }
  }

  const typedSchema = schema as ToolSchema
  const properties = typedSchema.properties ?? {}
  const required = new Set(typedSchema.required ?? [])

  const raw = args as Record<string, unknown>
  const repaired: Record<string, unknown> = {}
  const knownKeys = new Set(Object.keys(properties))

  // --- Step 1: validate & coerce each declared property ---
  for (const [key, propSchema] of Object.entries(properties)) {
    const value = raw[key]
    const expectedType = propSchema.type

    // Missing value
    if (value === undefined || value === null) {
      if (propSchema.default !== undefined) {
        if (autoRepair) {
          repaired[key] = propSchema.default
          continue
        }
      }
      if (required.has(key)) {
        errors.push(`Missing required field "${key}"`)
      }
      continue
    }

    // Type checking & coercion
    if (expectedType) {
      const coerced = coerceValue(value, expectedType, propSchema, autoRepair)
      if (coerced.ok) {
        repaired[key] = coerced.value
      } else {
        errors.push(coerced.error)
        // Still set the original if not repairable
        repaired[key] = value
      }
    } else {
      // No type specified — pass through
      repaired[key] = value
    }
  }

  // --- Step 2: handle extra fields (not in schema) ---
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      if (!autoRepair) {
        errors.push(`Unexpected field "${key}" not in schema`)
        repaired[key] = raw[key]
      }
      // When autoRepair is true, we silently drop extra fields
    }
  }

  // If we have errors and autoRepair is off, return invalid
  if (errors.length > 0 && !autoRepair) {
    return { valid: false, errors }
  }

  // If we have unrecoverable errors (missing required fields with no defaults), invalid
  const hasUnrecoverable = errors.some(e => e.startsWith('Missing required field'))
  if (hasUnrecoverable) {
    return { valid: false, repairedArgs: repaired, errors }
  }

  // Clear non-fatal errors when auto-repair succeeded
  return { valid: true, repairedArgs: repaired, errors: [] }
}

// ---------- Internal helpers ----------

type CoercionResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

function coerceValue(
  value: unknown,
  expectedType: string,
  _propSchema: SchemaProperty,
  autoRepair: boolean,
): CoercionResult {
  switch (expectedType) {
    case 'string':
      if (typeof value === 'string') return { ok: true, value }
      if (autoRepair) return { ok: true, value: String(value) }
      return { ok: false, error: `Expected string, got ${typeof value}` }

    case 'number':
    case 'integer': {
      if (typeof value === 'number') {
        if (expectedType === 'integer' && !Number.isInteger(value)) {
          if (autoRepair) return { ok: true, value: Math.round(value) }
          return { ok: false, error: `Expected integer, got float ${value}` }
        }
        return { ok: true, value }
      }
      if (autoRepair && typeof value === 'string') {
        const num = Number(value)
        if (!Number.isNaN(num)) {
          return {
            ok: true,
            value: expectedType === 'integer' ? Math.round(num) : num,
          }
        }
      }
      return { ok: false, error: `Expected ${expectedType}, got ${typeof value}` }
    }

    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value }
      if (autoRepair && typeof value === 'string') {
        if (value.toLowerCase() === 'true') return { ok: true, value: true }
        if (value.toLowerCase() === 'false') return { ok: true, value: false }
      }
      return { ok: false, error: `Expected boolean, got ${typeof value}` }
    }

    case 'array': {
      if (Array.isArray(value)) return { ok: true, value }
      if (autoRepair) {
        // Wrap single value in array
        return { ok: true, value: [value] }
      }
      return { ok: false, error: `Expected array, got ${typeof value}` }
    }

    case 'object': {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return { ok: true, value }
      }
      return { ok: false, error: `Expected object, got ${typeof value}` }
    }

    default:
      return { ok: true, value }
  }
}

/** Try to build a valid args object entirely from schema defaults. */
function buildFromDefaults(schema: ToolSchema): Record<string, unknown> | null {
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const result: Record<string, unknown> = {}

  for (const [key, prop] of Object.entries(properties)) {
    if (prop.default !== undefined) {
      result[key] = prop.default
    } else if (required.has(key)) {
      return null // Can't build — missing required field with no default
    }
  }

  return result
}

/**
 * Build a human-readable schema hint string for error messages sent back
 * to the LLM, so it can correct its arguments.
 */
export function formatSchemaHint(schema: Record<string, unknown>): string {
  const typedSchema = schema as ToolSchema
  const properties = typedSchema.properties ?? {}
  const required = new Set(typedSchema.required ?? [])
  const lines: string[] = ['Expected arguments:']

  for (const [key, prop] of Object.entries(properties)) {
    const req = required.has(key) ? ' (required)' : ''
    const type = prop.type ?? 'any'
    const def = prop.default !== undefined ? ` [default: ${JSON.stringify(prop.default)}]` : ''
    lines.push(`  ${key}: ${type}${req}${def}`)
  }

  return lines.join('\n')
}
