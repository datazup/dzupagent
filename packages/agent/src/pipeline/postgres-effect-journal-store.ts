/**
 * PostgreSQL-backed effect journal with atomic unique claim and fail-closed
 * compare-and-set transitions. The adapter accepts the same minimal query port
 * as the pipeline checkpoint store and does not take a dependency on `pg`.
 *
 * @module pipeline/postgres-effect-journal-store
 */

import {
  validateEffectIntent,
  validateEffectReceipt,
  type EffectClaimResult,
  type EffectIntent,
  type EffectJournalRecord,
  type EffectJournalStore,
  type EffectJsonValue,
  type EffectReceipt,
} from '@dzupagent/runtime-contracts/effect-receipt'

import type { PostgresClientLike } from './postgres-checkpoint-store.js'

export type PostgresEffectJournalErrorCode =
  | 'invalid-input'
  | 'record-corrupt'
  | 'record-missing'
  | 'intent-conflict'
  | 'invalid-transition'

export class PostgresEffectJournalError extends Error {
  readonly code: PostgresEffectJournalErrorCode

  constructor(code: PostgresEffectJournalErrorCode, message: string) {
    super(message)
    this.name = 'PostgresEffectJournalError'
    this.code = code
  }
}

export interface PostgresEffectJournalStoreOptions {
  readonly client: PostgresClientLike
  /** Override the table name (default: `effect_journal`). */
  readonly tableName?: string
}

interface EffectJournalRow {
  idempotency_key: string
  intent_digest: string
  status: 'pending' | 'outcome-unknown' | 'committed'
  intent: unknown
  receipt: unknown | null
  claimed_at: Date | string
  observed_at: Date | string | null
  committed_at: Date | string | null
}

