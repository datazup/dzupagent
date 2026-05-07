/**
 * Shared types, schema surface, and helper utilities used by every per-node
 * validator in this directory.
 *
 * This module deliberately holds NO node-kind-specific logic — only the
 * primitives that all per-kind files consume.
 */

import type { FlowNode, ValidationError, ValidationErrorCode } from '../types.js'
import { describeJsType, isPlainObject, joinPath } from '../validation-helpers.js'

// ---------------------------------------------------------------------------
// Zod-compatible schema surface
// ---------------------------------------------------------------------------

/**
 * Single validation issue. Shape is deliberately aligned with
 * `ZodIssue` (subset) so downstream code can treat this and a real Zod
 * issue interchangeably.
 */
export interface SchemaIssue {
  /** RFC 6901-ish path (dot-separated, not slash-separated, to match flow-compiler convention). */
  path: string
  /** Stable machine-readable issue code. */
  code: ValidationErrorCode
  /** Human-readable diagnostic. */
  message: string
}

export type ValidateNodeArray = (
  value: unknown,
  path: string,
  issues: SchemaIssue[],
) => FlowNode[] | null

/**
 * Result of `safeParse` — always discriminated by `success`.
 * Aligned with `z.SafeParseReturnType`.
 */
export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: SchemaValidationError }

/**
 * Error thrown by `parse` / returned by `safeParse`. Exposed as a class so
 * `instanceof` checks behave and downstream code can rely on `.issues`
 * mirroring `ZodError.issues`.
 */
export class SchemaValidationError extends Error {
  readonly issues: SchemaIssue[]

  constructor(issues: SchemaIssue[]) {
    super(
      issues.length === 0
        ? 'Schema validation failed'
        : `Schema validation failed: ${issues[0]!.message}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}`,
    )
    this.name = 'SchemaValidationError'
    this.issues = issues
  }
}

/**
 * Minimal Zod-like schema surface. Every schema exported from this module
 * implements this interface.
 */
export interface SchemaLike<T> {
  parse(value: unknown): T
  safeParse(value: unknown): SafeParseResult<T>
}

// ---------------------------------------------------------------------------
// Issue → ValidationError adapter
// ---------------------------------------------------------------------------

export function issueToValidationError(issue: SchemaIssue): ValidationError {
  // Best-effort nodeType recovery: when the issue path targets an AST node
  // whose `type` discriminator failed, we lose the original discriminator
  // and synthesize a neutral one. Downstream callers care about
  // (code, message, nodePath) — nodeType is purely for grouping.
  return {
    nodeType: 'action',
    nodePath: issue.path,
    code: issue.code,
    message: issue.message,
  }
}

// ---------------------------------------------------------------------------
// Common helpers used by per-kind validators
// ---------------------------------------------------------------------------

export interface CommonNodeFields {
  id?: string
  name?: string
  description?: string
  meta?: Record<string, unknown>
}

export function validateCommonNodeFields(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): CommonNodeFields {
  const fields: CommonNodeFields = {}

  const id = validateOptionalStringField(obj, path, 'id', issues)
  if (id !== undefined) fields.id = id

  const name = validateOptionalStringField(obj, path, 'name', issues)
  if (name !== undefined) fields.name = name

  const description = validateOptionalStringField(obj, path, 'description', issues)
  if (description !== undefined) fields.description = description

  const meta = validateOptionalObjectField(obj, path, 'meta', issues)
  if (meta !== undefined) fields.meta = meta

  return fields
}

export function validateOptionalStringField(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  issues: SchemaIssue[],
): string | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined
  const value = obj[key]
  if (typeof value !== 'string') {
    issues.push({
      path: joinPath(path, key),
      code: 'MISSING_REQUIRED_FIELD',
      message: `${key} must be a string when present, received ${describeJsType(value)}`,
    })
    return undefined
  }
  return value
}

export function validateOptionalStringArrayField(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  issues: SchemaIssue[],
): string[] | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined
  const value = obj[key]
  if (Array.isArray(value) && value.every((v): v is string => typeof v === 'string')) {
    return value
  }
  issues.push({
    path: joinPath(path, key),
    code: 'MISSING_REQUIRED_FIELD',
    message: `${key} must be an array of strings when present`,
  })
  return undefined
}

export function validateOptionalObjectField(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  issues: SchemaIssue[],
): Record<string, unknown> | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined
  const value = obj[key]
  if (isPlainObject(value)) return value
  issues.push({
    path: joinPath(path, key),
    code: 'MISSING_REQUIRED_FIELD',
    message: `${key} must be an object when present, received ${describeJsType(value)}`,
  })
  return undefined
}
