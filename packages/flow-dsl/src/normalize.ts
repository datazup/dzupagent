import type {
  ActionNode,
  ApprovalNode,
  BranchNode,
  CheckpointNode,
  ClarificationNode,
  CompleteNode,
  FlowDocumentV1,
  FlowInputSpec,
  FlowNode,
  FlowNodeBase,
  FlowValue,
  ForEachNode,
  ParallelNode,
  PersonaNode,
  RestoreNode,
  RouteNode,
  SequenceNode,
} from '@dzupagent/flow-ast'

import { DSL_ERROR } from './errors.js'
import type { DslDiagnostic } from './types.js'

const TOP_LEVEL_KEYS = new Set([
  'dsl',
  'id',
  'title',
  'description',
  'version',
  'inputs',
  'defaults',
  'tags',
  'meta',
  'steps',
])

const COMMON_NODE_KEYS = ['id', 'name', 'description', 'meta'] as const

const ACTION_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'ref',
  'toolRef',
  'persona',
  'personaRef',
  'input',
])

const IF_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'condition',
  'then',
  'else',
])

const PARALLEL_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'branches',
])

const FOR_EACH_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'source',
  'as',
  'body',
])

const APPROVAL_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'question',
  'options',
  'on_approve',
  'onApprove',
  'on_reject',
  'onReject',
])

const CLARIFY_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'question',
  'expected',
  'choices',
])

const PERSONA_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'ref',
  'personaId',
  'body',
])

const ROUTE_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'strategy',
  'provider',
  'tags',
  'body',
])

const COMPLETE_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'result',
])

const CHECKPOINT_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'captureOutputOf',
  'label',
])

const RESTORE_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'checkpointLabel',
  'onNotFound',
])

const DEFAULT_KEYS = new Set<string>([
  'persona',
  'personaRef',
  'timeout_ms',
  'timeoutMs',
  'retry',
])

const INPUT_SPEC_KEYS = new Set<string>([
  'type',
  'required',
  'description',
  'default',
])

export function normalizeDslDocument(raw: unknown): {
  document: FlowDocumentV1 | null
  diagnostics: DslDiagnostic[]
} {
  const diagnostics: DslDiagnostic[] = []
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_TOP_LEVEL_SHAPE,
      message: 'Top-level dzupflow document must be an object',
      path: 'root',
    })
    return { document: null, diagnostics }
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      const message = key === 'nodes' || key === 'edges'
        ? `Graph-style top-level field "${key}" is not supported in dzupflow/v1; use "steps" authoring form instead`
        : `Unsupported top-level field "${key}"`
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.UNSUPPORTED_FIELD,
        message,
        path: `root.${key}`,
        ...(key === 'nodes' || key === 'edges'
          ? { suggestion: 'Replace graph-style nodes/edges input with dzupflow/v1 steps.' }
          : {}),
      })
    }
  }

  const stepsRaw = raw.steps
  const steps = normalizeSteps(stepsRaw, 'root.steps', diagnostics)

  const inputs = normalizeInputs(raw.inputs, diagnostics)
  const defaults = normalizeDefaults(raw.defaults, diagnostics)
  const tags = normalizeStringArray(raw.tags, 'root.tags', diagnostics)
  const meta = normalizeObject(raw.meta, 'root.meta', diagnostics)

  const doc: FlowDocumentV1 = {
    dsl: raw.dsl === 'dzupflow/v1' ? 'dzupflow/v1' : 'dzupflow/v1',
    id: typeof raw.id === 'string' ? raw.id : '',
    version: typeof raw.version === 'number' ? raw.version : 0,
    root: {
      type: 'sequence',
      id: 'root',
      nodes: steps,
    },
  }

  if (typeof raw.title === 'string') doc.title = raw.title
  if (typeof raw.description === 'string') doc.description = raw.description
  if (inputs !== undefined) doc.inputs = inputs
  if (defaults !== undefined) doc.defaults = defaults
  if (tags !== undefined) doc.tags = tags
  if (meta !== undefined) doc.meta = meta
  if (raw.version !== undefined && raw.version !== 1) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_ENUM_VALUE,
      message: 'version must equal 1 for dzupflow/v1',
      path: 'root.version',
    })
  }
  return { document: doc, diagnostics }
}

