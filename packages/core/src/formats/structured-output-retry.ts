export interface StructuredOutputSchemaRef {
  schemaName: string
  schemaHash?: string | null
}

export type StructuredParseAttempt<T> =
  | { success: true; data: T }
  | { success: false; error: string }

export interface StructuredParseLoopSuccess<T, S, M> {
  success: true
  data: T
  raw: string
  retries: number
  state: S
  meta: M
}

export interface StructuredParseLoopFailure<S, M> {
  success: false
  retries: number
  state: S
  lastError: string | null
  lastRaw: string | null
  meta?: M
}

export type StructuredParseLoopResult<T, S, M> =
  | StructuredParseLoopSuccess<T, S, M>
  | StructuredParseLoopFailure<S, M>

export interface ExecuteStructuredParseLoopInput<T, S, M> {
  initialState: S
  maxRetries: number
  invoke: (state: S, attempt: number) => Promise<{ raw: string; meta: M }>
  parse: (raw: string) => StructuredParseAttempt<T>
  onRetryState: (state: S, input: {
    attempt: number
    raw: string
    error: string
    meta: M
  }) => S
}

export interface ExecuteStructuredParseStreamLoopInput<T, S, M, E> {
  initialState: S
  maxRetries: number
  invoke: (state: S, attempt: number) => AsyncGenerator<E, { raw: string; meta: M }, undefined>
  parse: (raw: string) => StructuredParseAttempt<T>
  onRetryState: (state: S, input: {
    attempt: number
    raw: string
    error: string
    meta: M
  }) => S
}

export type StructuredParseStreamLoopEvent<E, T, S, M> =
  | { type: 'event'; event: E }
  | { type: 'result'; result: StructuredParseLoopResult<T, S, M> }

export async function executeStructuredParseLoop<T, S, M>(
  input: ExecuteStructuredParseLoopInput<T, S, M>,
): Promise<StructuredParseLoopResult<T, S, M>> {
  let state = input.initialState
  let lastError: string | null = null
  let lastRaw: string | null = null
  let lastMeta: M | undefined

  for (let attempt = 0; attempt <= input.maxRetries; attempt++) {
    const invoked = await input.invoke(state, attempt)
    lastRaw = invoked.raw
    lastMeta = invoked.meta

    const parsed = input.parse(invoked.raw)
    if (parsed.success) {
      return {
        success: true,
        data: parsed.data,
        raw: invoked.raw,
        retries: attempt,
        state,
        meta: invoked.meta,
      }
    }

    lastError = parsed.error
    if (attempt < input.maxRetries) {
      state = input.onRetryState(state, {
        attempt,
        raw: invoked.raw,
        error: parsed.error,
        meta: invoked.meta,
      })
    }
  }

  return {
    success: false,
    retries: input.maxRetries,
    state,
    lastError,
    lastRaw,
    ...(lastMeta === undefined ? {} : { meta: lastMeta }),
  }
}

export async function* executeStructuredParseStreamLoop<T, S, M, E>(
  input: ExecuteStructuredParseStreamLoopInput<T, S, M, E>,
): AsyncGenerator<StructuredParseStreamLoopEvent<E, T, S, M>, void, undefined> {
  let state = input.initialState
  let lastError: string | null = null
  let lastRaw: string | null = null
  let lastMeta: M | undefined

  for (let attempt = 0; attempt <= input.maxRetries; attempt++) {
    const iterator = input.invoke(state, attempt)
    let invoked: { raw: string; meta: M } | null = null

    while (true) {
      const next = await iterator.next()
      if (next.done) {
        invoked = next.value
        break
      }

      yield { type: 'event', event: next.value }
    }

    if (!invoked) {
      throw new Error('Structured parse stream loop completed without a final invoke result')
    }

    lastRaw = invoked.raw
    lastMeta = invoked.meta

    const parsed = input.parse(invoked.raw)
    if (parsed.success) {
      yield {
        type: 'result',
        result: {
          success: true,
          data: parsed.data,
          raw: invoked.raw,
          retries: attempt,
          state,
          meta: invoked.meta,
        },
      }
      return
    }

    lastError = parsed.error
    if (attempt < input.maxRetries) {
      state = input.onRetryState(state, {
        attempt,
        raw: invoked.raw,
        error: parsed.error,
        meta: invoked.meta,
      })
    }
  }

  yield {
    type: 'result',
    result: {
      success: false,
      retries: input.maxRetries,
      state,
      lastError,
      lastRaw,
      ...(lastMeta === undefined ? {} : { meta: lastMeta }),
    },
  }
}

export function buildStructuredOutputCorrectionPrompt(
  schema: StructuredOutputSchemaRef & { description: string },
  error: string,
): string {
  return [
    `Your previous output did not match the required schema "${schema.schemaName}"${schema.schemaHash ? ` (${schema.schemaHash})` : ''}.`,
    `Error: ${error}`,
    `Please try again with the correct format: ${schema.description}`,
  ].join(' ')
}

export function buildStructuredOutputExhaustedError(
  schema: StructuredOutputSchemaRef,
  attempts: number,
): string {
  return `Failed to parse output matching schema "${schema.schemaName}"${schema.schemaHash ? ` (${schema.schemaHash})` : ''} after ${attempts} attempts`
}

export function isStructuredOutputExhaustedErrorMessage(
  message: string,
  schema: StructuredOutputSchemaRef,
): boolean {
  const prefix = `Failed to parse output matching schema "${schema.schemaName}"${schema.schemaHash ? ` (${schema.schemaHash})` : ''} after `
  return message.startsWith(prefix) && /\d+ attempts$/.test(message)
}
