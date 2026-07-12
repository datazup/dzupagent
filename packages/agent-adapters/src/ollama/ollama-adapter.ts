/** Direct Ollama/local OpenAI-compatible backend. Goose is not involved. */

import { randomUUID } from 'node:crypto'
import { ForgeError } from '@dzupagent/core/events'
import { fetchWithOutboundUrlPolicy } from '@dzupagent/core/security'
import type {
  LocalModelCapabilityProfile,
  LocalModelHealthSnapshot,
  LocalModelInventoryEntry,
} from '@dzupagent/runtime-contracts'
import type {
  AdapterCapabilityProfile,
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  HealthStatus,
} from '../types.js'
import { AdapterStreamRunner } from '../base/stream-runner.js'
import type { AdapterStreamSource, StreamContext } from '../base/stream-runner.js'
import { getDefaultMonitorStatus } from '../provider-catalog.js'
import { resolveOpenAITools } from '../openai/openai-tool-calls.js'
import { httpErrorToForgeError } from '../utils/http-error.js'
import { localEndpointUrl, resolveLocalModelEndpoint } from './local-model-endpoint.js'
import type {
  LocalModelInspection,
  OllamaAdapterConfig,
  OllamaChatChunk,
  OllamaShowResponse,
  ResolvedLocalModelEndpoint,
} from './ollama-types.js'

export type { OllamaAdapterConfig, LocalModelInspection } from './ollama-types.js'
export { resolveLocalModelEndpoint } from './local-model-endpoint.js'

const PROVIDER_ID: AdapterProviderId = 'ollama'
const DEFAULT_MODEL = 'qwen3'
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024
const DEFAULT_MAX_RECORDS = 100_000

type LocalRawEvent =
  | { kind: 'delta'; content: string }
  | { kind: 'tool'; name: string; input: unknown }
  | { kind: 'completed'; content: string; inputTokens: number; outputTokens: number; durationMs: number }

export class OllamaAdapter implements AgentCLIAdapter {
  readonly providerId = PROVIDER_ID
  readonly backend = 'local-model' as const
  private config: OllamaAdapterConfig
  private readonly activeControllers = new Set<AbortController>()