export function normalizeSteps(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): FlowNode[] {
  if (!Array.isArray(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'steps must be an array',
      path,
    })
    return []
  }
  const nodes: FlowNode[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const node = normalizeNodeWrapper(raw[i], `${path}[${i}]`, diagnostics)
    if (node) nodes.push(node)
  }
  return nodes
}

function normalizeNodeWrapper(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): FlowNode | null {
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'step item must be an object wrapper',
      path,
    })
    return null
  }

  const keys = Object.keys(raw)
  if (keys.length !== 1) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'each step item must contain exactly one node wrapper key',
      path,
    })
    return null
  }

  const kind = keys[0]!
  const value = raw[kind]
  if (!isPlainObject(value)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: `node wrapper "${kind}" must contain an object`,
      path,
    })
    return null
  }

  switch (kind) {
    case 'action':
      return normalizeAction(value, path, diagnostics)
    case 'if':
      return normalizeIf(value, path, diagnostics)
    case 'parallel':
      return normalizeParallel(value, path, diagnostics)
    case 'for_each':
      return normalizeForEach(value, path, diagnostics)
    case 'approval':
      return normalizeApproval(value, path, diagnostics)
    case 'clarify':
      return normalizeClarify(value, path, diagnostics)
    case 'persona':
      return normalizePersona(value, path, diagnostics)
    case 'route':
      return normalizeRoute(value, path, diagnostics)
    case 'complete':
      return normalizeComplete(value, path, diagnostics)
    case 'checkpoint':
      return normalizeCheckpoint(value, path, diagnostics)
    case 'restore':
      return normalizeRestore(value, path, diagnostics)
    default:
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.UNKNOWN_NODE_TYPE,
        message: `Unknown node type "${kind}"`,
        path,
      })
      return null
  }
}

function normalizeCommonNodeFields(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): FlowNodeBase {
  const base: FlowNodeBase = {}
  if (typeof raw.id === 'string') base.id = raw.id
  else if ('id' in raw) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'node id must be a string',
      path: `${path}.id`,
    })
  }
  if (typeof raw.name === 'string') base.name = raw.name
  if (typeof raw.description === 'string') base.description = raw.description
  if (raw.meta !== undefined) {
    const meta = normalizeObject(raw.meta, `${path}.meta`, diagnostics)
    if (meta !== undefined) base.meta = meta
  }
  return base
}

function normalizeAction(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): ActionNode {
  reportUnsupportedFields(raw, ACTION_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)
  const input = normalizeObject(raw.input, `${path}.input`, diagnostics) ?? {}
  const node: ActionNode = {
    type: 'action',
    ...base,
    toolRef: typeof raw.ref === 'string' ? raw.ref : typeof raw.toolRef === 'string' ? raw.toolRef : '',
    input,
  }
  if (typeof raw.persona === 'string') node.personaRef = raw.persona
  else if (typeof raw.personaRef === 'string') node.personaRef = raw.personaRef
  if (node.toolRef.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'action.ref is required',
      path: `${path}.ref`,
    })
  }
  return node
}

function normalizeIf(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): BranchNode {
  reportUnsupportedFields(raw, IF_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)
  const node: BranchNode = {
    type: 'branch',
    ...base,
    condition: typeof raw.condition === 'string' ? raw.condition : '',
    then: normalizeSteps(raw.then, `${path}.then`, diagnostics),
    else: raw.else !== undefined ? normalizeSteps(raw.else, `${path}.else`, diagnostics) : undefined,
  }
  if (node.condition.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'if.condition is required',
      path: `${path}.condition`,
    })
  }
  if (node.then.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.EMPTY_BRANCH_BODY,
      message: 'if.then must contain at least one step',
      path: `${path}.then`,
    })
  }
  return node
}