export class PostgresEffectJournalStore<T extends EffectJsonValue = EffectJsonValue>
implements EffectJournalStore<T> {
  readonly #client: PostgresClientLike
  readonly #tableName: string

  constructor(options: PostgresEffectJournalStoreOptions) {
    this.#client = options.client
    const tableName = options.tableName ?? 'effect_journal'
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tableName)) {
      throw new PostgresEffectJournalError(
        'invalid-input',
        'Effect journal tableName must be a safe PostgreSQL identifier.',
      )
    }
    this.#tableName = tableName
  }

  /** Idempotently creates the journal and its intent-digest lookup index. */
  async setup(): Promise<void> {
    await this.#client.query(`
      /* effect-journal:setup-table */
      CREATE TABLE IF NOT EXISTS ${this.#tableName} (
        idempotency_key TEXT PRIMARY KEY,
        intent_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'outcome-unknown', 'committed')),
        intent JSONB NOT NULL,
        receipt JSONB,
        claimed_at TIMESTAMPTZ NOT NULL,
        observed_at TIMESTAMPTZ,
        committed_at TIMESTAMPTZ,
        CHECK (
          (status = 'pending' AND receipt IS NULL AND observed_at IS NULL AND committed_at IS NULL)
          OR (status = 'outcome-unknown' AND receipt IS NULL AND observed_at IS NOT NULL AND committed_at IS NULL)
          OR (status = 'committed' AND receipt IS NOT NULL AND committed_at IS NOT NULL)
        )
      )
    `)
    await this.#client.query(`
      /* effect-journal:setup-index */
      CREATE INDEX IF NOT EXISTS ${this.#tableName}_intent_digest_idx
      ON ${this.#tableName} (intent_digest)
    `)
  }

  async claim(intent: EffectIntent, claimedAt: string): Promise<EffectClaimResult<T>> {
    assertIntent(intent)
    assertIsoTime(claimedAt, 'claimedAt')
    const inserted = await this.#client.query<EffectJournalRow>(`
      /* effect-journal:claim */
      INSERT INTO ${this.#tableName} (
        idempotency_key, intent_digest, status, intent, claimed_at
      ) VALUES ($1, $2, 'pending', $3::jsonb, $4)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING *
    `, [
      intent.idempotencyKey,
      intent.intentDigest,
      JSON.stringify(intent),
      claimedAt,
    ])
    if (inserted.rows.length === 1) return { status: 'claimed' }
    const existing = await this.#load(intent.idempotencyKey)
    if (existing === undefined) {
      throw new PostgresEffectJournalError(
        'record-missing',
        'Effect claim conflict was observed but the winning record is unavailable.',
      )
    }
    return { status: 'existing', record: existing }
  }

  async commit(intent: EffectIntent, receipt: EffectReceipt<T>): Promise<void> {
    assertIntent(intent)
    assertReceipt(receipt, intent)
    const updated = await this.#client.query<EffectJournalRow>(`
      /* effect-journal:commit */
      UPDATE ${this.#tableName}
      SET status = 'committed', receipt = $3::jsonb,
          committed_at = $4, observed_at = NULL
      WHERE idempotency_key = $1
        AND intent_digest = $2
        AND status = 'pending'
      RETURNING *
    `, [
      intent.idempotencyKey,
      intent.intentDigest,
      JSON.stringify(receipt),
      receipt.committedAt,
    ])
    if (updated.rows.length === 1) return
    const existing = await this.#requiredExisting(intent)
    if (existing.status === 'committed' &&
        existing.receipt.receiptDigest === receipt.receiptDigest) return
    throw new PostgresEffectJournalError(
      'invalid-transition',
      `Cannot commit an effect journal record in ${existing.status} state.`,
    )
  }

  async markOutcomeUnknown(intent: EffectIntent, observedAt: string): Promise<void> {
    assertIntent(intent)
    assertIsoTime(observedAt, 'observedAt')
    const updated = await this.#client.query<EffectJournalRow>(`
      /* effect-journal:mark-outcome-unknown */
      UPDATE ${this.#tableName}
      SET status = 'outcome-unknown', observed_at = $3,
          receipt = NULL, committed_at = NULL
      WHERE idempotency_key = $1
        AND intent_digest = $2
        AND status = 'pending'
      RETURNING *
    `, [intent.idempotencyKey, intent.intentDigest, observedAt])
    if (updated.rows.length === 1) return
    const existing = await this.#requiredExisting(intent)
    if (existing.status === 'outcome-unknown') return
    throw new PostgresEffectJournalError(
      'invalid-transition',
      `Cannot mark an effect journal record outcome-unknown from ${existing.status}.`,
    )
  }

  async #requiredExisting(intent: EffectIntent): Promise<EffectJournalRecord<T>> {
    const existing = await this.#load(intent.idempotencyKey)
    if (existing === undefined) {
      throw new PostgresEffectJournalError('record-missing', 'Effect journal record is missing.')
    }
    if (existing.intent.intentDigest !== intent.intentDigest) {
      throw new PostgresEffectJournalError(
        'intent-conflict',
        'Idempotency key is already bound to a different effect intent.',
      )
    }
    return existing
  }

  async #load(idempotencyKey: string): Promise<EffectJournalRecord<T> | undefined> {
    const result = await this.#client.query<EffectJournalRow>(`
      /* effect-journal:load */
      SELECT * FROM ${this.#tableName}
      WHERE idempotency_key = $1
      LIMIT 1
    `, [idempotencyKey])
    const row = result.rows[0]
    return row === undefined ? undefined : rowToRecord<T>(row)
  }
}

function rowToRecord<T extends EffectJsonValue>(row: EffectJournalRow): EffectJournalRecord<T> {
  const intent = parseJson(row.intent)
  assertIntent(intent)
  if (intent.idempotencyKey !== row.idempotency_key ||
      intent.intentDigest !== row.intent_digest) {
    throw new PostgresEffectJournalError(
      'record-corrupt',
      'Stored effect intent does not match its indexed identity.',
    )
  }
  const claimedAt = isoTime(row.claimed_at, 'claimed_at')
  if (row.status === 'pending') return { status: 'pending', intent, claimedAt }
  if (row.status === 'outcome-unknown') {
    return {
      status: 'outcome-unknown',
      intent,
      observedAt: isoTime(row.observed_at, 'observed_at'),
    }
  }
  if (row.status === 'committed') {
    const receipt = parseJson(row.receipt)
    assertReceipt<T>(receipt, intent)
    isoTime(row.committed_at, 'committed_at')
    return { status: 'committed', intent, receipt }
  }
  throw new PostgresEffectJournalError('record-corrupt', 'Stored effect status is unsupported.')
}

function parseJson(value: unknown): unknown {
  try {
    return typeof value === 'string' ? JSON.parse(value) : JSON.parse(JSON.stringify(value))
  } catch {
    throw new PostgresEffectJournalError('record-corrupt', 'Stored effect JSON is unreadable.')
  }
}

function assertIntent(value: unknown): asserts value is EffectIntent {
  if (!validateEffectIntent(value).valid) {
    throw new PostgresEffectJournalError('invalid-input', 'Effect intent failed canonical custody.')
  }
}

function assertReceipt<T extends EffectJsonValue>(
  value: unknown,
  intent: EffectIntent,
): asserts value is EffectReceipt<T> {
  if (!validateEffectReceipt(value, intent).valid) {
    throw new PostgresEffectJournalError('record-corrupt', 'Effect receipt failed canonical custody.')
  }
}

function assertIsoTime(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new PostgresEffectJournalError('invalid-input', `${field} must be ISO-8601.`)
  }
}

function isoTime(value: unknown, field: string): string {
  const candidate = value instanceof Date ? value.toISOString() : value
  if (typeof candidate !== 'string' || !Number.isFinite(Date.parse(candidate))) {
    throw new PostgresEffectJournalError('record-corrupt', `${field} is not ISO-8601.`)
  }
  return candidate
}