  constructor(config: OllamaAdapterConfig = {}) {
    this.config = { ...config }
    resolveLocalModelEndpoint(this.config)
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: false,
      nativeToolControls: { mode: true, allowlist: true, blocklist: true },
    }
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const endpoint = resolveLocalModelEndpoint(this.config)
    const model = stringValue(input.options?.['model']) ?? this.config.model ?? DEFAULT_MODEL
    this.validateInput(input)
    const inspection = await this.inspectModel(model, input.signal)
    this.validateCapabilities(input, inspection.capabilities)
    const sessionId = randomUUID()
    let fullText = ''
    let controller: AbortController | undefined
    const adapter = this
    const source: AdapterStreamSource<LocalRawEvent> = {
      providerId: PROVIDER_ID,
      open(runInput, signal) {
        return adapter.openChat(endpoint, model, inspection.capabilities, runInput, signal)
      },
      mapRawEvent(raw, context) {
        return mapLocalEvent(raw, context, sessionId, () => fullText, (value) => { fullText += value })
      },
    }
    const runner = new AdapterStreamRunner<LocalRawEvent>({
      emitStartedImmediately: true,
      emitFailedOnAbort: true,
      initialSessionId: sessionId,
      startedExtra: { model },
      onAbortController(ctrl) {
        controller = ctrl
        adapter.activeControllers.add(ctrl)
      },
      ...(this.config.auditSink ? { auditSink: this.config.auditSink } : {}),
      auditModel: model,
      ...(this.config.auditRunId ? { auditRunId: this.config.auditRunId } : {}),
      ...(this.config.auditTenantId ? { auditTenantId: this.config.auditTenantId } : {}),
    })
    try {
      yield* runner.run(source, input, input.signal)
    } finally {
      if (controller) this.activeControllers.delete(controller)
    }
  }

  async listModels(signal?: AbortSignal): Promise<LocalModelInventoryEntry[]> {
    const endpoint = resolveLocalModelEndpoint(this.config)
    if (endpoint.protocol === 'ollama') {
      const response = await this.request(endpoint, 'api/tags', { method: 'GET', signal })
      const body = await readBoundedJson(response, this.limits()) as { models?: unknown[] }
      return (body.models ?? []).flatMap((value) => mapOllamaInventory(value))
    }
    const response = await this.request(endpoint, 'models', { method: 'GET', signal })
    const body = await readBoundedJson(response, this.limits()) as { data?: unknown[] }
    return (body.data ?? []).flatMap((value) => {
      if (!isObject(value) || typeof value['id'] !== 'string') return []
      return [{ id: value['id'], name: value['id'] }]
    })
  }

  async inspectModel(model: string, signal?: AbortSignal): Promise<LocalModelInspection> {
    const endpoint = resolveLocalModelEndpoint(this.config)
    const inventory = await this.listModels(signal)
    const found = inventory.find((entry) => modelNamesMatch(entry.id, model) || modelNamesMatch(entry.name, model))
    if (!found) throw modelUnavailable(model)
    if (endpoint.protocol === 'openai-compatible') {
      return { model: found, capabilities: declaredCapabilities(this.config, model) }
    }
    const response = await this.request(endpoint, 'api/show', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal,
    })
    const show = await readBoundedJson(response, this.limits()) as OllamaShowResponse
    const capabilities = mapOllamaCapabilities(show)
    return { model: { ...found, capabilities }, capabilities }
  }

  async healthSnapshot(): Promise<LocalModelHealthSnapshot> {
    const endpoint = resolveLocalModelEndpoint(this.config)
    try {
      const models = await this.listModels()
      return { healthy: true, endpoint: endpoint.baseUrl, protocol: endpoint.protocol, modelCount: models.length, checkedAt: new Date().toISOString() }
    } catch (error) {
      return { healthy: false, endpoint: endpoint.baseUrl, protocol: endpoint.protocol, checkedAt: new Date().toISOString(), errorCode: errorCode(error) }
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const snapshot = await this.healthSnapshot()
    return {
      healthy: snapshot.healthy,
      providerId: PROVIDER_ID,
      sdkInstalled: true,
      cliAvailable: false,
      lastError: snapshot.healthy ? undefined : snapshot.errorCode ?? 'Local model service unavailable',
      monitorStatus: getDefaultMonitorStatus(PROVIDER_ID),
    }
  }

  async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {
    throw new ForgeError({ code: 'CAPABILITY_DENIED', message: 'Direct local-model calls do not expose durable sessions', recoverable: false, context: { providerId: PROVIDER_ID, backend: this.backend } })
  }

  interrupt(): void {
    for (const controller of this.activeControllers) controller.abort()
    this.activeControllers.clear()
  }

  configure(opts: Partial<OllamaAdapterConfig>): void {
    const next = { ...this.config, ...opts }
    resolveLocalModelEndpoint(next)
    this.config = next
  }

  private async *openChat(
    endpoint: ResolvedLocalModelEndpoint,
    model: string,
    capabilities: LocalModelCapabilityProfile,
    input: AgentInput,
    signal: AbortSignal,
  ): AsyncGenerator<LocalRawEvent, void, undefined> {
    const timeout = createTimeoutSignal(signal, this.config.timeoutMs)
    const startedAt = Date.now()
    try {
      const response = endpoint.protocol === 'ollama'
        ? await this.request(endpoint, 'api/chat', buildOllamaRequest(model, input, capabilities, timeout.signal))
        : await this.request(endpoint, 'chat/completions', buildOpenAICompatibleRequest(this.config, model, input, capabilities, timeout.signal))
      let fullText = ''
      let inputTokens = 0
      let outputTokens = 0
      if (endpoint.protocol === 'ollama') {
        for await (const record of readBoundedNdjson(response, this.limits(), timeout.signal)) {
          const chunk = record as OllamaChatChunk
          const content = chunk.message?.content
          if (content) { fullText += content; yield { kind: 'delta', content } }
          for (const call of chunk.message?.tool_calls ?? []) {
            const name = call.function?.name
            if (name) yield { kind: 'tool', name, input: call.function?.arguments ?? {} }
          }
          if (chunk.done) {
            inputTokens = numberValue(chunk.prompt_eval_count)
            outputTokens = numberValue(chunk.eval_count)
          }
        }
      } else {
        for await (const data of readBoundedSse(response, this.limits(), timeout.signal)) {
          const chunk = JSON.parse(data) as Record<string, unknown>
          const choices = Array.isArray(chunk['choices']) ? chunk['choices'] : []
          const choice = isObject(choices[0]) ? choices[0] : undefined
          const delta = isObject(choice?.['delta']) ? choice['delta'] as Record<string, unknown> : undefined
          const content = typeof delta?.['content'] === 'string' ? delta['content'] : ''
          if (content) { fullText += content; yield { kind: 'delta', content } }
          for (const call of Array.isArray(delta?.['tool_calls']) ? delta!['tool_calls'] as unknown[] : []) {
            const fn = isObject(call) && isObject(call['function']) ? call['function'] as Record<string, unknown> : undefined
            if (typeof fn?.['name'] === 'string') yield { kind: 'tool', name: fn['name'], input: parseArguments(fn['arguments']) }
          }
          const usage = isObject(chunk['usage']) ? chunk['usage'] as Record<string, unknown> : undefined
          if (usage) { inputTokens = numberValue(usage['prompt_tokens']); outputTokens = numberValue(usage['completion_tokens']) }
        }
      }
      yield { kind: 'completed', content: fullText, inputTokens, outputTokens, durationMs: Date.now() - startedAt }
    } catch (error) {
      if (timeout.timedOut()) throw new ForgeError({ code: 'ADAPTER_TIMEOUT', message: `Local-model request timed out after ${this.config.timeoutMs}ms`, recoverable: true, context: { providerId: PROVIDER_ID, timeoutMs: this.config.timeoutMs } })
      throw error
    } finally {
      timeout.cleanup()
    }
  }

  private async request(endpoint: ResolvedLocalModelEndpoint, path: string, init: RequestInit): Promise<Response> {
    const response = await fetchWithOutboundUrlPolicy(localEndpointUrl(endpoint, path), init, {
      policy: { allowedHosts: endpoint.allowedHosts, allowHttp: true },
      followRedirects: false,
      ...(this.config.fetchImpl ? { fetchImpl: this.config.fetchImpl } : {}),
    })
    if (response.status >= 300 && response.status < 400) throw new ForgeError({ code: 'SSRF_BLOCKED', message: 'Local-model redirects are not permitted', recoverable: false, context: { providerId: PROVIDER_ID, status: response.status } })
    if (!response.ok) {
      const body = await readBoundedText(response, this.limits()).catch(() => response.statusText)
      throw httpErrorToForgeError(response.status, body, PROVIDER_ID)
    }
    return response
  }

  private limits(): StreamLimits {
    return {
      responseBytes: this.config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      recordBytes: this.config.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
      records: this.config.maxRecords ?? DEFAULT_MAX_RECORDS,
    }
  }

  private validateInput(input: AgentInput): void {
    if (input.maxBudgetUsd !== undefined) throw unsupported('Direct local-model execution has no deterministic monetary budget')
    if (input.resumeSessionId) throw unsupported('Direct local-model execution does not expose durable session resume')
    if (input.maxTurns !== undefined && input.maxTurns !== 1) throw unsupported('Direct local-model execution performs exactly one model turn')
  }

  private validateCapabilities(input: AgentInput, capabilities: LocalModelCapabilityProfile): void {
    if (!capabilities.text) throw unsupported('Selected local model does not advertise completion capability')
    const images = stringArray(input.options?.['images'])
    if (images.length > 0 && !capabilities.vision) throw unsupported('Selected local model does not advertise vision capability')
    if (input.outputSchema && !capabilities.structuredOutput) throw unsupported('Selected local model does not support structured output')
    if ((resolveOpenAITools(input)?.length ?? 0) > 0 && !capabilities.tools) throw unsupported('Selected local model does not advertise tool capability')
  }
}

