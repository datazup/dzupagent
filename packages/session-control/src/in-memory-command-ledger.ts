import type { OpaqueReference, Sha256Digest, ValidationIssue } from './contracts.js'
import type { SessionControlCommand } from './commands.js'
import {
  createCommandRecord,
  transitionCommandRecord,
  type CommandRecord,
  type CommandRecordMutation,
  type CommandRecordResult,
} from './command-ledger.js'
import { areJsonValuesEqual } from './validation.js'

export type CommandRegistrationResult =
  | { readonly status: 'created' | 'replayed'; readonly record: CommandRecord }
  | { readonly status: 'conflict'; readonly reason: string }

export class InMemoryCommandLedger {
  readonly #byCommandId = new Map<OpaqueReference, CommandRecord>()
  readonly #byIdempotencyKey = new Map<Sha256Digest, CommandRecord>()
  readonly #commandsById = new Map<OpaqueReference, SessionControlCommand>()

  register(
    command: SessionControlCommand,
    initial: CommandRecordMutation,
  ): CommandRegistrationResult {
    const idempotent = this.#byIdempotencyKey.get(command.idempotencyKey)
    if (idempotent !== undefined) {
      if (idempotent.commandDigest !== command.commandDigest) {
        return { status: 'conflict', reason: 'idempotency_digest_conflict' }
      }
      const retained = this.#commandsById.get(idempotent.commandId)
      return retained !== undefined && commandsMatch(retained, command)
        ? { status: 'replayed', record: idempotent }
        : { status: 'conflict', reason: 'idempotency_command_conflict' }
    }

    const identified = this.#byCommandId.get(command.commandId)
    if (identified !== undefined) {
      if (
        identified.commandDigest === command.commandDigest &&
        identified.idempotencyKey === command.idempotencyKey
      ) {
        return { status: 'replayed', record: identified }
      }
      return { status: 'conflict', reason: 'command_id_conflict' }
    }

    const created = createCommandRecord(command, initial)
    if (!created.ok) return { status: 'conflict', reason: created.issue.code }
    this.#byCommandId.set(command.commandId, created.record)
    this.#byIdempotencyKey.set(command.idempotencyKey, created.record)
    this.#commandsById.set(command.commandId, cloneCommand(command))
    return { status: 'created', record: created.record }
  }

  transition(commandId: OpaqueReference, transition: CommandRecordMutation): CommandRecordResult {
    const current = this.#byCommandId.get(commandId)
    if (current === undefined) {
      const issue: ValidationIssue = {
        path: 'commandId',
        code: 'command_not_found',
        message: 'command record does not exist',
      }
      return { ok: false, issue }
    }

    const result = transitionCommandRecord(current, transition)
    if (!result.ok) return result
    this.#byCommandId.set(commandId, result.record)
    this.#byIdempotencyKey.set(result.record.idempotencyKey, result.record)
    return result
  }

  getByCommandId(commandId: OpaqueReference): CommandRecord | undefined {
    return this.#byCommandId.get(commandId)
  }

  getByIdempotencyKey(idempotencyKey: Sha256Digest): CommandRecord | undefined {
    return this.#byIdempotencyKey.get(idempotencyKey)
  }
}

function commandsMatch(left: SessionControlCommand, right: SessionControlCommand): boolean {
  return (
    left.schema === right.schema &&
    left.commandId === right.commandId &&
    left.commandDigest === right.commandDigest &&
    left.sessionRef === right.sessionRef &&
    left.action === right.action &&
    left.expectedGeneration === right.expectedGeneration &&
    left.deadline === right.deadline &&
    left.idempotencyKey === right.idempotencyKey &&
    left.correlationRef === right.correlationRef &&
    areJsonValuesEqual(left.payload, right.payload)
  )
}

function cloneCommand(command: SessionControlCommand): SessionControlCommand {
  return {
    ...command,
    payload: JSON.parse(JSON.stringify(command.payload)) as SessionControlCommand['payload'],
  }
}
