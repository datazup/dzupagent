/**
 * Zod validation schemas for ForgeMessage envelope types.
 *
 * All exported schemas use PascalCase (per S3 convention).
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// URI schema for message routing
// ---------------------------------------------------------------------------

/**
 * Accepts multiple URI schemes used in message routing:
 * forge://, a2a://, mcp://, http://, https://, ws://, wss://, grpc://
 *
 * This is intentionally broader than ForgeUriSchema (identity module),
 * which only accepts `forge://` URIs.
 */
const MESSAGE_URI_REGEX = /^(forge|a2a|mcp|http|https|ws|wss|grpc):\/\/.+$/

export const ForgeMessageUriSchema = z.string().regex(MESSAGE_URI_REGEX, {
  message:
    'Invalid message URI. Expected scheme: forge://, a2a://, mcp://, http(s)://, ws(s)://, or grpc://',
})

// ---------------------------------------------------------------------------
// Enums / primitives
// ---------------------------------------------------------------------------

const ForgeMessageTypeSchema = z.enum([
  'request',
  'response',
  'notification',
  'stream_chunk',
  'stream_end',
  'error',
])

const ForgeProtocolSchema = z.string().min(1)

const MessagePrioritySchema = z.enum(['low', 'normal', 'high', 'urgent'])

const ForgeMessageIdSchema = z.string().min(1)

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

const MessageBudgetSchema = z.object({
  maxTokens: z.number().positive().optional(),
  maxCostCents: z.number().nonnegative().optional(),
  maxDurationMs: z.number().positive().optional(),
})

// ---------------------------------------------------------------------------
// Metadata (passthrough to allow extension keys)
// ---------------------------------------------------------------------------

export const ForgeMessageMetadataSchema = z
  .object({
    traceId: z.string().optional(),
    spanId: z.string().optional(),
    priority: MessagePrioritySchema.optional(),
    ttlMs: z.number().positive().optional(),
    delegationTokenId: z.string().optional(),
    budget: MessageBudgetSchema.optional(),
  })
  .passthrough()

// ---------------------------------------------------------------------------
// Payload (discriminated union on `type`)
// ---------------------------------------------------------------------------

const TextPayloadSchema = z.object({
  type: z.literal('text'),
  content: z.string(),
})

const JsonPayloadSchema = z.object({
  type: z.literal('json'),
  data: z.record(z.string(), z.unknown()),
})

const ToolCallPayloadSchema = z.object({
  type: z.literal('tool_call'),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  callId: z.string().min(1),
})

const ToolResultPayloadSchema = z.object({
  type: z.literal('tool_result'),
  callId: z.string().min(1),
  result: z.unknown(),
  isError: z.boolean().optional(),
})

const TaskPayloadSchema = z.object({
  type: z.literal('task'),
  taskId: z.string().min(1),
  description: z.string().min(1),
  context: z.record(z.string(), z.unknown()).optional(),
})

const BinaryPayloadSchema = z.object({
  type: z.literal('binary'),
  mimeType: z.string().min(1),
  data: z.instanceof(Uint8Array),
  description: z.string().optional(),
})

const ErrorPayloadSchema = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
})

export const ForgePayloadSchema = z.discriminatedUnion('type', [
  TextPayloadSchema,
  JsonPayloadSchema,
  ToolCallPayloadSchema,
  ToolResultPayloadSchema,
  TaskPayloadSchema,
  BinaryPayloadSchema,
  ErrorPayloadSchema,
])

// ---------------------------------------------------------------------------
// Message envelope (strict on known fields, metadata is passthrough)
// ---------------------------------------------------------------------------

export const ForgeMessageSchema = z.object({
  id: ForgeMessageIdSchema,
  type: ForgeMessageTypeSchema,
  from: ForgeMessageUriSchema,
  to: ForgeMessageUriSchema,
  protocol: ForgeProtocolSchema,
  timestamp: z.string().min(1),
  correlationId: z.string().optional(),
  parentId: ForgeMessageIdSchema.optional(),
  payload: ForgePayloadSchema,
  metadata: ForgeMessageMetadataSchema,
}).strict()