export function createOllamaAdapter(config: OllamaAdapterConfig = {}): OllamaAdapter {
  return new OllamaAdapter(config)
}

function buildOllamaRequest(model: string, input: AgentInput, capabilities: LocalModelCapabilityProfile, signal: AbortSignal): RequestInit {
  const messages: Array<Record<string, unknown>> = []
  if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt })
  messages.push({ role: 'user', content: input.prompt, ...(stringArray(input.options?.['images']).length > 0 ? { images: stringArray(input.options?.['images']) } : {}) })
  const tools = resolveOpenAITools(input)
  const body: Record<string, unknown> = { model, messages, stream: true }
  if (tools?.length && capabilities.tools) body['tools'] = tools
  if (input.outputSchema && capabilities.structuredOutput) body['format'] = input.outputSchema
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }
}

function buildOpenAICompatibleRequest(config: OllamaAdapterConfig, model: string, input: AgentInput, capabilities: LocalModelCapabilityProfile, signal: AbortSignal): RequestInit {
  const messages: Array<Record<string, unknown>> = []
  if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt })
  messages.push({ role: 'user', content: input.prompt })
  const tools = resolveOpenAITools(input)
  const body: Record<string, unknown> = { model, messages, stream: true, stream_options: { include_usage: true } }
  if (tools?.length && capabilities.tools) body['tools'] = tools
  if (input.outputSchema && capabilities.structuredOutput) body['response_format'] = { type: 'json_schema', json_schema: { name: 'dzupagent_output', strict: true, schema: input.outputSchema } }
  return { method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) }, body: JSON.stringify(body), signal }
}

