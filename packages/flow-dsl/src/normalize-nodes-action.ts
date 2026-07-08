import type {
  ActionNode,
  ApprovalNode,
  BranchNode,
  ClarificationNode,
  FlowNode,
  ForEachNode,
  ParallelNode,
} from '@dzupagent/flow-ast'

import { DSL_ERROR } from './errors.js'
import {
  COMMON_NODE_KEYS,
  isPlainObject,
  normalizeCommonNodeFields,
  normalizeObject,
  normalizeStringArray,
  reportUnsupportedFields,
} from './normalize-value-helpers.js'
import type { DslDiagnostic } from './types.js'

type NormalizeSteps = (
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
) => FlowNode[]

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
  'attachAs',
  'collect',
  'accumulator',
  'concurrency',
  'failFast',
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

export function normalizeAction(
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

export function normalizeIf(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
  normalizeSteps: NormalizeSteps,
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

export function normalizeParallel(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
  normalizeSteps: NormalizeSteps,
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

export function normalizeForEach(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
  normalizeSteps: NormalizeSteps,
): ForEachNode {
  reportUnsupportedFields(raw, FOR_EACH_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)
  const collect = normalizeForEachCollect(raw.collect, `${path}.collect`, diagnostics)
  const accumulator = normalizeForEachAccumulator(
    raw.accumulator,
    `${path}.accumulator`,
    diagnostics,
  )
  const node: ForEachNode = {
    type: 'for_each',
    ...base,
    source: typeof raw.source === 'string' ? raw.source : '',
    as: typeof raw.as === 'string' ? raw.as : '',
    body: normalizeSteps(raw.body, `${path}.body`, diagnostics),
    ...(typeof raw.attachAs === 'string' ? { attachAs: raw.attachAs } : {}),
    ...(collect !== undefined ? { collect } : {}),
    ...(accumulator !== undefined ? { accumulator } : {}),
    ...(typeof raw.concurrency === 'number'
      ? { concurrency: Math.min(Math.max(1, Math.floor(raw.concurrency)), 8) }
      : {}),
    ...(typeof raw.failFast === 'boolean' ? { failFast: raw.failFast } : {}),
  }
  if (raw.attachAs !== undefined && typeof raw.attachAs !== 'string') {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'for_each.attachAs must be a string when present',
      path: `${path}.attachAs`,
    })
  }
  if (raw.concurrency !== undefined && typeof raw.concurrency !== 'number') {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'for_each.concurrency must be a number when present',
      path: `${path}.concurrency`,
    })
  }
  if (raw.failFast !== undefined && typeof raw.failFast !== 'boolean') {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'for_each.failFast must be a boolean when present',
      path: `${path}.failFast`,
    })
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

function normalizeForEachCollect(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): ForEachNode['collect'] | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'for_each.collect must be an object with from and into',
      path,
    })
    return undefined
  }
  if (typeof raw.from === 'string' && typeof raw.into === 'string') {
    return { from: raw.from, into: raw.into }
  }
  diagnostics.push({
    phase: 'normalize',
    code: DSL_ERROR.INVALID_NODE_SHAPE,
    message: 'for_each.collect.from and for_each.collect.into must be strings',
    path,
  })
  return undefined
}

function normalizeForEachAccumulator(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): ForEachNode['accumulator'] | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'for_each.accumulator must be an object with key',
      path,
    })
    return undefined
  }
  if (typeof raw.key !== 'string') {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'for_each.accumulator.key must be a string',
      path: `${path}.key`,
    })
    return undefined
  }
  if (raw.window !== undefined && typeof raw.window !== 'number') {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'for_each.accumulator.window must be a number when present',
      path: `${path}.window`,
    })
  }
  return {
    key: raw.key,
    ...(typeof raw.window === 'number' ? { window: Math.max(1, Math.floor(raw.window)) } : {}),
    ...(raw.initialValue !== undefined ? { initialValue: raw.initialValue } : {}),
  }
}

export function normalizeApproval(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
  normalizeSteps: NormalizeSteps,
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

export function normalizeClarify(
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
