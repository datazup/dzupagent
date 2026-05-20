import type {
  MemoryClient,
  MemoryRecord,
  MemoryScope,
  MemoryQuery,
  ReadContext,
  WriteContext,
  CancellationSignal,
} from '@dzupagent/agent-types'

export type HttpMemoryOperation = 'get' | 'put' | 'delete'

export interface HttpMemoryRequestResult {
  signal: 'http_memory_client_request_result'
  operation: HttpMemoryOperation
  namespace: string
  status?: number
  outcome: 'success' | 'http_error' | 'timeout' | 'aborted' | 'network_error'
  errorCode?: string
}

/**
 * Thrown when an `HttpMemoryClient` method is invoked but the remote wire
 * protocol has not yet been implemented.  Callers should treat this as a
 * hard failure — the operation will never succeed at runtime until the
 * underlying HTTP handler is shipped.
 *
 * @internal Not intended for direct use by consumers; exposed only so that
 * callers can `instanceof`-guard against it while the protocol is in progress.
 */
export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`HttpMemoryClient.${method} is not implemented yet.`)
    this.name = 'NotImplementedError'
  }
}

interface HttpMemoryErrorBody {
  error?: string
  message?: string
  code?: string
  details?: unknown
}

export class HttpMemoryError extends Error {
  readonly operation: HttpMemoryOperation
  readonly status?: number
  readonly errorCode?: string
  readonly details?: unknown

