import type { OpaqueReference, Sha256Digest, ValidationIssue } from './contracts.js'
import type { SessionControlCommand } from './commands.js'
import {
  createCommandRecord,
  transitionCommandRecord,
  type CommandRecord,
  type CommandRecordMutation,
  type CommandRecordResult,
} from './command-ledger.js'

export type CommandRegistrationResult =
  | { readonly status: 'created' | 'replayed'; readonly record: CommandRecord }
  | { readonly status: 'conflict'; readonly reason: string }

export class InMemoryCommandLedger {
  readonly #byCommandId = new Map<OpaqueReference, CommandRecord>()
  readonly #byIdempotencyKey = new Map<Sha256Digest, CommandRecord>()

  register(
    command: SessionControlCommand,
    initial: CommandRecordMutation,
  ): CommandRegistrationResult {
    const idempotent = this.#byIdempotencyKey.get(command.idempotencyKey)
    if (idempotent !== undefined) {
      return idempotent.commandDigest === command.commandDigest
        ? { status: 'replayed', record: idempotent }
        : { status: 'conflict', reason: 'idempotency_digest_conflict' }
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
