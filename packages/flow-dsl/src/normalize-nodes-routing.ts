import type {
  CheckpointNode,
  ClassifyNode,
  CompleteNode,
  FlowNode,
  PersonaNode,
  RestoreNode,
  RouteNode,
} from '@dzupagent/flow-ast'

import { DSL_ERROR } from './errors.js'
import {
  COMMON_NODE_KEYS,
  normalizeCommonNodeFields,
  normalizeStringArray,
  reportUnsupportedFields,
} from './normalize-value-helpers.js'
import type { DslDiagnostic } from './types.js'

type NormalizeSteps = (
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
) => FlowNode[]

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

const CLASSIFY_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'prompt',
  'choices',
  'output',
  'outputKey',
  'default',
  'defaultChoice',
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

export function normalizePersona(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
  normalizeSteps: NormalizeSteps,
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

export function normalizeRoute(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
  normalizeSteps: NormalizeSteps,
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

export function normalizeComplete(
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

export function normalizeClassify(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): ClassifyNode {
  reportUnsupportedFields(raw, CLASSIFY_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)
  const choices = normalizeStringArray(raw.choices, `${path}.choices`, diagnostics) ?? []
  const node: ClassifyNode = {
    type: 'classify',
    ...base,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    choices,
    outputKey: typeof raw.output === 'string'
      ? raw.output
      : typeof raw.outputKey === 'string'
        ? raw.outputKey
        : '',
  }

  if (node.prompt.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'classify.prompt is required',
      path: `${path}.prompt`,
    })
  }
  if (choices.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'classify.choices must contain at least one choice',
      path: `${path}.choices`,
    })
  }
  if (node.outputKey.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'classify.output is required',
      path: `${path}.output`,
    })
  }

  const defaultRaw = raw.default ?? raw.defaultChoice
  if (defaultRaw !== undefined) {
    if (typeof defaultRaw !== 'string' || defaultRaw.length === 0) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.MISSING_REQUIRED_FIELD,
        message: 'classify.default must be a non-empty string when present',
        path: raw.default !== undefined ? `${path}.default` : `${path}.defaultChoice`,
      })
    } else if (!choices.includes(defaultRaw)) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message: 'classify.default must match one of classify.choices',
        path: raw.default !== undefined ? `${path}.default` : `${path}.defaultChoice`,
      })
    } else {
      node.defaultChoice = defaultRaw
    }
  }

  return node
}

export function normalizeCheckpoint(
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

export function normalizeRestore(
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
