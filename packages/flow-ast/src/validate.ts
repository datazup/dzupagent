/**
 * SC-12 Zod-compatible runtime schema validation for flow-ast.
 *
 * ## Why hand-rolled (not `zod`)?
 *
 * Neither `@dzupagent/flow-ast` nor `@dzupagent/flow-compiler` declares `zod`
 * as a dependency. Adding one purely to satisfy SC-12 would balloon the
 * runtime-free-types surface of this package and require peer-dep gymnastics
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
 */

import type {
  FlowDocumentV1,
  FlowInputSpec,
  FlowNode,
  FlowValue,
  ValidationError,
  ValidationErrorCode,
  EmitNode,
  MemoryNode,
  CheckpointNode,
  RestoreNode,
} from './types.js'

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
//
// flow-ast itself does not model edges — edges are implicit in the tree
// shape (children arrays). However, downstream consumers (flow-compiler
// lowerers, workflow-builder, skill-chain) need a canonical edge shape to
// validate state transitions. Expose a minimal edge schema that captures
// the stable slice shared by every lowerer target.
// ---------------------------------------------------------------------------

/**
 * Canonical edge shape shared by every lowered artifact target. This is
 * intentionally minimal — each target may extend it with additional fields
 * (e.g. `condition` for branch edges) but this core subset is always valid.
 */
export interface FlowEdge {
  /** Source node id (pipeline node id or dot-notation AST path). */
  from: string
  /** Target node id. */
  to: string
  /** Optional edge kind, when the lowerer emits more than one. */
  kind?: string
  /** Optional guard expression for conditional edges. */
  condition?: string
}

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

function issueToValidationError(issue: SchemaIssue): ValidationError {
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
// FlowDocument walker
// ---------------------------------------------------------------------------

function validateFlowDocument(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): FlowDocumentV1 | null {
  if (!isPlainObject(value)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: `Expected workflow document object, received ${describeJsType(value)}`,
    })
    return null
  }

  const dsl = value['dsl']
  if (dsl !== 'dzupflow/v1') {
    issues.push({
      path: joinPath(path, 'dsl'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `document.dsl must equal "dzupflow/v1", received ${describeJsType(dsl) === 'string' ? JSON.stringify(dsl) : describeJsType(dsl)}`,
    })
  }

  const id = value['id']
  if (typeof id !== 'string' || id.length === 0) {
    issues.push({
      path: joinPath(path, 'id'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'document.id is required (non-empty string)',
    })
  }

  const version = value['version']
  if (!Number.isInteger(version) || (version as number) <= 0) {
    issues.push({
      path: joinPath(path, 'version'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'document.version is required (positive integer)',
    })
  }

  const title = validateOptionalStringField(value, path, 'title', issues)
  const description = validateOptionalStringField(value, path, 'description', issues)
  const tags = validateOptionalStringArrayField(value, path, 'tags', issues)
  const meta = validateOptionalObjectField(value, path, 'meta', issues)
  const inputs = validateOptionalInputs(value, path, issues)
  const defaults = validateOptionalDefaults(value, path, issues)

  const rootNode = validateFlowNode(value['root'], joinPath(path, 'root'), issues)
  if (rootNode === null) return null
  if (rootNode.type !== 'sequence') {
    issues.push({
      path: joinPath(path, 'root'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `document.root must be a sequence node, received ${rootNode.type}`,
    })
    return null
  }

  validateCanonicalNodeIds(rootNode, joinPath(path, 'root'), issues, new Map<string, string>())

  const doc: FlowDocumentV1 = {
    dsl: 'dzupflow/v1',
    id: typeof id === 'string' ? id : '',
    version: Number.isInteger(version) ? (version as number) : 0,
    root: rootNode,
  }
  if (title !== undefined) doc.title = title
  if (description !== undefined) doc.description = description
  if (tags !== undefined) doc.tags = tags
  if (meta !== undefined) doc.meta = meta
  if (inputs !== undefined) doc.inputs = inputs
  if (defaults !== undefined) doc.defaults = defaults
  return doc
}

// ---------------------------------------------------------------------------
// FlowNode walker
// ---------------------------------------------------------------------------

const KNOWN_NODE_TYPES: ReadonlySet<string> = new Set([
  'sequence',
  'action',
  'for_each',
  'branch',
  'approval',
  'clarification',
  'persona',
  'route',
  'parallel',
  'complete',
  'spawn',
  'classify',
  'emit',
  'memory',
  'checkpoint',
  'restore',
])

function validateFlowNode(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  if (!isPlainObject(value)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: `Expected node object, received ${describeJsType(value)}`,
    })
    return null
  }

  const typeVal = value['type']
  if (typeof typeVal !== 'string') {
    issues.push({
      path: joinPath(path, 'type'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `Node.type is required (string), received ${describeJsType(typeVal)}`,
    })
    return null
  }

  if (!KNOWN_NODE_TYPES.has(typeVal)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: `Unknown node type "${typeVal}"`,
    })
    return null
  }

  switch (typeVal) {
    case 'sequence':
      return validateSequence(value, path, issues)
    case 'action':
      return validateAction(value, path, issues)
    case 'for_each':
      return validateForEach(value, path, issues)
    case 'branch':
      return validateBranch(value, path, issues)
    case 'approval':
      return validateApproval(value, path, issues)
    case 'clarification':
      return validateClarification(value, path, issues)
    case 'persona':
      return validatePersona(value, path, issues)
    case 'route':
      return validateRoute(value, path, issues)
    case 'parallel':
      return validateParallel(value, path, issues)
    case 'complete':
      return validateComplete(value, path, issues)
    case 'spawn':
      return validateSpawn(value, path, issues)
    case 'classify':
      return validateClassify(value, path, issues)
    case 'emit':
      return validateEmit(value, path, issues)
    case 'memory':
      return validateMemory(value, path, issues)
    case 'checkpoint':
      return validateCheckpoint(value, path, issues)
    case 'restore':
      return validateRestore(value, path, issues)
    default:
      issues.push({
        path,
        code: 'MISSING_REQUIRED_FIELD',
        message: `Unknown node type "${typeVal}"`,
      })
      return null
  }
}

