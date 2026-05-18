import type { EmitNode, HttpNode, MemoryNode, PromptNode, ReturnToNode, SpawnNode, SubflowNode, WaitNode } from '@dzupagent/flow-ast'

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

// ── http ──────────────────────────────────────────────────────────────────────

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

const HTTP_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'url',
  'method',
  'headers',
  'body',
  'outputVar',
  'output_var',
])

export function normalizeHttp(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): HttpNode {
  reportUnsupportedFields(raw, HTTP_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)

  const url = typeof raw.url === 'string' ? raw.url : ''
  if (url.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'http.url is required',
      path: `${path}.url`,
    })
  }

  const node: HttpNode = { type: 'http', ...base, url }

  if (raw.method !== undefined) {
    if (typeof raw.method === 'string' && HTTP_METHODS.has(raw.method)) {
      node.method = raw.method as HttpNode['method']
    } else {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: 'http.method must be GET|POST|PUT|PATCH|DELETE',
        path: `${path}.method`,
      })
    }
  }

  if (raw.headers !== undefined) {
    const h = normalizeObject(raw.headers, `${path}.headers`, diagnostics)
    if (h !== undefined) node.headers = h as Record<string, string>
  }

  if (raw.body !== undefined) {
    const b = normalizeObject(raw.body, `${path}.body`, diagnostics)
    if (b !== undefined) node.body = b
  }

  const outputVarRaw = raw.outputVar ?? raw.output_var
  if (typeof outputVarRaw === 'string') node.outputVar = outputVarRaw

  return node
}

// ── wait ──────────────────────────────────────────────────────────────────────

const WAIT_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'durationMs',
  'duration_ms',
])

export function normalizeWait(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): WaitNode {
  reportUnsupportedFields(raw, WAIT_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)

  const durationRaw = raw.durationMs ?? raw.duration_ms
  const durationMs = typeof durationRaw === 'number' ? durationRaw : -1

  if (durationMs < 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'wait.durationMs is required (non-negative number)',
      path: `${path}.durationMs`,
    })
  }

  return { type: 'wait', ...base, durationMs: Math.max(0, durationMs) }
}

// ── subflow ───────────────────────────────────────────────────────────────────

const SUBFLOW_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'flowRef',
  'flow_ref',
  'input',
  'outputVar',
  'output_var',
])

export function normalizeSubflow(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): SubflowNode {
  reportUnsupportedFields(raw, SUBFLOW_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)

  const flowRef =
    typeof raw.flowRef === 'string' ? raw.flowRef
    : typeof raw.flow_ref === 'string' ? raw.flow_ref
    : ''

  if (flowRef.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'subflow.flowRef is required',
      path: `${path}.flowRef`,
    })
  }

  const node: SubflowNode = { type: 'subflow', ...base, flowRef }

  const input = normalizeObject(raw.input, `${path}.input`, diagnostics)
  if (input !== undefined) node.input = input

  const outputVarRaw = raw.outputVar ?? raw.output_var
  if (typeof outputVarRaw === 'string') node.outputVar = outputVarRaw

  return node
}

// ── prompt ────────────────────────────────────────────────────────────────────

const PROMPT_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'userPrompt',
  'user_prompt',
  'systemPrompt',
  'system_prompt',
  'outputKey',
  'output_key',
  'provider',
  'model',
  'tools',
])

export function normalizePrompt(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): PromptNode {
  reportUnsupportedFields(raw, PROMPT_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)

  const userPrompt =
    typeof raw.userPrompt === 'string' ? raw.userPrompt
    : typeof raw.user_prompt === 'string' ? raw.user_prompt
    : ''

  if (userPrompt.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'prompt.userPrompt is required',
      path: `${path}.userPrompt`,
    })
  }

  const node: PromptNode = { type: 'prompt', ...base, userPrompt }

  const systemPromptRaw = raw.systemPrompt ?? raw.system_prompt
  if (typeof systemPromptRaw === 'string') node.systemPrompt = systemPromptRaw

  const outputKeyRaw = raw.outputKey ?? raw.output_key
  if (typeof outputKeyRaw === 'string') node.outputKey = outputKeyRaw

  if (typeof raw.provider === 'string') node.provider = raw.provider
  if (typeof raw.model === 'string') node.model = raw.model
  if (typeof raw.tools === 'boolean') node.tools = raw.tools

  return node
}

// ── return_to ─────────────────────────────────────────────────────────────────

const RETURN_TO_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'targetId',
  'target_id',
  'condition',
  'maxIterations',
  'max_iterations',
])

export function normalizeReturnTo(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): ReturnToNode {
  reportUnsupportedFields(raw, RETURN_TO_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)

  const targetId =
    typeof raw.targetId === 'string' ? raw.targetId
    : typeof raw.target_id === 'string' ? raw.target_id
    : ''

  if (targetId.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'return_to.targetId is required',
      path: `${path}.targetId`,
    })
  }

  const condition = typeof raw.condition === 'string' ? raw.condition : ''
  if (condition.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'return_to.condition is required',
      path: `${path}.condition`,
    })
  }

  const node: ReturnToNode = { type: 'return_to', ...base, targetId, condition }

  const maxIterRaw = raw.maxIterations ?? raw.max_iterations
  if (typeof maxIterRaw === 'number' && maxIterRaw > 0) node.maxIterations = maxIterRaw

  return node
}
