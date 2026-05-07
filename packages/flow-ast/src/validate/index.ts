/**
 * SC-12 Zod-compatible runtime schema validation for flow-ast.
 *
 * ## Why hand-rolled (not `zod`)?
 *
 * Neither `@dzupagent/flow-ast` nor `@dzupagent/flow-compiler` declares `zod`
 * as a dependency. Adding one purely to satisfy SC-12 would balloon the
 * dependency-light leaf-runtime surface of this package and require peer-dep gymnastics
 * in every downstream workspace. Per SC-12 constraints ("Do NOT add a new dep
 * if zod isn't already there — use type narrowing instead and note the gap"),
 * this module exposes a Zod-compatible API shape built entirely from
 * type-narrowing primitives.
 *
 * ## API parity
 *
 * Each exported schema object mirrors the Zod v4 surface that downstream
 * consumers rely on for progressive validation:
 *
 *   const result = flowNodeSchema.safeParse(value)
 *   if (!result.success) { ...result.error.issues }
 *   const node = flowNodeSchema.parse(value) // throws on invalid
 *
 * ## Gap
 *
 * If `zod` is later promoted to a first-class dep of flow-ast, this file can
 * be replaced by a thin `z.discriminatedUnion(...)` derivation and the
 * `SchemaLike<T>` interface below is already shape-compatible — no downstream
 * source changes required.
 *
 * This `index.ts` is the public barrel for the per-node-kind validate split.
 * Re-exports cover the entire historical surface of the original
 * `validate.ts`, including the Zod-like schema wrappers, the
 * `validateFlowNodeShape` / `validateFlowDocumentShape` adapters, and the
 * `FlowEdge` schema.
 */

import type { FlowDocumentV1, FlowNode, ValidationError } from '../types.js'
import {
  type SafeParseResult,
  type SchemaIssue,
  type SchemaLike,
  SchemaValidationError,
  issueToValidationError,
} from './shared.js'
import { validateFlowNode } from './dispatch.js'
import { validateFlowDocument } from './document.js'
import { validateFlowEdge, type FlowEdge } from './edge.js'

// ---------------------------------------------------------------------------
// Re-export the shared schema surface so existing imports keep working
// ---------------------------------------------------------------------------

export type { SchemaIssue, SafeParseResult, SchemaLike } from './shared.js'
export { SchemaValidationError } from './shared.js'
export type { FlowEdge } from './edge.js'

// ---------------------------------------------------------------------------
// FlowNode schema
// ---------------------------------------------------------------------------

/**
 * Runtime schema for {@link FlowNode}. Validates structure recursively and
 * produces typed {@link SchemaIssue}s — no raw throws in the happy path; any
 * throw from `parse` is a {@link SchemaValidationError} carrying every issue.
 *
 * Behavior matches the hand-rolled `parseFlow` structural rules so it is safe
 * to call this on a pre-parsed AST or on a candidate partial config.
 */
export const flowNodeSchema: SchemaLike<FlowNode> = {
  parse(value: unknown): FlowNode {
    const issues: SchemaIssue[] = []
    const node = validateFlowNode(value, 'root', issues)
    if (issues.length > 0 || node === null) {
      throw new SchemaValidationError(issues)
    }
    return node
  },
  safeParse(value: unknown): SafeParseResult<FlowNode> {
    const issues: SchemaIssue[] = []
    const node = validateFlowNode(value, 'root', issues)
    if (issues.length > 0 || node === null) {
      return { success: false, error: new SchemaValidationError(issues) }
    }
    return { success: true, data: node }
  },
}

/**
 * Runtime schema for the canonical authored workflow document. Unlike
 * `flowNodeSchema`, this validator enforces document-level invariants such as
 * required workflow metadata and unique, present node ids.
 */
export const flowDocumentSchema: SchemaLike<FlowDocumentV1> = {
  parse(value: unknown): FlowDocumentV1 {
    const issues: SchemaIssue[] = []
    const doc = validateFlowDocument(value, 'root', issues)
    if (issues.length > 0 || doc === null) {
      throw new SchemaValidationError(issues)
    }
    return doc
  },
  safeParse(value: unknown): SafeParseResult<FlowDocumentV1> {
    const issues: SchemaIssue[] = []
    const doc = validateFlowDocument(value, 'root', issues)
    if (issues.length > 0 || doc === null) {
      return { success: false, error: new SchemaValidationError(issues) }
    }
    return { success: true, data: doc }
  },
}

// ---------------------------------------------------------------------------
// FlowEdge schema
// ---------------------------------------------------------------------------

export const flowEdgeSchema: SchemaLike<FlowEdge> = {
  parse(value: unknown): FlowEdge {
    const issues: SchemaIssue[] = []
    const edge = validateFlowEdge(value, 'root', issues)
    if (issues.length > 0 || edge === null) {
      throw new SchemaValidationError(issues)
    }
    return edge
  },
  safeParse(value: unknown): SafeParseResult<FlowEdge> {
    const issues: SchemaIssue[] = []
    const edge = validateFlowEdge(value, 'root', issues)
    if (issues.length > 0 || edge === null) {
      return { success: false, error: new SchemaValidationError(issues) }
    }
    return { success: true, data: edge }
  },
}

// ---------------------------------------------------------------------------
// Convenience: validate a FlowNode AST and return ValidationError[] directly,
// so flow-compiler's semantic stage can splice the results into its aggregate
// error array without translating issue shapes.
// ---------------------------------------------------------------------------

/**
 * Validate a {@link FlowNode} AST against the runtime schema and return the
 * issues as {@link ValidationError}s (the compiler's aggregate error shape).
 *
 * Returns an empty array on valid input. Never throws.
 *
 * `basePath` defaults to `'root'` to match flow-compiler's semantic-stage
 * node-path convention.
 */
export function validateFlowNodeShape(
  value: unknown,
  basePath: string = 'root',
): ValidationError[] {
  const issues: SchemaIssue[] = []
  validateFlowNode(value, basePath, issues)
  return issues.map(issueToValidationError)
}

export function validateFlowDocumentShape(
  value: unknown,
  basePath: string = 'root',
): ValidationError[] {
  const issues: SchemaIssue[] = []
  validateFlowDocument(value, basePath, issues)
  return issues.map(issueToValidationError)
}