function validateNodeArray(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): FlowNode[] | null {
  if (!Array.isArray(value)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: `Expected array of nodes at ${path}, received ${describeJsType(value)}`,
    })
    return null
  }
  const out: FlowNode[] = []
  for (let i = 0; i < value.length; i++) {
    const child = validateFlowNode(value[i], `${path}[${i}]`, issues)
    if (child !== null) out.push(child)
  }
  return out
}

function validateSequence(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const nodes = validateNodeArray(obj['nodes'], `${path}.nodes`, issues)
  if (nodes === null) return null
  if (nodes.length === 0) {
    issues.push({
      path,
      code: 'EMPTY_BODY',
      message: 'sequence.nodes must contain at least one node',
    })
  }
  return { type: 'sequence', ...common, nodes }
}

function validateAction(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const toolRef = obj['toolRef']
  const input = obj['input']
  let ok = true
  if (typeof toolRef !== 'string' || toolRef.length === 0) {
    issues.push({
      path: joinPath(path, 'toolRef'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'action.toolRef is required (non-empty string)',
    })
    ok = false
  }
  if (!isPlainObject(input)) {
    issues.push({
      path: joinPath(path, 'input'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'action.input is required (object, may be empty)',
    })
    ok = false
  }
  let personaRef: string | undefined
  if ('personaRef' in obj) {
    const p = obj['personaRef']
    if (typeof p === 'string') personaRef = p
    else {
      issues.push({
        path: joinPath(path, 'personaRef'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `action.personaRef must be a string when present, received ${describeJsType(p)}`,
      })
    }
  }
  if (!ok) return null
  const node: FlowNode = {
    type: 'action',
    ...common,
    toolRef: toolRef as string,
    input: input as Record<string, unknown>,
  }
  if (personaRef !== undefined) node.personaRef = personaRef
  return node
}

function validateForEach(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const source = obj['source']
  const as = obj['as']
  let ok = true
  if (typeof source !== 'string' || source.length === 0) {
    issues.push({
      path: joinPath(path, 'source'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'for_each.source is required (non-empty string)',
    })
    ok = false
  }
  if (typeof as !== 'string' || as.length === 0) {
    issues.push({
      path: joinPath(path, 'as'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'for_each.as is required (non-empty string)',
    })
    ok = false
  }
  const body = validateNodeArray(obj['body'], joinPath(path, 'body'), issues)
  if (body === null) return null
  if (body.length === 0) {
    issues.push({
      path,
      code: 'EMPTY_BODY',
      message: 'for_each.body must contain at least one node',
    })
  }
  if (!ok) return null
  return {
    type: 'for_each',
    ...common,
    source: source as string,
    as: as as string,
    body,
  }
}

function validateBranch(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const condition = obj['condition']
  let ok = true
  if (typeof condition !== 'string' || condition.length === 0) {
    issues.push({
      path: joinPath(path, 'condition'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'branch.condition is required (non-empty string)',
    })
    ok = false
  }
  const thenBody = validateNodeArray(obj['then'], joinPath(path, 'then'), issues)
  if (thenBody === null) return null
  if (thenBody.length === 0) {
    issues.push({
      path,
      code: 'EMPTY_BODY',
      message: 'branch.then must contain at least one node',
    })
  }
  let elseBody: FlowNode[] | undefined
  if ('else' in obj && obj['else'] !== undefined) {
    const maybeElse = validateNodeArray(obj['else'], joinPath(path, 'else'), issues)
    if (maybeElse !== null) elseBody = maybeElse
  }
  if (!ok) return null
  const node: FlowNode = {
    type: 'branch',
    ...common,
    condition: condition as string,
    then: thenBody,
  }
  if (elseBody !== undefined) node.else = elseBody
  return node
}

function validateApproval(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const question = obj['question']
  let ok = true
  if (typeof question !== 'string' || question.length === 0) {
    issues.push({
      path: joinPath(path, 'question'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'approval.question is required (non-empty string)',
    })
    ok = false
  }
  const onApprove = validateNodeArray(obj['onApprove'], joinPath(path, 'onApprove'), issues)
  if (onApprove === null) return null
  if (onApprove.length === 0) {
    issues.push({
      path,
      code: 'EMPTY_BODY',
      message: 'approval.onApprove must contain at least one node',
    })
  }
  let options: string[] | undefined
  if ('options' in obj && obj['options'] !== undefined) {
    const raw = obj['options']
    if (Array.isArray(raw) && raw.every((v): v is string => typeof v === 'string')) {
      options = raw
    } else {
      issues.push({
        path: joinPath(path, 'options'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'approval.options must be an array of strings when present',
      })
    }
  }
  let onReject: FlowNode[] | undefined
  if ('onReject' in obj && obj['onReject'] !== undefined) {
    const rej = validateNodeArray(obj['onReject'], joinPath(path, 'onReject'), issues)
    if (rej !== null) onReject = rej
  }
  if (!ok) return null
  const node: FlowNode = {
    type: 'approval',
    ...common,
    question: question as string,
    onApprove,
  }
  if (options !== undefined) node.options = options
  if (onReject !== undefined) node.onReject = onReject
  return node
}

function validateClarification(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const question = obj['question']
  if (typeof question !== 'string' || question.length === 0) {
    issues.push({
      path: joinPath(path, 'question'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'clarification.question is required (non-empty string)',
    })
    return null
  }
  let expected: 'text' | 'choice' | undefined
  if ('expected' in obj && obj['expected'] !== undefined) {
    const e = obj['expected']
    if (e === 'text' || e === 'choice') expected = e
    else {
      issues.push({
        path: joinPath(path, 'expected'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `clarification.expected must be "text" or "choice", received ${describeJsType(e)}`,
      })
    }
  }
  let choices: string[] | undefined
  if ('choices' in obj && obj['choices'] !== undefined) {
    const c = obj['choices']
    if (Array.isArray(c) && c.every((v): v is string => typeof v === 'string')) {
      choices = c
    } else {
      issues.push({
        path: joinPath(path, 'choices'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'clarification.choices must be an array of strings when present',
      })
    }
  }
  if (expected === 'choice' && (choices === undefined || choices.length === 0)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: "clarification.choices is required (non-empty array) when expected='choice'",
    })
  }
  const node: FlowNode = { type: 'clarification', ...common, question }
  if (expected !== undefined) node.expected = expected
  if (choices !== undefined) node.choices = choices
  return node
}

function validatePersona(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const personaId = obj['personaId']
  let ok = true
  if (typeof personaId !== 'string' || personaId.length === 0) {
    issues.push({
      path: joinPath(path, 'personaId'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'persona.personaId is required (non-empty string)',
    })
    ok = false
  }
  const body = validateNodeArray(obj['body'], joinPath(path, 'body'), issues)
  if (body === null) return null
  if (body.length === 0) {
    issues.push({
      path,
      code: 'EMPTY_BODY',
      message: 'persona.body must contain at least one node',
    })
  }
  if (!ok) return null
  return { type: 'persona', ...common, personaId: personaId as string, body }
}

function validateRoute(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const strategy = obj['strategy']
  let ok = true
  if (strategy !== 'capability' && strategy !== 'fixed-provider') {
    issues.push({
      path: joinPath(path, 'strategy'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `route.strategy must be "capability" or "fixed-provider", received ${describeJsType(strategy)}`,
    })
    ok = false
  }
  const body = validateNodeArray(obj['body'], joinPath(path, 'body'), issues)
  if (body === null) return null
  if (body.length === 0) {
    issues.push({
      path,
      code: 'EMPTY_BODY',
      message: 'route.body must contain at least one node',
    })
  }
  let tags: string[] | undefined
  if ('tags' in obj && obj['tags'] !== undefined) {
    const t = obj['tags']
    if (Array.isArray(t) && t.every((v): v is string => typeof v === 'string')) {
      tags = t
    } else {
      issues.push({
        path: joinPath(path, 'tags'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'route.tags must be an array of strings when present',
      })
    }
  }
  let provider: string | undefined
  if ('provider' in obj && obj['provider'] !== undefined) {
    const p = obj['provider']
    if (typeof p === 'string') provider = p
    else {
      issues.push({
        path: joinPath(path, 'provider'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `route.provider must be a string when present, received ${describeJsType(p)}`,
      })
    }
  }
  if (strategy === 'fixed-provider' && (provider === undefined || provider.length === 0)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: "route.provider is required (non-empty string) when strategy='fixed-provider'",
    })
  }
  if (strategy === 'capability' && (tags === undefined || tags.length === 0)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: "route.tags is required (non-empty array) when strategy='capability'",
    })
  }
  if (!ok) return null
  const node: FlowNode = {
    type: 'route',
    ...common,
    strategy: strategy as 'capability' | 'fixed-provider',
    body,
  }
  if (tags !== undefined) node.tags = tags
  if (provider !== undefined) node.provider = provider
  return node
}

function validateParallel(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const branchesRaw = obj['branches']
  if (!Array.isArray(branchesRaw)) {
    issues.push({
      path: joinPath(path, 'branches'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `parallel.branches must be an array, received ${describeJsType(branchesRaw)}`,
    })
    return null
  }
  if (branchesRaw.length === 0) {
    issues.push({
      path,
      code: 'EMPTY_BODY',
      message: 'parallel.branches must contain at least one branch',
    })
  }
  const branches: FlowNode[][] = []
  for (let i = 0; i < branchesRaw.length; i++) {
    const branchPath = `${joinPath(path, 'branches')}[${i}]`
    const branchVal = branchesRaw[i]
    const branch = validateNodeArray(branchVal, branchPath, issues)
    if (branch === null) continue
    if (branch.length === 0) {
      issues.push({
        path: branchPath,
        code: 'EMPTY_BODY',
        message: 'parallel.branches[*] must contain at least one node',
      })
    }
    branches.push(branch)
  }
  return { type: 'parallel', ...common, branches }
}

function validateComplete(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  let result: string | undefined
  if ('result' in obj && obj['result'] !== undefined) {
    const r = obj['result']
    if (typeof r === 'string') result = r
    else {
      issues.push({
        path: joinPath(path, 'result'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `complete.result must be a string when present, received ${describeJsType(r)}`,
      })
    }
  }
  const node: FlowNode = { type: 'complete', ...common }
  if (result !== undefined) node.result = result
  return node
}

function validateSpawn(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const templateRef = obj['templateRef']
  if (typeof templateRef !== 'string' || templateRef.length === 0) {
    issues.push({
      path: joinPath(path, 'templateRef'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'spawn.templateRef is required (non-empty string)',
    })
    return null
  }
  let input: Record<string, unknown> | undefined
  if ('input' in obj && obj['input'] !== undefined) {
    if (isPlainObject(obj['input'])) input = obj['input']
    else {
      issues.push({
        path: joinPath(path, 'input'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `spawn.input must be an object when present, received ${describeJsType(obj['input'])}`,
      })
    }
  }
  let waitForCompletion: boolean | undefined
  if ('waitForCompletion' in obj && obj['waitForCompletion'] !== undefined) {
    if (typeof obj['waitForCompletion'] === 'boolean') waitForCompletion = obj['waitForCompletion']
    else {
      issues.push({
        path: joinPath(path, 'waitForCompletion'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `spawn.waitForCompletion must be a boolean when present, received ${describeJsType(obj['waitForCompletion'])}`,
      })
    }
  }
  const node: FlowNode = { type: 'spawn', ...common, templateRef }
  if (input !== undefined) node.input = input
  if (waitForCompletion !== undefined) node.waitForCompletion = waitForCompletion
  return node
}

function validateClassify(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const prompt = obj['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0) {
    issues.push({
      path: joinPath(path, 'prompt'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'classify.prompt is required (non-empty string)',
    })
    return null
  }
  const choices = obj['choices']
  if (!Array.isArray(choices) || choices.length === 0 || !choices.every((c) => typeof c === 'string')) {
    issues.push({
      path: joinPath(path, 'choices'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'classify.choices is required (non-empty string array)',
    })
    return null
  }
  const outputKey = obj['outputKey']
  if (typeof outputKey !== 'string' || outputKey.length === 0) {
    issues.push({
      path: joinPath(path, 'outputKey'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'classify.outputKey is required (non-empty string)',
    })
    return null
  }
  return { type: 'classify', ...common, prompt, choices: choices as string[], outputKey }
}

function validateMemory(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): MemoryNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const operation = obj['operation']
  if (operation !== 'read' && operation !== 'write' && operation !== 'list') {
    issues.push({
      path: joinPath(path, 'operation'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'memory.operation must be "read", "write", or "list"',
    })
    return null
  }
  const tier = obj['tier']
  if (tier !== 'session' && tier !== 'project' && tier !== 'workspace') {
    issues.push({
      path: joinPath(path, 'tier'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'memory.tier must be "session", "project", or "workspace"',
    })
    return null
  }
  const node: MemoryNode = {
    type: 'memory',
    ...common,
    operation: operation as 'read' | 'write' | 'list',
    tier: tier as 'session' | 'project' | 'workspace',
  }
  if ('key' in obj && typeof obj['key'] === 'string') node.key = obj['key']
  if ('valueExpr' in obj && typeof obj['valueExpr'] === 'string') node.valueExpr = obj['valueExpr']
  if ('outputVar' in obj && typeof obj['outputVar'] === 'string') node.outputVar = obj['outputVar']
  return node
}

function validateEmit(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): EmitNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const event = obj['event']
  if (typeof event !== 'string' || event.length === 0) {
    issues.push({
      path: joinPath(path, 'event'),
      code: 'MISSING_REQUIRED_FIELD',
      message: '`event` is required and must be a non-empty string',
    })
    return null
  }
  let payload: Record<string, unknown> | undefined
  if ('payload' in obj && obj['payload'] !== undefined) {
    if (isPlainObject(obj['payload'])) {
      payload = obj['payload']
    } else {
      issues.push({
        path: joinPath(path, 'payload'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'emit.payload must be an object when present',
      })
    }
  }
  const node: EmitNode = { type: 'emit', ...common, event }
  if (payload !== undefined) node.payload = payload
  return node
}

function validateCheckpoint(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): CheckpointNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const captureOutputOf = obj['captureOutputOf']
  if (typeof captureOutputOf !== 'string' || captureOutputOf.length === 0) {
    issues.push({
      path: joinPath(path, 'captureOutputOf'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'checkpoint.captureOutputOf is required (non-empty string)',
    })
    return null
  }
  let label: string | undefined
  if ('label' in obj && obj['label'] !== undefined) {
    const l = obj['label']
    if (typeof l === 'string') label = l
    else {
      issues.push({
        path: joinPath(path, 'label'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `checkpoint.label must be a string when present, received ${describeJsType(l)}`,
      })
    }
  }
  const node: CheckpointNode = { type: 'checkpoint', ...common, captureOutputOf }
  if (label !== undefined) node.label = label
  return node
}

function validateRestore(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): RestoreNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const checkpointLabel = obj['checkpointLabel']
  if (typeof checkpointLabel !== 'string' || checkpointLabel.length === 0) {
    issues.push({
      path: joinPath(path, 'checkpointLabel'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'restore.checkpointLabel is required (non-empty string)',
    })
    return null
  }
  let onNotFound: 'fail' | 'skip' | undefined
  if ('onNotFound' in obj && obj['onNotFound'] !== undefined) {
    const v = obj['onNotFound']
    if (v === 'fail' || v === 'skip') onNotFound = v
    else {
      issues.push({
        path: joinPath(path, 'onNotFound'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `restore.onNotFound must be "fail" or "skip" when present, received ${describeJsType(v) === 'string' ? JSON.stringify(v) : describeJsType(v)}`,
      })
      return null
    }
  }
  const node: RestoreNode = { type: 'restore', ...common, checkpointLabel }
  if (onNotFound !== undefined) node.onNotFound = onNotFound
  return node
}

// ---------------------------------------------------------------------------
// FlowEdge walker
// ---------------------------------------------------------------------------

function validateFlowEdge(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): FlowEdge | null {
  if (!isPlainObject(value)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: `Expected edge object, received ${describeJsType(value)}`,
    })
    return null
  }
  const from = value['from']
  const to = value['to']
  let ok = true
  if (typeof from !== 'string' || from.length === 0) {
    issues.push({
      path: joinPath(path, 'from'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'edge.from is required (non-empty string)',
    })
    ok = false
  }
  if (typeof to !== 'string' || to.length === 0) {
    issues.push({
      path: joinPath(path, 'to'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'edge.to is required (non-empty string)',
    })
    ok = false
  }
  let kind: string | undefined
  if ('kind' in value && value['kind'] !== undefined) {
    const k = value['kind']
    if (typeof k === 'string') kind = k
    else {
      issues.push({
        path: joinPath(path, 'kind'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `edge.kind must be a string when present, received ${describeJsType(k)}`,
      })
    }
  }
  let condition: string | undefined
  if ('condition' in value && value['condition'] !== undefined) {
    const c = value['condition']
    if (typeof c === 'string') condition = c
    else {
      issues.push({
        path: joinPath(path, 'condition'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `edge.condition must be a string when present, received ${describeJsType(c)}`,
      })
    }
  }
  if (!ok) return null
  const edge: FlowEdge = { from: from as string, to: to as string }
  if (kind !== undefined) edge.kind = kind
  if (condition !== undefined) edge.condition = condition
  return edge
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateCommonNodeFields(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): {
  id?: string
  name?: string
  description?: string
  meta?: Record<string, unknown>
} {
  const fields: {
    id?: string
    name?: string
    description?: string
    meta?: Record<string, unknown>
  } = {}

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

function validateOptionalStringField(
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

function validateOptionalStringArrayField(
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

function validateOptionalObjectField(
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

function validateOptionalInputs(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowDocumentV1['inputs'] | undefined {
  if (!('inputs' in obj) || obj['inputs'] === undefined) return undefined
  const value = obj['inputs']
  if (!isPlainObject(value)) {
    issues.push({
      path: joinPath(path, 'inputs'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `document.inputs must be an object when present, received ${describeJsType(value)}`,
    })
    return undefined
  }

  const inputs: NonNullable<FlowDocumentV1['inputs']> = {}
  for (const [key, rawSpec] of Object.entries(value)) {
    if (!isPlainObject(rawSpec)) {
      issues.push({
        path: joinPath(joinPath(path, 'inputs'), key),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'input spec must be an object',
      })
      continue
    }

    const type = rawSpec['type']
    if (
      type !== 'string'
      && type !== 'number'
      && type !== 'boolean'
      && type !== 'object'
      && type !== 'array'
      && type !== 'any'
    ) {
      issues.push({
        path: joinPath(joinPath(joinPath(path, 'inputs'), key), 'type'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'input spec.type must be one of string|number|boolean|object|array|any',
      })
      continue
    }

    const spec: NonNullable<FlowDocumentV1['inputs']>[string] = { type }
    if ('required' in rawSpec && rawSpec['required'] !== undefined) {
      if (typeof rawSpec['required'] === 'boolean') spec.required = rawSpec['required']
      else {
        issues.push({
          path: joinPath(joinPath(joinPath(path, 'inputs'), key), 'required'),
          code: 'MISSING_REQUIRED_FIELD',
          message: 'input spec.required must be a boolean when present',
        })
      }
    }
    if ('description' in rawSpec && rawSpec['description'] !== undefined) {
      if (typeof rawSpec['description'] === 'string') spec.description = rawSpec['description']
      else {
        issues.push({
          path: joinPath(joinPath(joinPath(path, 'inputs'), key), 'description'),
          code: 'MISSING_REQUIRED_FIELD',
          message: 'input spec.description must be a string when present',
        })
      }
    }
    if ('default' in rawSpec && rawSpec['default'] !== undefined) {
      if (isFlowValue(rawSpec['default'])) {
        spec.default = rawSpec['default']
      } else {
        issues.push({
          path: joinPath(joinPath(joinPath(path, 'inputs'), key), 'default'),
          code: 'MISSING_REQUIRED_FIELD',
          message: 'input spec.default must be a JSON-like value when present',
        })
      }
    }
    inputs[key] = spec
  }
  return inputs
}

function validateOptionalDefaults(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowDocumentV1['defaults'] | undefined {
  if (!('defaults' in obj) || obj['defaults'] === undefined) return undefined
  const value = obj['defaults']
  if (!isPlainObject(value)) {
    issues.push({
      path: joinPath(path, 'defaults'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `document.defaults must be an object when present, received ${describeJsType(value)}`,
    })
    return undefined
  }

  const defaults: NonNullable<FlowDocumentV1['defaults']> = {}
  if ('personaRef' in value && value['personaRef'] !== undefined) {
    if (typeof value['personaRef'] === 'string') defaults.personaRef = value['personaRef']
    else {
      issues.push({
        path: joinPath(joinPath(path, 'defaults'), 'personaRef'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'defaults.personaRef must be a string when present',
      })
    }
  }
  if ('timeoutMs' in value && value['timeoutMs'] !== undefined) {
    if (typeof value['timeoutMs'] === 'number' && Number.isFinite(value['timeoutMs']) && value['timeoutMs'] > 0) {
      defaults.timeoutMs = value['timeoutMs']
    } else {
      issues.push({
        path: joinPath(joinPath(path, 'defaults'), 'timeoutMs'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'defaults.timeoutMs must be a positive number when present',
      })
    }
  }
  if ('retry' in value && value['retry'] !== undefined) {
    const retry = value['retry']
    if (isPlainObject(retry)) {
      const attempts = retry['attempts']
      if (typeof attempts === 'number' && Number.isInteger(attempts) && attempts > 0) {
        defaults.retry = { attempts }
        const delayMs = retry['delayMs']
        if (delayMs !== undefined) {
          if (typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs >= 0) {
            defaults.retry.delayMs = delayMs
          } else {
            issues.push({
              path: joinPath(joinPath(joinPath(path, 'defaults'), 'retry'), 'delayMs'),
              code: 'MISSING_REQUIRED_FIELD',
              message: 'defaults.retry.delayMs must be a non-negative number when present',
            })
          }
        }
      } else {
        issues.push({
          path: joinPath(joinPath(joinPath(path, 'defaults'), 'retry'), 'attempts'),
          code: 'MISSING_REQUIRED_FIELD',
          message: 'defaults.retry.attempts must be a positive integer',
        })
      }
    } else {
      issues.push({
        path: joinPath(joinPath(path, 'defaults'), 'retry'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'defaults.retry must be an object when present',
      })
    }
  }

  return Object.keys(defaults).length > 0 ? defaults : {}
}

function validateCanonicalNodeIds(
  node: FlowNode,
  path: string,
  issues: SchemaIssue[],
  seen: Map<string, string>,
): void {
  if (typeof node.id !== 'string' || node.id.length === 0) {
    issues.push({
      path: joinPath(path, 'id'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'canonical document nodes must define a non-empty id',
    })
  } else {
    const priorPath = seen.get(node.id)
    if (priorPath !== undefined) {
      issues.push({
        path: joinPath(path, 'id'),
        code: 'DUPLICATE_NODE_ID',
        message: `duplicate node id "${node.id}" first seen at ${priorPath}`,
      })
    } else {
      seen.set(node.id, path)
    }
  }

  switch (node.type) {
    case 'sequence':
      node.nodes.forEach((child, index) => {
        validateCanonicalNodeIds(child, `${joinPath(path, 'nodes')}[${index}]`, issues, seen)
      })
      return
    case 'for_each':
      node.body.forEach((child, index) => {
        validateCanonicalNodeIds(child, `${joinPath(path, 'body')}[${index}]`, issues, seen)
      })
      return
    case 'branch':
      node.then.forEach((child, index) => {
        validateCanonicalNodeIds(child, `${joinPath(path, 'then')}[${index}]`, issues, seen)
      })
      node.else?.forEach((child, index) => {
        validateCanonicalNodeIds(child, `${joinPath(path, 'else')}[${index}]`, issues, seen)
      })
      return
    case 'approval':
      node.onApprove.forEach((child, index) => {
        validateCanonicalNodeIds(child, `${joinPath(path, 'onApprove')}[${index}]`, issues, seen)
      })
      node.onReject?.forEach((child, index) => {
        validateCanonicalNodeIds(child, `${joinPath(path, 'onReject')}[${index}]`, issues, seen)
      })
      return
    case 'persona':
    case 'route':
      node.body.forEach((child, index) => {
        validateCanonicalNodeIds(child, `${joinPath(path, 'body')}[${index}]`, issues, seen)
      })
      return
    case 'parallel':
      node.branches.forEach((branch, branchIndex) => {
        branch.forEach((child, childIndex) => {
          validateCanonicalNodeIds(
            child,
            `${joinPath(path, 'branches')}[${branchIndex}][${childIndex}]`,
            issues,
            seen,
          )
        })
      })
      return
    case 'action':
    case 'clarification':
    case 'complete':
    case 'spawn':
    case 'classify':
    case 'emit':
    case 'memory':
    case 'checkpoint':
    case 'restore':
      return
    default: {
      const _exhaustive: never = node
      void _exhaustive
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isFlowValue(value: unknown): value is FlowValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return true
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isFlowValue(entry))
  }

  if (isPlainObject(value)) {
    return Object.values(value).every((entry) => isFlowValue(entry))
  }

  return false
}

function describeJsType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function joinPath(base: string, segment: string): string {
  return `${base}.${segment}`
}
