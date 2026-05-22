/**
 * DSL normalization for `agent` and `validate` nodes (dzupflow/v1alpha-agent).
 *
 * Mirrors `normalize-nodes-action.ts` style: declare allowed keys, run the
 * `reportUnsupportedFields` guard, normalize each field, and emit diagnostics
 * for shape problems. Shape constraints must agree with
 * `@dzupagent/flow-ast`'s `parse/agent.ts` and `validate/agent.ts`.
 */

import type {
  AgentNode,
  AgentOnInvalidOutput,
  AgentOutput,
  AgentPolicy,
  AgentRetry,
  AgentStop,
  AgentValidation,
  AgentValidationCommand,
  ValidateNode,
} from '@dzupagent/flow-ast'

import { DSL_ERROR } from './errors.js'
import {
  COMMON_NODE_KEYS,
  isPlainObject,
  normalizeCommonNodeFields,
  normalizeObject,
  reportUnsupportedFields,
} from './normalize-value-helpers.js'
import type { DslDiagnostic } from './types.js'

const AGENT_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'agentId',
  'profile',
  'toolset',
  'tools',
  'model',
  'provider',
  'instructions',
  'input',
  'stop',
  'output',
  'onInvalidOutput',
  'retry',
  'validation',
  'policy',
])

const VALIDATE_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'ref',
  'commands',
  'repair',
])

export function normalizeAgent(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): AgentNode {
  reportUnsupportedFields(raw, AGENT_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)

  const agentId = typeof raw.agentId === 'string' ? raw.agentId : ''
  const instructions = typeof raw.instructions === 'string' ? raw.instructions : ''
  const output = normalizeOutput(raw.output, `${path}.output`, diagnostics)

  if (agentId.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'agent.agentId is required',
      path: `${path}.agentId`,
    })
  }
  if (instructions.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'agent.instructions is required',
      path: `${path}.instructions`,
    })
  }

  // Provide an output stub when missing so the AST is structurally complete;
  // diagnostics above ensure ok=false at the document level.
  const safeOutput: AgentOutput = output ?? { key: '' }

  const node: AgentNode = {
    type: 'agent',
    ...base,
    agentId,
    instructions,
    output: safeOutput,
  }

  if (typeof raw.profile === 'string') node.profile = raw.profile
  if (typeof raw.toolset === 'string') node.toolset = raw.toolset
  if (typeof raw.model === 'string') node.model = raw.model
  if (typeof raw.provider === 'string') node.provider = raw.provider

  if (raw.tools !== undefined) {
    if (Array.isArray(raw.tools) && raw.tools.every((v): v is string => typeof v === 'string')) {
      node.tools = raw.tools
    } else {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: 'agent.tools must be an array of strings',
        path: `${path}.tools`,
      })
    }
  }

  if (raw.input !== undefined) {
    const input = normalizeObject(raw.input, `${path}.input`, diagnostics)
    if (input !== undefined) node.input = input
  }

  const stop = normalizeStop(raw.stop, `${path}.stop`, diagnostics)
  if (stop !== undefined) node.stop = stop

  const onInvalidOutput = normalizeOnInvalidOutput(
    raw.onInvalidOutput,
    `${path}.onInvalidOutput`,
    diagnostics,
  )
  if (onInvalidOutput !== undefined) node.onInvalidOutput = onInvalidOutput

  const retry = normalizeRetry(raw.retry, `${path}.retry`, diagnostics)
  if (retry !== undefined) node.retry = retry

  const validation = normalizeValidation(raw.validation, `${path}.validation`, diagnostics)
  if (validation !== undefined) node.validation = validation

  const policy = normalizePolicy(raw.policy, `${path}.policy`, diagnostics)
  if (policy !== undefined) node.policy = policy

  return node
}

export function normalizeValidate(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): ValidateNode {
  reportUnsupportedFields(raw, VALIDATE_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)

  const ref = typeof raw.ref === 'string' && raw.ref.length > 0 ? raw.ref : undefined
  const commands = normalizeCommands(raw.commands, `${path}.commands`, diagnostics, false)

  if (ref === undefined && (commands === undefined || commands.length === 0)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'validate node requires either `ref` or a non-empty `commands` array',
      path,
    })
  }

  const node: ValidateNode = { type: 'validate', ...base }
  if (ref !== undefined) node.ref = ref
  if (commands !== undefined) node.commands = commands

  if (raw.repair !== undefined) {
    if (!isPlainObject(raw.repair)) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: 'validate.repair must be an object',
        path: `${path}.repair`,
      })
    } else {
      const max = raw.repair.maxAttempts
      if (typeof max !== 'number' || max < 0) {
        diagnostics.push({
          phase: 'normalize',
          code: DSL_ERROR.MISSING_REQUIRED_FIELD,
          message: 'validate.repair.maxAttempts is required (non-negative number)',
          path: `${path}.repair.maxAttempts`,
        })
      } else {
        const repair: NonNullable<ValidateNode['repair']> = { maxAttempts: max }
        const onFailure = raw.repair.onFailure
        if (onFailure === 'retry-prior-agent' || onFailure === 'stop') {
          repair.onFailure = onFailure
        } else if (onFailure !== undefined) {
          diagnostics.push({
            phase: 'normalize',
            code: DSL_ERROR.INVALID_ENUM_VALUE,
            message: 'validate.repair.onFailure must be "retry-prior-agent" or "stop"',
            path: `${path}.repair.onFailure`,
          })
        }
        node.repair = repair
      }
    }
  }

  return node
}

