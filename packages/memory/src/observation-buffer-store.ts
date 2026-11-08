/**
 * Restart-safe storage for the ObservationalMemory observer backlog.
 *
 * The observer extracts facts from a batch of conversation messages once a
 * threshold is reached. Messages below the threshold, and the batch of a run
 * that failed or whose handoff could not be verified, live only in process
 * memory. An {@link ObservationBufferStore} keeps that backlog across process
 * restarts until it is processed.
 *
 * The record holds raw conversation text (message type, content and id). It
 * is written directly to the backing store, so it bypasses MemoryService
 * sanitization and PII redaction: keep it in a private, non-searchable
 * namespace.
 */

import type { BaseStore } from '@langchain/langgraph'
import type { BaseMessage } from '@langchain/core/messages'
import {
  AIMessage,
  ChatMessage,
  FunctionMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages'

export const OBSERVATION_BUFFER_SCHEMA = 'dzupagent/observation-buffer/v1' as const

/** Message types the backlog can round-trip. */
export type PersistedObservationMessageType =
  | 'human'
  | 'ai'
  | 'system'
  | 'tool'
  | 'generic'
  | 'function'

/**
 * The message fields the observation extractor reads: `_getType()`,
 * `content` and `id`. `role`, `name` and `toolCallId` are kept only where the
 * message constructor requires them.
 */
export interface PersistedObservationMessage {
  type: PersistedObservationMessageType
  content: string | unknown[]
  id?: string | undefined
  role?: string | undefined
  name?: string | undefined
  toolCallId?: string | undefined
}

/** One backlog record per observer namespace and scope. */
export interface ObservationBufferRecord {
  schema: typeof OBSERVATION_BUFFER_SCHEMA
  targetNamespace: string
  scope: Record<string, string>
  /** The backlog, oldest first, never longer than the observer's cap. */
  messages: PersistedObservationMessage[]
  messagesSinceLastRun: number
  /** Monotonically increasing per record, also across restarts. */
  revision: number
  updatedAt: number
}

/** `failed` means the durable state is unknown, never that it is empty. */
export type ObservationBufferLoadResult =
  | { status: 'absent' }
  | { status: 'loaded'; record: ObservationBufferRecord }
  | { status: 'failed'; errorClass: string }

export interface ObservationBufferStore {
  /** Backing namespace, when known; must differ from the observation namespace. */
  readonly namespace?: string | undefined
  load(
    targetNamespace: string,
    scope: Record<string, string>,
  ): Promise<ObservationBufferLoadResult>
  /** Resolves `true` only when the store write resolved. */
  write(record: ObservationBufferRecord): Promise<boolean>
  /** Resolves `true` only when the store delete resolved. */
  delete(targetNamespace: string, scope: Record<string, string>): Promise<boolean>
}

/** A message whose extractor-visible fields cannot be stored and rebuilt. */
export class ObservationBufferSerializationError extends Error {
  override readonly name = 'ObservationBufferSerializationError'
  constructor(readonly messageType: string) {
    super(`observation buffer cannot round-trip a "${messageType}" message`)
  }
}

const SUPPORTED_TYPES = new Set<string>([
  'human',
  'ai',
  'system',
  'tool',
  'generic',
  'function',
])

/** Same text the extractor derives from a message (`observation-extractor.ts`). */
function extractorContent(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Rebuild a message from its persisted fields.
 * Throws {@link ObservationBufferSerializationError} for an unsupported type.
 */
export function deserializeObservationMessage(
  persisted: PersistedObservationMessage,
): BaseMessage {
  const content = persisted.content as string
  const id = persisted.id !== undefined ? { id: persisted.id } : {}
  switch (persisted.type) {
    case 'human':
      return new HumanMessage({ content, ...id })
    case 'ai':
      return new AIMessage({ content, ...id })
    case 'system':
      return new SystemMessage({ content, ...id })
    case 'tool':
      return new ToolMessage({ content, ...id, tool_call_id: persisted.toolCallId ?? '' })
    case 'generic':
      return new ChatMessage({ content, ...id, role: persisted.role ?? '' })
    case 'function':
      return new FunctionMessage({ content, ...id, name: persisted.name ?? '' })
    default:
      throw new ObservationBufferSerializationError(String(persisted.type))
  }
}

/**
 * Persist the fields the extractor reads and verify that the rebuilt message
 * presents the same type, content text and id.
 */
export function serializeObservationMessage(
  message: BaseMessage,
): PersistedObservationMessage {
  const type = message._getType()
  if (!SUPPORTED_TYPES.has(type)) {
    throw new ObservationBufferSerializationError(type)
  }
  const raw = message as unknown as Record<string, unknown>
  const id = typeof message.id === 'string' ? message.id : undefined
  const persisted: PersistedObservationMessage = {
    type: type as PersistedObservationMessageType,
    content: typeof message.content === 'string'
      ? message.content
      : jsonClone(message.content) as unknown[],
    ...(id !== undefined ? { id } : {}),
    ...(type === 'generic' ? { role: optionalString(raw['role']) ?? '' } : {}),
    ...(type === 'function' ? { name: optionalString(raw['name']) ?? '' } : {}),
    ...(type === 'tool' ? { toolCallId: optionalString(raw['tool_call_id']) ?? '' } : {}),
  }
  const rebuilt = deserializeObservationMessage(jsonClone(persisted))
  if (
    rebuilt._getType() !== type
    || extractorContent(rebuilt.content) !== extractorContent(message.content)
    || rebuilt.id !== message.id
  ) {
    throw new ObservationBufferSerializationError(type)
  }
  return persisted
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parsePersistedMessage(value: unknown): PersistedObservationMessage | null {
  if (!isRecord(value)) return null
  const type = value['type']
  const content = value['content']
  if (typeof type !== 'string' || !SUPPORTED_TYPES.has(type)) return null
  if (typeof content !== 'string' && !Array.isArray(content)) return null
  for (const field of ['id', 'role', 'name', 'toolCallId']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return null
  }
  return {
    type: type as PersistedObservationMessageType,
    content,
    ...(typeof value['id'] === 'string' ? { id: value['id'] } : {}),
    ...(typeof value['role'] === 'string' ? { role: value['role'] } : {}),
    ...(typeof value['name'] === 'string' ? { name: value['name'] } : {}),
    ...(typeof value['toolCallId'] === 'string' ? { toolCallId: value['toolCallId'] } : {}),
  }
}

/** Validate a stored value as a v1 record for this namespace and scope. */
export function parseObservationBufferRecord(
  value: unknown,
  targetNamespace: string,
  scope: Record<string, string>,
): ObservationBufferRecord | null {
  if (!isRecord(value)) return null
  if (
    value['schema'] !== OBSERVATION_BUFFER_SCHEMA
    || value['targetNamespace'] !== targetNamespace
    || !isRecord(value['scope'])
    || !Array.isArray(value['messages'])
    || typeof value['messagesSinceLastRun'] !== 'number'
    || !Number.isFinite(value['messagesSinceLastRun'])
    || value['messagesSinceLastRun'] < 0
    || typeof value['revision'] !== 'number'
    || !Number.isFinite(value['revision'])
    || typeof value['updatedAt'] !== 'number'
  ) {
    return null
  }
  const storedScope = value['scope']
  const scopeKeys = Object.keys(scope)
  if (
    Object.keys(storedScope).length !== scopeKeys.length
    || scopeKeys.some(key => storedScope[key] !== scope[key])
  ) {
    return null
  }
  const messages: PersistedObservationMessage[] = []
  for (const entry of value['messages']) {
    const parsed = parsePersistedMessage(entry)
    if (!parsed) return null
    messages.push(parsed)
  }
  return {
    schema: OBSERVATION_BUFFER_SCHEMA,
    targetNamespace,
    scope: { ...scope },
    messages,
    messagesSinceLastRun: value['messagesSinceLastRun'],
    revision: value['revision'],
    updatedAt: value['updatedAt'],
  }
}

export interface BaseStoreObservationBufferStoreOptions {
  /** Backing `BaseStore`; read with `store.get`, which rejects on failure. */
  store: BaseStore
  /**
   * Caller-named private namespace. It must not be the observation
   * namespace, and nothing should search it.
   */
  namespace: string
  /** Scope keys, in tuple order, taken from the observer scope. */
  scopeKeys: string[]
}

function bufferStorageKey(targetNamespace: string): string {
  return `observation-buffer:${encodeURIComponent(targetNamespace)}`
}

/**
 * {@link ObservationBufferStore} over a LangGraph `BaseStore`.
 *
 * Reads go straight to `store.get` by exact namespace tuple and key, so a
 * store failure is reported as `failed`, never as `absent`
 * (`MemoryService.get` returns `[]` on backing-store errors).
 */
export class BaseStoreObservationBufferStore implements ObservationBufferStore {
  readonly namespace: string
  private readonly store: BaseStore
  private readonly scopeKeys: string[]

  constructor(options: BaseStoreObservationBufferStoreOptions) {
    if (!options.namespace) {
      throw new Error('BaseStoreObservationBufferStore: namespace is required')
    }
    if (options.scopeKeys.length === 0) {
      throw new Error('BaseStoreObservationBufferStore: at least one scope key is required')
    }
    this.store = options.store
    this.namespace = options.namespace
    this.scopeKeys = [...options.scopeKeys]
  }

  private tuple(scope: Record<string, string>): string[] {
    return [
      this.namespace,
      ...this.scopeKeys.map(key => {
        const value = scope[key]
        if (!value) {
          throw new Error(`Missing scope key "${key}" for observation buffer namespace "${this.namespace}"`)
        }
        return value
      }),
    ]
  }

  async load(
    targetNamespace: string,
    scope: Record<string, string>,
  ): Promise<ObservationBufferLoadResult> {
    let item: Awaited<ReturnType<BaseStore['get']>>
    try {
      item = await this.store.get(this.tuple(scope), bufferStorageKey(targetNamespace))
    } catch (error: unknown) {
      return {
        status: 'failed',
        errorClass: error instanceof Error ? error.name : typeof error,
      }
    }
    if (!item) return { status: 'absent' }
    const record = parseObservationBufferRecord(item.value, targetNamespace, scope)
    // An unreadable record is unknown state, never "absent".
    return record
      ? { status: 'loaded', record }
      : { status: 'failed', errorClass: 'invalid-record' }
  }

  async write(record: ObservationBufferRecord): Promise<boolean> {
    try {
      await this.store.put(
        this.tuple(record.scope),
        bufferStorageKey(record.targetNamespace),
        jsonClone(record) as unknown as Record<string, unknown>,
        false,
      )
      return true
    } catch {
      return false
    }
  }

  async delete(
    targetNamespace: string,
    scope: Record<string, string>,
  ): Promise<boolean> {
    try {
      await this.store.delete(this.tuple(scope), bufferStorageKey(targetNamespace))
      return true
    } catch {
      return false
    }
  }
}
