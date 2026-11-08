/**
 * Pure mappers between the internal A2A task records and the A2A v0.3.0
 * `message/send` wire shapes (A2A-05-SERVER-V030-20261108-R1).
 *
 * The internal records carry no ids for messages or artifacts, so ids are
 * synthesized deterministically (`<taskId>-m<i>`, `<taskId>-a<i>`); the client's
 * own `messageId` is validated but not persisted.
 */
import type { A2AMessagePart, A2ATask, A2ATaskMessage, A2ATaskState } from './a2a-types.js'

export type PartV030 = { kind: 'text'; text: string } | { kind: 'data'; data: Record<string, unknown> }

export interface MessageV030 {
  kind: 'message'
  messageId: string
  role: 'user' | 'agent'
  parts: PartV030[]
  taskId?: string
  contextId?: string
}

export type TaskStateV030 = Exclude<A2ATaskState, 'cancelled'> | 'canceled'

export interface TaskV030 {
  kind: 'task'
  id: string
  contextId: string
  status: { state: TaskStateV030; timestamp: string }
  history: MessageV030[]
  artifacts: Array<{ artifactId: string; name?: string; parts: PartV030[] }>
  metadata?: Record<string, unknown>
}

export type ParsedMessageV030 =
  | { ok: true; message: A2ATaskMessage; taskId?: string; contextId?: string }
  | { ok: false; reason: 'invalid' | 'content'; detail: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Validates a v0.3.0 message from the wire and maps it to the internal message. */
export function parseMessageV030(value: unknown): ParsedMessageV030 {
  const invalid = (detail: string): ParsedMessageV030 => ({ ok: false, reason: 'invalid', detail })
  if (!isRecord(value)) return invalid('params.message must be an object')
  if (value['kind'] !== undefined && value['kind'] !== 'message') return invalid('message.kind must be "message"')
  if (typeof value['messageId'] !== 'string' || value['messageId'].length === 0) return invalid('message.messageId is required')
  const role = value['role']
  if (role !== 'user' && role !== 'agent') return invalid('message.role must be "user" or "agent"')
  const parts = value['parts']
  if (!Array.isArray(parts) || parts.length === 0) return invalid('message.parts must be a non-empty array')
  const mapped: A2AMessagePart[] = []
  for (const part of parts) {
    if (!isRecord(part)) return invalid('each part must be an object')
    if (part['kind'] === 'file') return { ok: false, reason: 'content', detail: 'file parts are not supported' }
    if (part['kind'] === 'text') {
      if (typeof part['text'] !== 'string') return invalid('a text part needs a string text')
      mapped.push({ type: 'text', text: part['text'] })
    } else if (part['kind'] === 'data') {
      if (!isRecord(part['data'])) return invalid('a data part needs an object data')
      mapped.push({ type: 'data', data: part['data'] })
    } else {
      return invalid('part.kind must be "text", "data" or "file"')
    }
  }
  const taskId = value['taskId']
  const contextId = value['contextId']
  if (taskId !== undefined && (typeof taskId !== 'string' || taskId.length === 0)) return invalid('message.taskId must be a non-empty string')
  if (contextId !== undefined && (typeof contextId !== 'string' || contextId.length === 0)) return invalid('message.contextId must be a non-empty string')
  return {
    ok: true,
    message: { role, parts: mapped },
    ...(taskId === undefined ? {} : { taskId }),
    ...(contextId === undefined ? {} : { contextId }),
  }
}

export const stateToV030 = (state: A2ATaskState): TaskStateV030 => (state === 'cancelled' ? 'canceled' : state)

/** An unknown internal part type keeps its marker as data (the payload is not carried). */
export function partToV030(part: A2AMessagePart): PartV030 {
  if (part.type === 'text' && typeof part.text === 'string') return { kind: 'text', text: part.text }
  if (part.type === 'data' && part.data !== undefined) return { kind: 'data', data: part.data }
  return { kind: 'data', data: { type: part.type } }
}

export function taskToV030(task: A2ATask, contextId?: string): TaskV030 {
  return {
    kind: 'task',
    id: task.id,
    contextId: contextId ?? task.id,
    status: { state: stateToV030(task.state), timestamp: task.updatedAt },
    history: task.messages.map((message, index) => ({
      kind: 'message',
      messageId: `${task.id}-m${index}`,
      role: message.role,
      parts: message.parts.map(partToV030),
    })),
    artifacts: task.artifacts.map((artifact, position) => ({
      artifactId: `${task.id}-a${artifact.index ?? position}`,
      ...(artifact.name === undefined ? {} : { name: artifact.name }),
      parts: artifact.parts.map(partToV030),
    })),
    ...(task.metadata === undefined ? {} : { metadata: task.metadata }),
  }
}