  constructor(
    message: string,
    operation: HttpMemoryOperation,
    options?: {
      status?: number
      errorCode?: string
      details?: unknown
      cause?: unknown
    },
  ) {
    super(message)
    this.name = 'HttpMemoryError'
    this.operation = operation
    if (options?.status !== undefined) this.status = options.status
    if (options?.errorCode !== undefined) this.errorCode = options.errorCode
    if (options?.details !== undefined) this.details = options.details
    if (options?.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

export class HttpMemoryTimeoutError extends HttpMemoryError {
  constructor(operation: HttpMemoryOperation, timeoutMs: number) {
    super(
      `HttpMemoryClient.${operation} timed out after ${timeoutMs}ms`,
      operation,
      { errorCode: 'HTTP_MEMORY_TIMEOUT' },
    )
    this.name = 'HttpMemoryTimeoutError'
  }
}

export class HttpMemoryAbortError extends HttpMemoryError {
  constructor(operation: HttpMemoryOperation) {
    super(
      `HttpMemoryClient.${operation} was aborted`,
      operation,
      { errorCode: 'HTTP_MEMORY_ABORTED' },
    )
    this.name = 'HttpMemoryAbortError'
  }
}

export class HttpMemoryResponseError extends HttpMemoryError {
  constructor(
    operation: HttpMemoryOperation,
    status: number,
    message: string,
    options?: { errorCode?: string; details?: unknown },
  ) {
    super(
      `HttpMemoryClient.${operation} failed with HTTP ${status}: ${message}`,
      operation,
      {
        status,
        ...(options?.errorCode !== undefined ? { errorCode: options.errorCode } : {}),
        ...(options?.details !== undefined ? { details: options.details } : {}),
      },
    )
    this.name = 'HttpMemoryResponseError'
  }
}

export interface HttpMemoryClientConfig {
  baseUrl: string
  apiKey?: string
  timeoutMs?: number
  headers?: Record<string, string>
  /** Optional fetch override for testing or non-browser environments. */
  fetch?: typeof fetch
  /** Optional structured diagnostics callback for request outcomes. */
  onRequestResult?: (result: HttpMemoryRequestResult) => void
}

interface RequestSignalContext {
  signal: AbortSignal
  cleanup: () => void
  didTimeout: () => boolean
}

const DEFAULT_TIMEOUT_MS = 10_000
const SCOPE_FIELDS: Array<keyof MemoryScope> = [
  'tenantId',
  'workspaceId',
  'projectId',
  'taskId',
]

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : err instanceof Error && err.name === 'AbortError'
}

function validateScope(scope: MemoryScope): void {
  if (!scope || typeof scope !== 'object') {
    throw new Error('Memory scope must be an object')
  }

  for (const field of SCOPE_FIELDS) {
    const value = scope[field]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Memory scope field "${field}" must be a non-empty string when provided`)
    }
  }

  if (!scope.tenantId || scope.tenantId.trim().length === 0) {
    throw new Error('Memory scope requires tenantId')
  }
}

function validateNamespace(namespace: string): void {
  if (namespace.trim().length === 0) {
    throw new Error('Memory namespace must be non-empty')
  }
}

function validateRecord(record: MemoryRecord, namespace: string, scope: MemoryScope): void {
  if (record.namespace !== namespace) {
    throw new Error(`Memory record namespace mismatch: expected "${namespace}", got "${record.namespace}"`)
  }

  validateScope(record.scope)

  if (record.scope.tenantId !== scope.tenantId) {
    throw new Error('Memory record scope tenantId must match request scope tenantId')
  }
}

function validateQuery(query?: MemoryQuery): void {
  if (!query) return

  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 0)) {
    throw new Error('Memory query limit must be a non-negative integer when provided')
  }
  if (query.offset !== undefined && (!Number.isInteger(query.offset) || query.offset < 0)) {
    throw new Error('Memory query offset must be a non-negative integer when provided')
  }
  if (query.search !== undefined && typeof query.search !== 'string') {
    throw new Error('Memory query search must be a string when provided')
  }
}

function createRequestSignal(
  timeoutMs: number,
  externalSignal?: ReadContext['signal'] | WriteContext['signal'],
): RequestSignalContext {
  const controller = new AbortController()
  let timedOut = false

  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  let detachExternalAbort: (() => void) | undefined

  if (externalSignal?.aborted) {
    controller.abort()
  } else if (externalSignal?.addEventListener) {
    const onAbort = (): void => {
      controller.abort()
    }
    externalSignal.addEventListener('abort', onAbort)
    detachExternalAbort = () => {
      externalSignal.removeEventListener?.('abort', onAbort)
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      detachExternalAbort?.()
    },
    didTimeout: () => timedOut,
  }
}

function decodeErrorBody(payload: unknown): HttpMemoryErrorBody {
  if (!payload || typeof payload !== 'object') {
    return {}
  }

  const obj = payload as Record<string, unknown>
  return {
    ...(typeof obj['error'] === 'string' ? { error: obj['error'] } : {}),
    ...(typeof obj['message'] === 'string' ? { message: obj['message'] } : {}),
    ...(typeof obj['code'] === 'string' ? { code: obj['code'] } : {}),
    ...(obj['details'] !== undefined ? { details: obj['details'] } : {}),
  }
}

export class HttpMemoryClient implements MemoryClient {
  /** Retained for inspection by tooling once the wire protocol lands. */
  readonly config: HttpMemoryClientConfig

  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(config: HttpMemoryClientConfig) {
    if (!config.baseUrl) {
      throw new Error('HttpMemoryClient requires baseUrl')
    }

    this.config = config
    this.baseUrl = normalizeBaseUrl(config.baseUrl)
    this.fetchImpl = config.fetch ?? globalThis.fetch

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('HttpMemoryClient requires fetch to be available')
    }
  }

  async get(
    namespace: string,
    scope: MemoryScope,
    query?: MemoryQuery,
    ctx?: ReadContext,
  ): Promise<MemoryRecord[]> {
    validateNamespace(namespace)
    validateScope(scope)
    validateQuery(query)

    const params = new URLSearchParams()
    params.set('scope', JSON.stringify(scope))
    if (query !== undefined) {
      params.set('query', JSON.stringify(query))
    }

    const endpoint = `${this.buildNamespaceUrl(namespace)}?${params.toString()}`

    const response = await this.request('get', endpoint, {
      method: 'GET',
      ...(ctx?.signal !== undefined ? { signal: ctx.signal as unknown as AbortSignal } : {}),
    }, namespace)

    const payload = await this.parseJsonBody(response)

    if (Array.isArray(payload)) {
      return payload as MemoryRecord[]
    }

    if (payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>)['records'])) {
      return (payload as { records: MemoryRecord[] }).records
    }

    return []
  }

  async put(
    namespace: string,
    scope: MemoryScope,
    record: MemoryRecord,
    ctx?: WriteContext,
  ): Promise<void> {
    validateNamespace(namespace)
    validateScope(scope)
    validateRecord(record, namespace, scope)

    await this.request('put', this.buildRecordUrl(namespace, record.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ scope, record }),
      ...(ctx?.signal !== undefined ? { signal: ctx.signal as unknown as AbortSignal } : {}),
    }, namespace)
  }

  async delete(
    namespace: string,
    scope: MemoryScope,
    recordId: string,
  ): Promise<boolean> {
    validateNamespace(namespace)
    validateScope(scope)

    if (recordId.trim().length === 0) {
      throw new Error('Memory recordId must be non-empty')
    }

    const params = new URLSearchParams()
    params.set('scope', JSON.stringify(scope))

    const response = await this.request('delete', `${this.buildRecordUrl(namespace, recordId)}?${params.toString()}`,
      {
        method: 'DELETE',
      },
      namespace)

    if (response.status === 204) {
      return true
    }

    const payload = await this.parseJsonBody(response)

    if (typeof payload === 'boolean') {
      return payload
    }

    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>
      if (typeof obj['deleted'] === 'boolean') {
        return obj['deleted']
      }
      if (typeof obj['ok'] === 'boolean') {
        return obj['ok']
      }
    }

    return true
  }

  private buildNamespaceUrl(namespace: string): string {
    return `${this.baseUrl}/memory/${encodeURIComponent(namespace)}`
  }

  private buildRecordUrl(namespace: string, recordId: string): string {
    return `${this.buildNamespaceUrl(namespace)}/${encodeURIComponent(recordId)}`
  }

  private buildHeaders(extraHeaders?: Record<string, string>): Headers {
    const headers = new Headers()
    headers.set('Accept', 'application/json; charset=utf-8')

    for (const [key, value] of Object.entries(this.config.headers ?? {})) {
      headers.set(key, value)
    }

    if (this.config.apiKey) {
      headers.set('Authorization', `Bearer ${this.config.apiKey}`)
    }

    for (const [key, value] of Object.entries(extraHeaders ?? {})) {
      headers.set(key, value)
    }

    return headers
  }

  private async request(
    operation: HttpMemoryOperation,
    url: string,
    init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
    namespace: string,
  ): Promise<Response> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const requestSignal = createRequestSignal(timeoutMs, init.signal as CancellationSignal | undefined)

    try {
      const { signal: _initSignal, headers: _initHeaders, ...restInit } = init
      const response = await this.fetchImpl(url, {
        ...restInit,
        headers: this.buildHeaders(_initHeaders),
        signal: requestSignal.signal,
      })

      if (!response.ok) {
        const mapped = await this.mapHttpError(operation, response)
        this.emitRequestResult({
          signal: 'http_memory_client_request_result',
          operation,
          namespace,
          ...(mapped.status !== undefined ? { status: mapped.status } : {}),
          outcome: 'http_error',
          ...(mapped.errorCode !== undefined ? { errorCode: mapped.errorCode } : {}),
        })
        throw mapped
      }

      this.emitRequestResult({
        signal: 'http_memory_client_request_result',
        operation,
        namespace,
        status: response.status,
        outcome: 'success',
      })

      return response
    } catch (err) {
      if (isAbortError(err)) {
        const timeoutError = requestSignal.didTimeout()
          ? new HttpMemoryTimeoutError(operation, timeoutMs)
          : new HttpMemoryAbortError(operation)

        this.emitRequestResult({
          signal: 'http_memory_client_request_result',
          operation,
          namespace,
          outcome: requestSignal.didTimeout() ? 'timeout' : 'aborted',
          ...(timeoutError.errorCode !== undefined ? { errorCode: timeoutError.errorCode } : {}),
        })
        throw timeoutError
      }

      if (err instanceof HttpMemoryError) {
        throw err
      }

      const mapped = new HttpMemoryError(
        `HttpMemoryClient.${operation} request failed`,
        operation,
        {
          errorCode: 'HTTP_MEMORY_NETWORK_ERROR',
          cause: err,
        },
      )

      this.emitRequestResult({
        signal: 'http_memory_client_request_result',
        operation,
        namespace,
        outcome: 'network_error',
        ...(mapped.errorCode !== undefined ? { errorCode: mapped.errorCode } : {}),
      })

      throw mapped
    } finally {
      requestSignal.cleanup()
    }
  }

  private async mapHttpError(
    operation: HttpMemoryOperation,
    response: Response,
  ): Promise<HttpMemoryResponseError> {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''

    let message = response.statusText || 'Request failed'
    let errorCode: string | undefined
    let details: unknown

    if (contentType.includes('application/json')) {
      const parsed = decodeErrorBody(await this.parseJsonBody(response))
      message = parsed.message ?? parsed.error ?? message
      errorCode = parsed.code
      details = parsed.details
    } else {
      const text = await response.text()
      if (text.trim().length > 0) {
        message = text
      }
    }

    return new HttpMemoryResponseError(operation, response.status, message, {
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(details !== undefined ? { details } : {}),
    })
  }

  private async parseJsonBody(response: Response): Promise<unknown> {
    const text = await response.text()
    if (text.length === 0) {
      return undefined
    }

    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  }

  private emitRequestResult(result: HttpMemoryRequestResult): void {
    this.config.onRequestResult?.(result)
  }
}