function normalizeParallel(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): ParallelNode {
  reportUnsupportedFields(raw, PARALLEL_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)
  const branchesRaw = raw.branches
  const branches: FlowNode[][] = []
  const branchNames: string[] = []

  if (!isPlainObject(branchesRaw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'parallel.branches must be an object of named branches',
      path: `${path}.branches`,
    })
  } else {
    for (const [name, branchValue] of Object.entries(branchesRaw)) {
      branchNames.push(name)
      const branchSteps = normalizeSteps(branchValue, `${path}.branches.${name}`, diagnostics)
      if (branchSteps.length === 0) {
        diagnostics.push({
          phase: 'normalize',
          code: DSL_ERROR.EMPTY_BRANCH_BODY,
          message: `parallel branch "${name}" must contain at least one step`,
          path: `${path}.branches.${name}`,
        })
      }
      branches.push(branchSteps)
    }
    if (branchNames.length < 2) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: 'parallel.branches must define at least two named branches',
        path: `${path}.branches`,
      })
    }
  }

  const meta = { ...(base.meta ?? {}), branchNames }
  return {
    type: 'parallel',
    ...base,
    meta,
    branches,
  }
}

function normalizeForEach(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): ForEachNode {
  reportUnsupportedFields(raw, FOR_EACH_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)
  const node: ForEachNode = {
    type: 'for_each',
    ...base,
    source: typeof raw.source === 'string' ? raw.source : '',
    as: typeof raw.as === 'string' ? raw.as : '',
    body: normalizeSteps(raw.body, `${path}.body`, diagnostics),
  }
  if (node.source.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'for_each.source is required',
      path: `${path}.source`,
    })
  }
  if (node.as.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'for_each.as is required',
      path: `${path}.as`,
    })
  }
  if (node.body.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.EMPTY_BRANCH_BODY,
      message: 'for_each.body must contain at least one step',
      path: `${path}.body`,
    })
  }
  return node
}

function normalizeApproval(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): ApprovalNode {
  reportUnsupportedFields(raw, APPROVAL_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)
  const options = normalizeStringArray(raw.options, `${path}.options`, diagnostics)
  const node: ApprovalNode = {
    type: 'approval',
    ...base,
    question: typeof raw.question === 'string' ? raw.question : '',
    onApprove: normalizeSteps(raw.on_approve ?? raw.onApprove, `${path}.on_approve`, diagnostics),
  }
  if (options !== undefined) node.options = options
  if (node.question.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'approval.question is required',
      path: `${path}.question`,
    })
  }
  if (node.onApprove.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.EMPTY_BRANCH_BODY,
      message: 'approval.on_approve must contain at least one step',
      path: `${path}.on_approve`,
    })
  }
  if (raw.on_reject !== undefined || raw.onReject !== undefined) {
    node.onReject = normalizeSteps(raw.on_reject ?? raw.onReject, `${path}.on_reject`, diagnostics)
    if (node.onReject.length === 0) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.EMPTY_BRANCH_BODY,
        message: 'approval.on_reject must contain at least one step when present',
        path: `${path}.on_reject`,
      })
    }
  }
  return node
}

function normalizeClarify(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): ClarificationNode {
  reportUnsupportedFields(raw, CLARIFY_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)
  const node: ClarificationNode = {
    type: 'clarification',
    ...base,
    question: typeof raw.question === 'string' ? raw.question : '',
  }
  if (node.question.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'clarify.question is required',
      path: `${path}.question`,
    })
  }
  if (raw.expected === 'text' || raw.expected === 'choice') {
    node.expected = raw.expected
  } else if (raw.expected !== undefined) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_ENUM_VALUE,
      message: 'clarify.expected must be "text" or "choice"',
      path: `${path}.expected`,
    })
  }
  const choices = normalizeStringArray(raw.choices, `${path}.choices`, diagnostics)
  if (choices !== undefined) node.choices = choices
  return node
}

