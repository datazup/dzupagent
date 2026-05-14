import type { EmitNode, MemoryNode, SpawnNode } from '@dzupagent/flow-ast'

import { DSL_ERROR } from './errors.js'
import {
  COMMON_NODE_KEYS,
  isFlowValue,
  normalizeCommonNodeFields,
  normalizeObject,
  reportUnsupportedFields,
} from './normalize-value-helpers.js'
import type { DslDiagnostic } from './types.js'

// ── spawn ─────────────────────────────────────────────────────────────────────

const SPAWN_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'templateRef',
  'template_ref',
  'input',
  'waitForCompletion',
  'wait_for_completion',
])

export function normalizeSpawn(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): SpawnNode {
  reportUnsupportedFields(raw, SPAWN_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)

  const templateRef =
    typeof raw.templateRef === 'string' ? raw.templateRef
    : typeof raw.template_ref === 'string' ? raw.template_ref
    : ''

  const node: SpawnNode = {
    type: 'spawn',
    ...base,
    templateRef,
  }

  if (templateRef.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'spawn.templateRef is required',
      path: `${path}.templateRef`,
    })
  }

  const input = normalizeObject(raw.input, `${path}.input`, diagnostics)
  if (input !== undefined) node.input = input

  const waitRaw = raw.waitForCompletion ?? raw.wait_for_completion
  if (waitRaw !== undefined) {
    if (typeof waitRaw === 'boolean') {
      node.waitForCompletion = waitRaw
    } else {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: 'spawn.waitForCompletion must be a boolean',
        path: `${path}.waitForCompletion`,
      })
    }
  }

  return node
}

// ── emit ──────────────────────────────────────────────────────────────────────

const EMIT_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'event',
  'payload',
])

export function normalizeEmit(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): EmitNode {
  reportUnsupportedFields(raw, EMIT_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)

  const event = typeof raw.event === 'string' ? raw.event : ''
  const node: EmitNode = {
    type: 'emit',
    ...base,
    event,
  }

  if (event.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'emit.event is required',
      path: `${path}.event`,
    })
  }

  if (raw.payload !== undefined) {
    const payload = normalizeObject(raw.payload, `${path}.payload`, diagnostics)
    if (payload !== undefined) {
      const safePayload: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(payload)) {
        if (isFlowValue(v)) {
          safePayload[k] = v
        } else {
          diagnostics.push({
            phase: 'normalize',
            code: DSL_ERROR.INVALID_NODE_SHAPE,
            message: `emit.payload.${k} must be a JSON-compatible value`,
            path: `${path}.payload.${k}`,
          })
        }
      }
      node.payload = safePayload as Record<string, unknown>
    }
  }

  return node
}

// ── memory ────────────────────────────────────────────────────────────────────

const MEMORY_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'operation',
  'tier',
  'key',
  'valueExpr',
  'value_expr',
  'outputVar',
  'output_var',
])

const MEMORY_OPERATIONS = new Set(['read', 'write', 'list'])
const MEMORY_TIERS = new Set(['session', 'project', 'workspace'])

export function normalizeMemory(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): MemoryNode {
  reportUnsupportedFields(raw, MEMORY_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)

  const operation =
    raw.operation === 'read' || raw.operation === 'write' || raw.operation === 'list'
      ? raw.operation
      : 'read'

  const tier =
    raw.tier === 'session' || raw.tier === 'project' || raw.tier === 'workspace'
      ? raw.tier
      : 'session'

  const node: MemoryNode = {
    type: 'memory',
    ...base,
    operation,
    tier,
  }

  if (!MEMORY_OPERATIONS.has(String(raw.operation ?? ''))) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'memory.operation is required and must be "read", "write", or "list"',
      path: `${path}.operation`,
    })
  }

  if (!MEMORY_TIERS.has(String(raw.tier ?? ''))) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'memory.tier is required and must be "session", "project", or "workspace"',
      path: `${path}.tier`,
    })
  }

  if (typeof raw.key === 'string') {
    node.key = raw.key
  } else if (raw.key !== undefined) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'memory.key must be a string',
      path: `${path}.key`,
    })
  }

  const valueExprRaw = raw.valueExpr ?? raw.value_expr
  if (typeof valueExprRaw === 'string') {
    node.valueExpr = valueExprRaw
  } else if (valueExprRaw !== undefined) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'memory.valueExpr must be a string template expression',
      path: `${path}.valueExpr`,
    })
  }

  if (operation === 'write') {
    if (!node.key) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.MISSING_REQUIRED_FIELD,
        message: 'memory.key is required when operation is "write"',
        path: `${path}.key`,
      })
    }
    if (!node.valueExpr) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.MISSING_REQUIRED_FIELD,
        message: 'memory.valueExpr is required when operation is "write"',
        path: `${path}.valueExpr`,
      })
    }
  }

  const outputVarRaw = raw.outputVar ?? raw.output_var
  if (typeof outputVarRaw === 'string') {
    node.outputVar = outputVarRaw
  } else if (outputVarRaw !== undefined) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'memory.outputVar must be a string',
      path: `${path}.outputVar`,
    })
  }

  return node
}
