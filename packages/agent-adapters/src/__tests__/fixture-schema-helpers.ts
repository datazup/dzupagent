import { z } from 'zod'

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function hasString(value: unknown): boolean {
  return typeof value === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasAnyStringField(
  record: Record<string, unknown>,
  keys: string[],
): boolean {
  return keys.some((key) => hasString(record[key]))
}

function hasAnyNonEmptyStringField(
  record: Record<string, unknown>,
  keys: string[],
): boolean {
  return keys.some((key) => hasNonEmptyString(record[key]))
}

function hasNestedToolName(record: Record<string, unknown>): boolean {
  const tool = record['tool']
  return isRecord(tool) && hasNonEmptyString(tool['name'])
}

function hasNestedToolResultName(record: Record<string, unknown>): boolean {
  const toolResult = record['tool_result']
  const functionResponse = record['function_response']
  return (
    (isRecord(toolResult) && hasNonEmptyString(toolResult['name']))
    || (isRecord(functionResponse) && hasNonEmptyString(functionResponse['name']))
  )
}

function hasAnyNestedPayload(record: Record<string, unknown>): boolean {
  const toolResult = record['tool_result']
  const functionResponse = record['function_response']
  return (
    (isRecord(toolResult) && ('result' in toolResult || 'output' in toolResult || 'content' in toolResult))
    || (isRecord(functionResponse) && ('result' in functionResponse || 'output' in functionResponse || 'content' in functionResponse))
  )
}

function hasNestedErrorMessage(record: Record<string, unknown>): boolean {
  const errorValue = record['error']
  if (hasString(errorValue)) return true
  if (!isRecord(errorValue)) return false
  return hasString(errorValue['message'])
}

const qwenRecordSchema = z.union([
  z.object({ event: z.literal('message'), text: z.string() }),
  z.object({
    type: z.literal('tool_call'),
  }).passthrough().superRefine((record, ctx) => {
    if (!hasAnyNonEmptyStringField(record, ['name', 'tool_name', 'function']) && !hasNestedToolName(record)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tool_call requires a tool name (top-level or nested)',
      })
    }
  }),
  z.object({
    type: z.literal('tool_result'),
  }).passthrough().superRefine((record, ctx) => {
    if (!hasAnyNonEmptyStringField(record, ['name', 'tool_name']) && !hasNestedToolResultName(record)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tool_result requires a tool name (top-level or nested)',
      })
    }
    if (!('result' in record || 'output' in record || 'content' in record) && !hasAnyNestedPayload(record)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tool_result requires a payload field',
      })
    }
  }),
  z.object({ type: z.literal('stream_delta') }).passthrough().superRefine((record, ctx) => {
    if (!hasAnyStringField(record, ['text', 'content', 'delta'])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'stream_delta requires text/content/delta',
      })
    }
  }),
  z.object({ type: z.enum(['completed', 'done']) }).passthrough().superRefine((record, ctx) => {
    if (!hasAnyStringField(record, ['result', 'content', 'output', 'text'])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'completed requires a result/content/output/text field',
      })
    }
  }),
  z.object({ type: z.literal('error') }).passthrough().superRefine((record, ctx) => {
    if (!hasAnyStringField(record, ['message']) && !hasNestedErrorMessage(record)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'error requires message or error.message',
      })
    }
  }),
])

const crushRecordSchema = z.union([
  z.object({ event: z.literal('message'), text: z.string() }),
  z.object({ type: z.literal('tool_call') }).passthrough().superRefine((record, ctx) => {
    if (!hasAnyNonEmptyStringField(record, ['name', 'tool_name']) && !hasNestedToolName(record)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tool_call requires a tool name (top-level or nested)',
      })
    }
  }),
  z.object({ type: z.literal('tool_result') }).passthrough().superRefine((record, ctx) => {
    if (!hasAnyNonEmptyStringField(record, ['name', 'tool_name']) && !hasNestedToolResultName(record)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tool_result requires a tool name (top-level or nested)',
      })
    }
    if (!('result' in record || 'output' in record || 'content' in record) && !hasAnyNestedPayload(record)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tool_result requires a payload field',
      })
    }
  }),
  z.object({ type: z.literal('stream_delta') }).passthrough().superRefine((record, ctx) => {
    if (!hasAnyStringField(record, ['text', 'content', 'delta'])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'stream_delta requires text/content/delta',
      })
    }
  }),
  z.object({ type: z.enum(['completed', 'done']) }).passthrough().superRefine((record, ctx) => {
    if (!hasAnyStringField(record, ['result', 'content', 'output', 'text'])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'completed requires a result/content/output/text field',
      })
    }
  }),
  z.object({ type: z.literal('error') }).passthrough().superRefine((record, ctx) => {
    if (!hasAnyStringField(record, ['message']) && !hasNestedErrorMessage(record)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'error requires message or error.message',
      })
    }
  }),
])

const geminiRecordSchema = z.union([
  z.object({ event: z.literal('message'), text: z.string() }),
  z.object({ type: z.enum(['tool_call', 'function_call']) }).passthrough().superRefine((record, ctx) => {
    if (!hasAnyNonEmptyStringField(record, ['name', 'tool_name', 'function']) && !hasNestedToolName(record)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tool/function call requires a name (top-level or nested)',
      })
    }
  }),
  z.object({ type: z.enum(['tool_result', 'function_response']) }).passthrough().superRefine((record, ctx) => {
    if (!hasAnyNonEmptyStringField(record, ['name', 'tool_name']) && !hasNestedToolResultName(record)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tool/function result requires a name (top-level or nested)',
      })
    }
    if (!('result' in record || 'output' in record || 'content' in record) && !hasAnyNestedPayload(record)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tool/function result requires a payload field',
      })
    }
  }),
  z.object({ type: z.literal('stream_delta') }).passthrough().superRefine((record, ctx) => {
    if (!hasAnyStringField(record, ['text', 'content', 'delta'])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'stream_delta requires text/content/delta',
      })
    }
  }),
  z.object({ type: z.enum(['completed', 'done']) }).passthrough().superRefine((record, ctx) => {
    if (!hasAnyStringField(record, ['result', 'content', 'output', 'text'])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'completed requires a result/content/output/text field',
      })
    }
  }),
  z.object({ type: z.literal('error') }).passthrough().superRefine((record, ctx) => {
    if (!hasAnyStringField(record, ['message']) && !hasNestedErrorMessage(record)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'error requires message or error.message',
      })
    }
  }),
])

export function assertDeterministicAdapterFixtureShape(
  fixtureName: string,
  records: Record<string, unknown>[],
): void {
  const schema = fixtureName.startsWith('qwen-')
    ? qwenRecordSchema
    : fixtureName.startsWith('crush-')
      ? crushRecordSchema
      : fixtureName.startsWith('gemini-')
        ? geminiRecordSchema
        : null

  if (!schema) return

  for (let i = 0; i < records.length; i++) {
    const parsed = schema.safeParse(records[i])
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new Error(
        `Unknown ${fixtureName} event shape at index ${i}: ${issue?.message ?? 'invalid record'}`,
      )
    }
  }
}