function normalizePersona(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): PersonaNode {
  reportUnsupportedFields(raw, PERSONA_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)
  const node: PersonaNode = {
    type: 'persona',
    ...base,
    personaId: typeof raw.ref === 'string' ? raw.ref : typeof raw.personaId === 'string' ? raw.personaId : '',
    body: normalizeSteps(raw.body, `${path}.body`, diagnostics),
  }
  if (node.personaId.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'persona.ref is required',
      path: `${path}.ref`,
    })
  }
  if (node.body.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.EMPTY_BRANCH_BODY,
      message: 'persona.body must contain at least one step',
      path: `${path}.body`,
    })
  }
  return node
}

function normalizeRoute(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): RouteNode {
  reportUnsupportedFields(raw, ROUTE_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)
  const node: RouteNode = {
    type: 'route',
    ...base,
    strategy: raw.strategy === 'capability' || raw.strategy === 'fixed-provider' ? raw.strategy : 'capability',
    body: normalizeSteps(raw.body, `${path}.body`, diagnostics),
  }
  const tags = normalizeStringArray(raw.tags, `${path}.tags`, diagnostics)
  if (tags !== undefined) node.tags = tags
  if (typeof raw.provider === 'string') node.provider = raw.provider
  if (!(raw.strategy === 'capability' || raw.strategy === 'fixed-provider')) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_ENUM_VALUE,
      message: 'route.strategy must be "capability" or "fixed-provider"',
      path: `${path}.strategy`,
    })
  }
  if (node.body.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.EMPTY_BRANCH_BODY,
      message: 'route.body must contain at least one step',
      path: `${path}.body`,
    })
  }
  return node
}

function normalizeComplete(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): CompleteNode {
  reportUnsupportedFields(raw, COMPLETE_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)
  const node: CompleteNode = {
    type: 'complete',
    ...base,
  }
  if (raw.result !== undefined) {
    if (typeof raw.result === 'string') {
      node.result = raw.result
    } else {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: 'complete.result must be a string in v1',
        path: `${path}.result`,
      })
    }
  }
  return node
}

function normalizeCheckpoint(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): CheckpointNode {
  reportUnsupportedFields(raw, CHECKPOINT_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)
  const node: CheckpointNode = {
    type: 'checkpoint',
    ...base,
    captureOutputOf: typeof raw.captureOutputOf === 'string' ? raw.captureOutputOf : '',
  }
  if (typeof raw.label === 'string') node.label = raw.label
  else if (raw.label !== undefined) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'checkpoint.label must be a string',
      path: `${path}.label`,
    })
  }
  if (node.captureOutputOf.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'checkpoint.captureOutputOf is required',
      path: `${path}.captureOutputOf`,
    })
  }
  return node
}

function normalizeRestore(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): RestoreNode {
  reportUnsupportedFields(raw, RESTORE_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)
  const node: RestoreNode = {
    type: 'restore',
    ...base,
    checkpointLabel: typeof raw.checkpointLabel === 'string' ? raw.checkpointLabel : '',
  }
  if (raw.onNotFound === 'fail' || raw.onNotFound === 'skip') {
    node.onNotFound = raw.onNotFound
  } else if (raw.onNotFound !== undefined) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_ENUM_VALUE,
      message: 'restore.onNotFound must be "fail" or "skip"',
      path: `${path}.onNotFound`,
    })
  }
  if (node.checkpointLabel.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'restore.checkpointLabel is required',
      path: `${path}.checkpointLabel`,
    })
  }
  return node
}

