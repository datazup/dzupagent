/**
 * Per-kind parser for `agent` and `validate` nodes. Mirrors the discipline of
 * the validator under `../validate/agent.ts` — keep the shape constraints
 * isomorphic so a round-trip parse + validate produces the same node or the
 * same error set.
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
} from '../types.js'
import {
  type ParseContext,
  describeJsType,
  isPlainObject,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseAgent(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): AgentNode | null {
  let failed = false

  const agentIdRaw = obj.agentId
  if (typeof agentIdRaw !== 'string' || agentIdRaw.length === 0) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `agent.agentId must be a non-empty string, received ${describeJsType(agentIdRaw)}`,
      pointer: joinPointer(pointer, 'agentId'),
    })
    failed = true
  }

  const instructionsRaw = obj.instructions
  if (typeof instructionsRaw !== 'string' || instructionsRaw.length === 0) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `agent.instructions must be a non-empty string, received ${describeJsType(instructionsRaw)}`,
      pointer: joinPointer(pointer, 'instructions'),
    })
    failed = true
  }

  const output = parseOutput(obj.output, joinPointer(pointer, 'output'), ctx)
  if (output === null) failed = true

  if (failed) return null

  const node: AgentNode = {
    type: 'agent',
    ...parseCommonNodeFields(obj, pointer, ctx),
    agentId: agentIdRaw as string,
    instructions: instructionsRaw as string,
    output: output as AgentOutput,
  }

  copyOptionalString(obj, 'profile', pointer, ctx, (v) => { node.profile = v })
  copyOptionalString(obj, 'toolset', pointer, ctx, (v) => { node.toolset = v })
  copyOptionalString(obj, 'model', pointer, ctx, (v) => { node.model = v })
  copyOptionalString(obj, 'provider', pointer, ctx, (v) => { node.provider = v })

  if ('tools' in obj && obj.tools !== undefined) {
    const tools = obj.tools
    if (Array.isArray(tools) && tools.every((v): v is string => typeof v === 'string')) {
      node.tools = tools
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: 'agent.tools must be an array of strings when present',
        pointer: joinPointer(pointer, 'tools'),
      })
    }
  }

  if ('input' in obj && obj.input !== undefined) {
    if (isPlainObject(obj.input)) node.input = obj.input
    else {
      ctx.errors.push({
        code: 'EXPECTED_OBJECT',
        message: 'agent.input must be an object when present',
        pointer: joinPointer(pointer, 'input'),
      })
    }
  }

  const stop = parseStop(obj.stop, joinPointer(pointer, 'stop'), ctx)
  if (stop !== undefined) node.stop = stop

  const onInvalidOutput = parseOnInvalidOutput(
    obj.onInvalidOutput,
    joinPointer(pointer, 'onInvalidOutput'),
    ctx,
  )
  if (onInvalidOutput !== undefined) node.onInvalidOutput = onInvalidOutput

  const retry = parseRetry(obj.retry, joinPointer(pointer, 'retry'), ctx)
  if (retry !== undefined) node.retry = retry

  const validation = parseValidation(
    obj.validation,
    joinPointer(pointer, 'validation'),
    ctx,
  )
  if (validation !== undefined) node.validation = validation

  const policy = parsePolicy(obj.policy, joinPointer(pointer, 'policy'), ctx)
  if (policy !== undefined) node.policy = policy

  return node
}

export function parseValidateNode(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): ValidateNode | null {
  let ref: string | undefined
  if ('ref' in obj && obj.ref !== undefined) {
    if (typeof obj.ref === 'string' && obj.ref.length > 0) {
      ref = obj.ref
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: 'validate.ref must be a non-empty string when present',
        pointer: joinPointer(pointer, 'ref'),
      })
      return null
    }
  }

  const commands = parseCommands(obj.commands, joinPointer(pointer, 'commands'), ctx, false)
  if (ref === undefined && (commands === undefined || commands.length === 0)) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: 'validate node requires either `ref` or a non-empty `commands` array',
      pointer,
    })
    return null
  }

  const node: ValidateNode = {
    type: 'validate',
    ...parseCommonNodeFields(obj, pointer, ctx),
  }
  if (ref !== undefined) node.ref = ref
  if (commands !== undefined) node.commands = commands

  if ('repair' in obj && obj.repair !== undefined) {
    const repair = obj.repair
    if (!isPlainObject(repair)) {
      ctx.errors.push({
        code: 'EXPECTED_OBJECT',
        message: 'validate.repair must be an object when present',
        pointer: joinPointer(pointer, 'repair'),
      })
    } else {
      const maxAttempts = repair.maxAttempts
      if (typeof maxAttempts !== 'number' || maxAttempts < 0) {
        ctx.errors.push({
          code: 'WRONG_FIELD_TYPE',
          message: 'validate.repair.maxAttempts is required (non-negative number)',
          pointer: joinPointer(pointer, 'repair/maxAttempts'),
        })
      } else {
        const out: NonNullable<ValidateNode['repair']> = { maxAttempts }
        if (repair.onFailure === 'retry-prior-agent' || repair.onFailure === 'stop') {
          out.onFailure = repair.onFailure
        } else if (repair.onFailure !== undefined) {
          ctx.errors.push({
            code: 'WRONG_FIELD_TYPE',
            message: 'validate.repair.onFailure must be "retry-prior-agent" or "stop"',
            pointer: joinPointer(pointer, 'repair/onFailure'),
          })
        }
        node.repair = out
      }
    }
  }

  return node
}

// ── internal helpers ─────────────────────────────────────────────────────────

function copyOptionalString(
  obj: Record<string, unknown>,
  key: string,
  pointer: string,
  ctx: ParseContext,
  assign: (value: string) => void,
): void {
  if (!(key in obj) || obj[key] === undefined) return
  const v = obj[key]
  if (typeof v === 'string') {
    assign(v)
    return
  }
  ctx.errors.push({
    code: 'WRONG_FIELD_TYPE',
    message: `agent.${key} must be a string when present`,
    pointer: joinPointer(pointer, key),
  })
}

function parseOutput(
  raw: unknown,
  pointer: string,
  ctx: ParseContext,
): AgentOutput | null {
  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: 'EXPECTED_OBJECT',
      message: `agent.output is required (object), received ${describeJsType(raw)}`,
      pointer,
    })
    return null
  }
  const key = raw.key
  if (typeof key !== 'string' || key.length === 0) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: 'agent.output.key is required (non-empty string)',
      pointer: joinPointer(pointer, 'key'),
    })
    return null
  }
  const schemaRef = raw.schemaRef
  const schema = raw.schema
  if (schemaRef === undefined && schema === undefined) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: 'agent.output requires either `schemaRef` or inline `schema`',
      pointer,
    })
    return null
  }
  if (schemaRef !== undefined && typeof schemaRef !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: 'agent.output.schemaRef must be a string when present',
      pointer: joinPointer(pointer, 'schemaRef'),
    })
    return null
  }
  if (schema !== undefined && !isPlainObject(schema)) {
    ctx.errors.push({
      code: 'EXPECTED_OBJECT',
      message: 'agent.output.schema must be an object when present',
      pointer: joinPointer(pointer, 'schema'),
    })
    return null
  }
  const out: AgentOutput = { key }
  if (typeof schemaRef === 'string') out.schemaRef = schemaRef
  if (isPlainObject(schema)) out.schema = schema
  return out
}

function parseStop(
  raw: unknown,
  pointer: string,
  ctx: ParseContext,
): AgentStop | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: 'EXPECTED_OBJECT',
      message: 'agent.stop must be an object when present',
      pointer,
    })
    return undefined
  }
  const stop: AgentStop = {}
  if (raw.maxIterations !== undefined) {
    if (typeof raw.maxIterations !== 'number') {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: 'agent.stop.maxIterations must be a number',
        pointer: joinPointer(pointer, 'maxIterations'),
      })
    } else stop.maxIterations = raw.maxIterations
  }
  if (raw.maxToolCalls !== undefined) {
    if (typeof raw.maxToolCalls !== 'number') {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: 'agent.stop.maxToolCalls must be a number',
        pointer: joinPointer(pointer, 'maxToolCalls'),
      })
    } else stop.maxToolCalls = raw.maxToolCalls
  }
  if (raw.requireFinalSchema !== undefined) {
    if (typeof raw.requireFinalSchema !== 'boolean') {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: 'agent.stop.requireFinalSchema must be a boolean',
        pointer: joinPointer(pointer, 'requireFinalSchema'),
      })
    } else stop.requireFinalSchema = raw.requireFinalSchema
  }
  return stop
}

function parseOnInvalidOutput(
  raw: unknown,
  pointer: string,
  ctx: ParseContext,
): AgentOnInvalidOutput | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: 'EXPECTED_OBJECT',
      message: 'agent.onInvalidOutput must be an object',
      pointer,
    })
    return undefined
  }
  const retry = raw.retry
  if (typeof retry !== 'number' || retry < 0) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: 'agent.onInvalidOutput.retry is required (non-negative number)',
      pointer: joinPointer(pointer, 'retry'),
    })
    return undefined
  }
  const out: AgentOnInvalidOutput = { retry }
  if (typeof raw.repairPrompt === 'boolean') out.repairPrompt = raw.repairPrompt
  if (typeof raw.failAfterRetries === 'boolean') out.failAfterRetries = raw.failAfterRetries
  return out
}

function parseRetry(
  raw: unknown,
  pointer: string,
  ctx: ParseContext,
): AgentRetry | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: 'EXPECTED_OBJECT',
      message: 'agent.retry must be an object',
      pointer,
    })
    return undefined
  }
  const out: AgentRetry = {}

  const onInvalidOutput = parseAttemptsBranch(raw.onInvalidOutput, joinPointer(pointer, 'onInvalidOutput'), ctx)
  if (onInvalidOutput !== undefined) {
    const branch: NonNullable<AgentRetry['onInvalidOutput']> = { attempts: onInvalidOutput.attempts }
    if (isPlainObject(raw.onInvalidOutput) && typeof raw.onInvalidOutput.repairPrompt === 'boolean') {
      branch.repairPrompt = raw.onInvalidOutput.repairPrompt
    }
    out.onInvalidOutput = branch
  }

  const onToolError = parseAttemptsBranch(raw.onToolError, joinPointer(pointer, 'onToolError'), ctx)
  if (onToolError !== undefined) out.onToolError = { attempts: onToolError.attempts }

  const onValidationFailure = parseAttemptsBranch(
    raw.onValidationFailure,
    joinPointer(pointer, 'onValidationFailure'),
    ctx,
  )
  if (onValidationFailure !== undefined) {
    const branch: NonNullable<AgentRetry['onValidationFailure']> = { attempts: onValidationFailure.attempts }
    if (isPlainObject(raw.onValidationFailure) && typeof raw.onValidationFailure.fullLoop === 'boolean') {
      branch.fullLoop = raw.onValidationFailure.fullLoop
    }
    out.onValidationFailure = branch
  }

  const onModelUnavailable = parseAttemptsBranch(
    raw.onModelUnavailable,
    joinPointer(pointer, 'onModelUnavailable'),
    ctx,
  )
  if (onModelUnavailable !== undefined) {
    const branch: NonNullable<AgentRetry['onModelUnavailable']> = { attempts: onModelUnavailable.attempts }
    if (isPlainObject(raw.onModelUnavailable) && typeof raw.onModelUnavailable.fallbackProfile === 'string') {
      branch.fallbackProfile = raw.onModelUnavailable.fallbackProfile
    }
    out.onModelUnavailable = branch
  }

  return out
}

function parseAttemptsBranch(
  raw: unknown,
  pointer: string,
  ctx: ParseContext,
): { attempts: number } | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: 'EXPECTED_OBJECT',
      message: `${pointer} must be an object`,
      pointer,
    })
    return undefined
  }
  const attempts = raw.attempts
  if (typeof attempts !== 'number' || attempts < 0) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `${pointer}/attempts is required (non-negative number)`,
      pointer: joinPointer(pointer, 'attempts'),
    })
    return undefined
  }
  return { attempts }
}

function parseValidation(
  raw: unknown,
  pointer: string,
  ctx: ParseContext,
): AgentValidation | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: 'EXPECTED_OBJECT',
      message: 'agent.validation must be an object',
      pointer,
    })
    return undefined
  }
  const required = parseCommands(raw.required, joinPointer(pointer, 'required'), ctx, true)
  if (required === undefined) return undefined
  const out: AgentValidation = { required }
  if (raw.repair !== undefined) {
    if (!isPlainObject(raw.repair)) {
      ctx.errors.push({
        code: 'EXPECTED_OBJECT',
        message: 'agent.validation.repair must be an object',
        pointer: joinPointer(pointer, 'repair'),
      })
    } else {
      const max = raw.repair.maxAttempts
      if (typeof max !== 'number' || max < 0) {
        ctx.errors.push({
          code: 'WRONG_FIELD_TYPE',
          message: 'agent.validation.repair.maxAttempts is required (non-negative number)',
          pointer: joinPointer(pointer, 'repair/maxAttempts'),
        })
      } else {
        out.repair = { maxAttempts: max }
      }
    }
  }
  return out
}

function parseCommands(
  raw: unknown,
  pointer: string,
  ctx: ParseContext,
  required: boolean,
): AgentValidationCommand[] | undefined {
  if (raw === undefined) {
    if (required) {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `${pointer} is required (array of {command} objects)`,
        pointer,
      })
    }
    return undefined
  }
  if (!Array.isArray(raw)) {
    ctx.errors.push({
      code: 'EXPECTED_ARRAY',
      message: `${pointer} must be an array`,
      pointer,
    })
    return undefined
  }
  if (required && raw.length === 0) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `${pointer} must contain at least one entry`,
      pointer,
    })
    return undefined
  }
  const out: AgentValidationCommand[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    const itemPointer = `${pointer}/${i}`
    if (!isPlainObject(item)) {
      ctx.errors.push({
        code: 'EXPECTED_OBJECT',
        message: `${itemPointer} must be an object`,
        pointer: itemPointer,
      })
      continue
    }
    const command = item.command
    if (typeof command !== 'string' || command.length === 0) {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `${itemPointer}/command is required (non-empty string)`,
        pointer: joinPointer(itemPointer, 'command'),
      })
      continue
    }
    const entry: AgentValidationCommand = { command }
    if (typeof item.id === 'string' && item.id.length > 0) entry.id = item.id
    out.push(entry)
  }
  return out
}

function parsePolicy(
  raw: unknown,
  pointer: string,
  ctx: ParseContext,
): AgentPolicy | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: 'EXPECTED_OBJECT',
      message: 'agent.policy must be an object',
      pointer,
    })
    return undefined
  }
  const policy: AgentPolicy = {}
  positiveFiniteNumberField(raw, 'timeoutMs', pointer, ctx, (v) => { policy.timeoutMs = v })
  positiveFiniteNumberField(raw, 'budgetCents', pointer, ctx, (v) => { policy.budgetCents = v })
  numberField(raw, 'maxToolCalls', pointer, ctx, (v) => { policy.maxToolCalls = v })
  if (raw.workingDirectory !== undefined) {
    if (typeof raw.workingDirectory !== 'string') {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: 'agent.policy.workingDirectory must be a string',
        pointer: joinPointer(pointer, 'workingDirectory'),
      })
    } else policy.workingDirectory = raw.workingDirectory
  }
  if (raw.approval !== undefined) {
    if (!isPlainObject(raw.approval)) {
      ctx.errors.push({
        code: 'EXPECTED_OBJECT',
        message: 'agent.policy.approval must be an object',
        pointer: joinPointer(pointer, 'approval'),
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
        ctx.errors.push({
          code: 'WRONG_FIELD_TYPE',
          message: 'agent.policy.approval.requiredFor must be an array of strings',
          pointer: joinPointer(pointer, 'approval/requiredFor'),
        })
      }
    }
  }
  if (raw.audit !== undefined) {
    if (!isPlainObject(raw.audit)) {
      ctx.errors.push({
        code: 'EXPECTED_OBJECT',
        message: 'agent.policy.audit must be an object',
        pointer: joinPointer(pointer, 'audit'),
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

function positiveFiniteNumberField(
  obj: Record<string, unknown>,
  key: string,
  pointer: string,
  ctx: ParseContext,
  assign: (v: number) => void,
): void {
  if (obj[key] === undefined) return
  const value = obj[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `${pointer}/${key} must be a finite number`,
      pointer: joinPointer(pointer, key),
    })
    return
  }
  if (value <= 0) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `${pointer}/${key} must be greater than 0`,
      pointer: joinPointer(pointer, key),
    })
    return
  }
  assign(value)
}

function numberField(
  obj: Record<string, unknown>,
  key: string,
  pointer: string,
  ctx: ParseContext,
  assign: (v: number) => void,
): void {
  if (obj[key] === undefined) return
  if (typeof obj[key] !== 'number') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `${pointer}/${key} must be a number`,
      pointer: joinPointer(pointer, key),
    })
    return
  }
  assign(obj[key] as number)
}