function mapLocalEvent(raw: LocalRawEvent, context: StreamContext, sessionId: string, getText: () => string, append: (value: string) => void): AgentEvent | null {
  const correlation = context.input.correlationId ? { correlationId: context.input.correlationId } : {}
  if (raw.kind === 'delta') {
    append(raw.content)
    return { type: 'adapter:stream_delta', providerId: PROVIDER_ID, content: raw.content, timestamp: Date.now(), ...correlation }
  }
  if (raw.kind === 'tool') return { type: 'adapter:tool_call', providerId: PROVIDER_ID, toolName: raw.name, input: raw.input, timestamp: Date.now(), ...correlation }
  return { type: 'adapter:completed', providerId: PROVIDER_ID, sessionId, result: raw.content || getText(), usage: { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens }, durationMs: raw.durationMs, timestamp: Date.now(), ...correlation }
}

function mapOllamaCapabilities(show: OllamaShowResponse): LocalModelCapabilityProfile {
  const values = new Set(show.capabilities ?? [])
  const text = values.has('completion')
  const contextTokens = Object.entries(show.model_info ?? {}).find(([key, value]) => key.endsWith('.context_length') && typeof value === 'number')?.[1]
  return {
    text,
    vision: values.has('vision'),
    tools: values.has('tools'),
    structuredOutput: text,
    thinking: values.has('thinking'),
    embedding: values.has('embedding'),
    ...(typeof contextTokens === 'number' ? { contextTokens } : {}),
    evidence: 'ollama-show',
  }
}

function declaredCapabilities(config: OllamaAdapterConfig, model: string): LocalModelCapabilityProfile {
  const value = config.declaredModelCapabilities?.[model]
  if (!value) throw unsupported(`OpenAI-compatible local model ${model} requires declared capability evidence`)
  return { text: value.text ?? true, vision: value.vision ?? false, tools: value.tools ?? false, structuredOutput: value.structuredOutput ?? false, thinking: value.thinking ?? false, embedding: value.embedding ?? false, ...(value.contextTokens !== undefined ? { contextTokens: value.contextTokens } : {}), evidence: 'operator-declared' }
}

function mapOllamaInventory(value: unknown): LocalModelInventoryEntry[] {
  if (!isObject(value)) return []
  const name = typeof value['name'] === 'string' ? value['name'] : typeof value['model'] === 'string' ? value['model'] : undefined
  if (!name) return []
  const details = isObject(value['details']) ? value['details'] as Record<string, unknown> : {}
  return [{ id: typeof value['model'] === 'string' ? value['model'] : name, name, ...(typeof value['digest'] === 'string' ? { digest: value['digest'] } : {}), ...(typeof value['modified_at'] === 'string' ? { modifiedAt: value['modified_at'] } : {}), ...(typeof value['size'] === 'number' ? { sizeBytes: value['size'] } : {}), ...(typeof details['family'] === 'string' ? { family: details['family'] } : {}), ...(typeof details['parameter_size'] === 'string' ? { parameterSize: details['parameter_size'] } : {}), ...(typeof details['quantization_level'] === 'string' ? { quantizationLevel: details['quantization_level'] } : {}) }]
}