function normalizeInputs(
  raw: unknown,
  diagnostics: DslDiagnostic[],
): Record<string, FlowInputSpec> | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_INPUT_SPEC,
      message: 'inputs must be an object',
      path: 'root.inputs',
    })
    return undefined
  }

  const inputs: Record<string, FlowInputSpec> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      if (isInputType(value)) {
        inputs[key] = { type: value, required: true }
      } else {
        diagnostics.push({
          phase: 'normalize',
          code: DSL_ERROR.INVALID_INPUT_SPEC,
          message: `Unsupported input type "${value}"`,
          path: `root.inputs.${key}`,
        })
      }
      continue
    }
    if (!isPlainObject(value)) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_INPUT_SPEC,
        message: 'input spec must be a string shorthand or an object with a valid type',
        path: `root.inputs.${key}`,
      })
      continue
    }
    reportUnsupportedFields(value, INPUT_SPEC_KEYS, `root.inputs.${key}`, diagnostics)
    if (!isInputType(value.type)) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_INPUT_SPEC,
        message: 'input spec must be a string shorthand or an object with a valid type',
        path: `root.inputs.${key}`,
      })
      continue
    }
    inputs[key] = {
      type: value.type,
      ...(typeof value.required === 'boolean' ? { required: value.required } : {}),
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      ...(value.default !== undefined && isFlowValue(value.default)
        ? { default: value.default }
        : {}),
    }
    if (value.default !== undefined && !isFlowValue(value.default)) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_INPUT_SPEC,
        message: 'input spec.default must be a JSON-like value when present',
        path: `root.inputs.${key}.default`,
      })
    }
  }
  return inputs
}

function normalizeDefaults(
  raw: unknown,
  diagnostics: DslDiagnostic[],
): FlowDocumentV1['defaults'] | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_TOP_LEVEL_SHAPE,
      message: 'defaults must be an object',
      path: 'root.defaults',
    })
    return undefined
  }

  reportUnsupportedFields(raw, DEFAULT_KEYS, 'root.defaults', diagnostics)

  const defaults: NonNullable<FlowDocumentV1['defaults']> = {}
  if (typeof raw.persona === 'string') defaults.personaRef = raw.persona
  else if (typeof raw.personaRef === 'string') defaults.personaRef = raw.personaRef

  if (typeof raw.timeout_ms === 'number') defaults.timeoutMs = raw.timeout_ms
  else if (typeof raw.timeoutMs === 'number') defaults.timeoutMs = raw.timeoutMs

  if (isPlainObject(raw.retry) && typeof raw.retry.attempts === 'number') {
    defaults.retry = {
      attempts: raw.retry.attempts,
      ...(typeof raw.retry.delayMs === 'number' ? { delayMs: raw.retry.delayMs } : {}),
    }
  }
  return Object.keys(defaults).length > 0 ? defaults : {}
}

function normalizeObject(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'value must be an object',
      path,
    })
    return undefined
  }
  return raw
}

function normalizeStringArray(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): string[] | undefined {
  if (raw === undefined) return undefined
  if (Array.isArray(raw) && raw.every((v): v is string => typeof v === 'string')) {
    return raw
  }
  diagnostics.push({
    phase: 'normalize',
    code: DSL_ERROR.INVALID_NODE_SHAPE,
    message: 'value must be an array of strings',
    path,
  })
  return undefined
}

function isInputType(value: unknown): value is FlowInputSpec['type'] {
  return value === 'string'
    || value === 'number'
    || value === 'boolean'
    || value === 'object'
    || value === 'array'
    || value === 'any'
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function reportUnsupportedFields(
  raw: Record<string, unknown>,
  allowedKeys: Set<string>,
  path: string,
  diagnostics: DslDiagnostic[],
): void {
  for (const key of Object.keys(raw)) {
    if (allowedKeys.has(key)) continue
    const isOnError = key === 'on_error' || key === 'onError'
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.UNSUPPORTED_FIELD,
      message: isOnError
        ? `"${key}" is not supported in dzupflow/v1 yet`
        : `Unsupported field "${key}"`,
      path: `${path}.${key}`,
      ...(isOnError
        ? { suggestion: 'Model fallback or recovery explicitly with branch, approval, or future language support.' }
        : {}),
    })
  }
}