// ── per-field normalizers ───────────────────────────────────────────────────

function normalizeOutput(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): AgentOutput | undefined {
  if (raw === undefined) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'agent.output is required',
      path,
    })
    return undefined
  }
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'agent.output must be an object',
      path,
    })
    return undefined
  }
  const key = raw.key
  if (typeof key !== 'string' || key.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'agent.output.key is required',
      path: `${path}.key`,
    })
    return undefined
  }
  if (raw.schemaRef === undefined && raw.schema === undefined) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'agent.output requires either `schemaRef` or inline `schema`',
      path,
    })
    return undefined
  }
  if (raw.schemaRef !== undefined && typeof raw.schemaRef !== 'string') {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'agent.output.schemaRef must be a string when present',
      path: `${path}.schemaRef`,
    })
    return undefined
  }
  if (raw.schema !== undefined && !isPlainObject(raw.schema)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'agent.output.schema must be an object when present',
      path: `${path}.schema`,
    })
    return undefined
  }
  const out: AgentOutput = { key }
  if (typeof raw.schemaRef === 'string') out.schemaRef = raw.schemaRef
  if (isPlainObject(raw.schema)) out.schema = raw.schema
  return out
}

function normalizeStop(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): AgentStop | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'agent.stop must be an object',
      path,
    })
    return undefined
  }
  const stop: AgentStop = {}
  if (typeof raw.maxIterations === 'number') stop.maxIterations = raw.maxIterations
  if (typeof raw.maxToolCalls === 'number') stop.maxToolCalls = raw.maxToolCalls
  if (typeof raw.requireFinalSchema === 'boolean') stop.requireFinalSchema = raw.requireFinalSchema
  return stop
}

function normalizeOnInvalidOutput(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): AgentOnInvalidOutput | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'agent.onInvalidOutput must be an object',
      path,
    })
    return undefined
  }
  if (typeof raw.retry !== 'number' || raw.retry < 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'agent.onInvalidOutput.retry is required (non-negative number)',
      path: `${path}.retry`,
    })
    return undefined
  }
  const out: AgentOnInvalidOutput = { retry: raw.retry }
  if (typeof raw.repairPrompt === 'boolean') out.repairPrompt = raw.repairPrompt
  if (typeof raw.failAfterRetries === 'boolean') out.failAfterRetries = raw.failAfterRetries
  return out
}

function normalizeRetry(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): AgentRetry | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'agent.retry must be an object',
      path,
    })
    return undefined
  }
  const out: AgentRetry = {}

  if (raw.onInvalidOutput !== undefined) {
    const branch = readAttemptsBranch(raw.onInvalidOutput, `${path}.onInvalidOutput`, diagnostics)
    if (branch !== undefined) {
      const b: NonNullable<AgentRetry['onInvalidOutput']> = { attempts: branch.attempts }
      if (isPlainObject(raw.onInvalidOutput) && typeof raw.onInvalidOutput.repairPrompt === 'boolean') {
        b.repairPrompt = raw.onInvalidOutput.repairPrompt
      }
      out.onInvalidOutput = b
    }
  }

  if (raw.onToolError !== undefined) {
    const branch = readAttemptsBranch(raw.onToolError, `${path}.onToolError`, diagnostics)
    if (branch !== undefined) out.onToolError = { attempts: branch.attempts }
  }

  if (raw.onValidationFailure !== undefined) {
    const branch = readAttemptsBranch(raw.onValidationFailure, `${path}.onValidationFailure`, diagnostics)
    if (branch !== undefined) {
      const b: NonNullable<AgentRetry['onValidationFailure']> = { attempts: branch.attempts }
      if (isPlainObject(raw.onValidationFailure) && typeof raw.onValidationFailure.fullLoop === 'boolean') {
        b.fullLoop = raw.onValidationFailure.fullLoop
      }
      out.onValidationFailure = b
    }
  }

  if (raw.onModelUnavailable !== undefined) {
    const branch = readAttemptsBranch(raw.onModelUnavailable, `${path}.onModelUnavailable`, diagnostics)
    if (branch !== undefined) {
      const b: NonNullable<AgentRetry['onModelUnavailable']> = { attempts: branch.attempts }
      if (
        isPlainObject(raw.onModelUnavailable)
        && typeof raw.onModelUnavailable.fallbackProfile === 'string'
      ) {
        b.fallbackProfile = raw.onModelUnavailable.fallbackProfile
      }
      out.onModelUnavailable = b
    }
  }

  return out
}