interface StreamLimits { responseBytes: number; recordBytes: number; records: number }

async function readBoundedJson(response: Response, limits: StreamLimits): Promise<unknown> {
  const text = await readBoundedText(response, limits)
  try { return JSON.parse(text) as unknown } catch { throw malformed('Local-model response is not valid JSON') }
}

async function readBoundedText(response: Response, limits: StreamLimits): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > limits.responseBytes) throw overflow()
  return new TextDecoder().decode(bytes)
}

async function* readBoundedNdjson(response: Response, limits: StreamLimits, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  for await (const line of readBoundedLines(response, limits, signal)) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isObject(parsed)) throw new Error('shape')
      yield parsed
    } catch { throw malformed('Local-model stream emitted malformed NDJSON') }
  }
}

async function* readBoundedSse(response: Response, limits: StreamLimits, signal: AbortSignal): AsyncGenerator<string> {
  for await (const line of readBoundedLines(response, limits, signal)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data && data !== '[DONE]') yield data
  }
}

async function* readBoundedLines(response: Response, limits: StreamLimits, signal: AbortSignal): AsyncGenerator<string> {
  if (!response.body) throw malformed('Local-model response body is unavailable')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let total = 0
  let records = 0
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limits.responseBytes) throw overflow()
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (new TextEncoder().encode(line).byteLength > limits.recordBytes) throw overflow()
        if (line) {
          records += 1
          if (records > limits.records) throw overflow()
          yield line
        }
        newline = buffer.indexOf('\n')
      }
      if (new TextEncoder().encode(buffer).byteLength > limits.recordBytes) throw overflow()
    }
    buffer += decoder.decode()
    const final = buffer.trim()
    if (final) {
      records += 1
      if (records > limits.records || new TextEncoder().encode(final).byteLength > limits.recordBytes) throw overflow()
      yield final
    }
  } finally {
    reader.releaseLock()
  }
}

function createTimeoutSignal(parent: AbortSignal, timeoutMs?: number): { signal: AbortSignal; timedOut(): boolean; cleanup(): void } {
  if (!timeoutMs || timeoutMs <= 0) return { signal: parent, timedOut: () => false, cleanup: () => undefined }
  const controller = new AbortController()
  let timeoutFired = false
  const timer = setTimeout(() => { timeoutFired = true; controller.abort() }, timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort()
  parent.addEventListener('abort', onAbort, { once: true })
  return { signal: controller.signal, timedOut: () => timeoutFired, cleanup: () => { clearTimeout(timer); parent.removeEventListener('abort', onAbort) } }
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {}
  try { return JSON.parse(value) as unknown } catch { return value }
}
function numberValue(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [] }
function modelNamesMatch(actual: string, requested: string): boolean { return actual === requested || actual === `${requested}:latest` || requested === `${actual}:latest` }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function errorCode(error: unknown): string { return isObject(error) && typeof error['code'] === 'string' ? error['code'] : 'PROVIDER_UNAVAILABLE' }
function overflow(): ForgeError { return new ForgeError({ code: 'ADAPTER_EXECUTION_FAILED', message: 'Local-model response exceeded configured output bounds', recoverable: false, context: { providerId: PROVIDER_ID, classification: 'output_overflow' } }) }
function malformed(message: string): ForgeError { return new ForgeError({ code: 'ADAPTER_EXECUTION_FAILED', message, recoverable: false, context: { providerId: PROVIDER_ID, classification: 'malformed_stream' } }) }
function modelUnavailable(model: string): ForgeError { return new ForgeError({ code: 'PROVIDER_REJECTED_REQUEST', message: `Local model is not installed: ${model}`, recoverable: false, context: { providerId: PROVIDER_ID, model, rejectionCode: 'MODEL_UNAVAILABLE' } }) }
function unsupported(message: string): ForgeError { return new ForgeError({ code: 'CAPABILITY_DENIED', message, recoverable: false, context: { providerId: PROVIDER_ID, backend: 'local-model' } }) }