function readAttemptsBranch(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): { attempts: number } | undefined {
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: `${path} must be an object`,
      path,
    })
    return undefined
  }
  if (typeof raw.attempts !== 'number' || raw.attempts < 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: `${path}.attempts is required (non-negative number)`,
      path: `${path}.attempts`,
    })
    return undefined
  }
  return { attempts: raw.attempts }
}

function normalizeValidation(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): AgentValidation | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'agent.validation must be an object',
      path,
    })
    return undefined
  }
  const required = normalizeCommands(raw.required, `${path}.required`, diagnostics, true)
  if (required === undefined) return undefined
  const out: AgentValidation = { required }
  if (raw.repair !== undefined) {
    if (!isPlainObject(raw.repair)) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: 'agent.validation.repair must be an object',
        path: `${path}.repair`,
      })
    } else {
      const max = raw.repair.maxAttempts
      if (typeof max !== 'number' || max < 0) {
        diagnostics.push({
          phase: 'normalize',
          code: DSL_ERROR.MISSING_REQUIRED_FIELD,
          message: 'agent.validation.repair.maxAttempts is required (non-negative number)',
          path: `${path}.repair.maxAttempts`,
        })
      } else {
        out.repair = { maxAttempts: max }
      }
    }
  }
  return out
}

function normalizeCommands(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
  required: boolean,
): AgentValidationCommand[] | undefined {
  if (raw === undefined) {
    if (required) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.MISSING_REQUIRED_FIELD,
        message: `${path} is required`,
        path,
      })
    }
    return undefined
  }
  if (!Array.isArray(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: `${path} must be an array`,
      path,
    })
    return undefined
  }
  if (required && raw.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: `${path} must contain at least one entry`,
      path,
    })
    return undefined
  }
  const out: AgentValidationCommand[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    const itemPath = `${path}[${i}]`
    if (!isPlainObject(item)) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: `${itemPath} must be an object`,
        path: itemPath,
      })
      continue
    }
    const command = item.command
    if (typeof command !== 'string' || command.length === 0) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.MISSING_REQUIRED_FIELD,
        message: `${itemPath}.command is required (non-empty string)`,
        path: `${itemPath}.command`,
      })
      continue
    }
    const entry: AgentValidationCommand = { command }
    if (typeof item.id === 'string' && item.id.length > 0) entry.id = item.id
    out.push(entry)
  }
  return out
}

function normalizePolicy(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): AgentPolicy | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'agent.policy must be an object',
      path,
    })
    return undefined
  }
  const policy: AgentPolicy = {}
  normalizePositiveFinitePolicyNumber(raw, 'timeoutMs', path, diagnostics, (value) => {
    policy.timeoutMs = value
  })
  normalizePositiveFinitePolicyNumber(raw, 'budgetCents', path, diagnostics, (value) => {
    policy.budgetCents = value
  })
  if (typeof raw.maxToolCalls === 'number') policy.maxToolCalls = raw.maxToolCalls
  if (typeof raw.workingDirectory === 'string') policy.workingDirectory = raw.workingDirectory
  if (raw.approval !== undefined) {
    if (!isPlainObject(raw.approval)) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: 'agent.policy.approval must be an object',
        path: `${path}.approval`,
      })
    } else {
      const requiredFor = raw.approval.requiredFor
      if (requiredFor === undefined) {
        policy.approval = {}
      } else if (
        Array.isArray(requiredFor)
        && requiredFor.every((v): v is string => typeof v === 'string')
      ) {
        policy.approval = { requiredFor }
      } else {
        diagnostics.push({
          phase: 'normalize',
          code: DSL_ERROR.INVALID_NODE_SHAPE,
          message: 'agent.policy.approval.requiredFor must be an array of strings',
          path: `${path}.approval.requiredFor`,
        })
      }
    }
  }
  if (raw.audit !== undefined) {
    if (!isPlainObject(raw.audit)) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: 'agent.policy.audit must be an object',
        path: `${path}.audit`,
      })
    } else {
      const audit: NonNullable<AgentPolicy['audit']> = {}
      if (typeof raw.audit.captureToolCalls === 'boolean') {
        audit.captureToolCalls = raw.audit.captureToolCalls
      }
      if (typeof raw.audit.captureDiffs === 'boolean') {
        audit.captureDiffs = raw.audit.captureDiffs
      }
      policy.audit = audit
    }
  }
  return policy
}

function normalizePositiveFinitePolicyNumber(
  raw: Record<string, unknown>,
  key: 'timeoutMs' | 'budgetCents',
  path: string,
  diagnostics: DslDiagnostic[],
  assign: (value: number) => void,
): void {
  if (raw[key] === undefined) return
  const value = raw[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: `agent.policy.${key} must be a finite number`,
      path: `${path}.${key}`,
    })
    return
  }
  if (value <= 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: `agent.policy.${key} must be greater than 0`,
      path: `${path}.${key}`,
    })
    return
  }
  assign(value)
}
