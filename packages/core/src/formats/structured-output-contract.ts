import { z } from 'zod'
import type {
  StructuredOutputModelCapabilities,
  StructuredOutputStrategy,
} from '../llm/model-config.js'
import {
  type StructuredOutputSchemaDescriptor,
  buildStructuredOutputSchemaName,
  describeStructuredOutputSchema,
  toOpenAISafeSchema,
} from './tool-format-adapters.js'

const NATIVE_STRUCTURED_OUTPUT_STRATEGIES = new Set<NonNullable<
  StructuredOutputModelCapabilities['preferredStrategy']
>>(['anthropic-tool-use', 'openai-json-schema'])

export type StructuredOutputProvider = 'generic' | 'openai'

export interface StructuredOutputRuntimeMeta {
  model?: string
  modelName?: string
  name?: string
  structuredOutputCapabilities?: StructuredOutputModelCapabilities
  withStructuredOutput?: unknown
}

export interface StructuredOutputSchemaContract {
  schemaName: string
  schemaProvider: StructuredOutputProvider
  requiresEnvelope: boolean
  requestSchema: z.ZodType
  responseSchema: z.ZodType
  requestSchemaDescriptor: StructuredOutputSchemaDescriptor
  responseSchemaDescriptor: StructuredOutputSchemaDescriptor
}

export function detectStructuredOutputStrategy(
  runtime: Pick<StructuredOutputRuntimeMeta, 'model' | 'modelName' | 'name'>,
): StructuredOutputStrategy {
  const name = (runtime.model ?? runtime.modelName ?? runtime.name ?? '').toLowerCase()

  if (name.includes('claude') || name.includes('anthropic')) {
    return 'anthropic-tool-use'
  }
  if (name.includes('gpt') || name.includes('openai')) {
    return 'openai-json-schema'
  }
  return 'generic-parse'
}

export function resolveStructuredOutputCapabilities(
  runtime: StructuredOutputRuntimeMeta,
  config?: {
    capabilities?: StructuredOutputModelCapabilities
    schemaProvider?: StructuredOutputProvider
  },
): StructuredOutputModelCapabilities {
  const explicit = config?.capabilities ?? runtime.structuredOutputCapabilities
  if (explicit) {
    return {
      preferredStrategy: explicit.preferredStrategy,
      schemaProvider: resolveStructuredOutputSchemaProvider(config?.schemaProvider, explicit),
      ...(explicit.fallbackStrategies === undefined
        ? {}
        : { fallbackStrategies: explicit.fallbackStrategies }),
    }
  }

  const preferredStrategy = detectStructuredOutputStrategy(runtime)
  return {
    preferredStrategy,
    schemaProvider: config?.schemaProvider ?? inferSchemaProvider(preferredStrategy),
  }
}

export function resolveStructuredOutputSchemaProvider(
  override: StructuredOutputProvider | undefined,
  capabilities: StructuredOutputModelCapabilities | undefined,
): StructuredOutputProvider {
  if (override) {
    return override
  }
  if (capabilities?.schemaProvider) {
    return capabilities.schemaProvider
  }
  if (capabilities?.preferredStrategy) {
    return inferSchemaProvider(capabilities.preferredStrategy)
  }
  return 'openai'
}

export function shouldAttemptNativeStructuredOutput(
  runtime: Pick<StructuredOutputRuntimeMeta, 'withStructuredOutput'>,
  capabilities: StructuredOutputModelCapabilities | undefined,
): boolean {
  if (typeof runtime.withStructuredOutput !== 'function') {
    return false
  }

  if (!capabilities) {
    return true
  }

  return NATIVE_STRUCTURED_OUTPUT_STRATEGIES.has(capabilities.preferredStrategy)
}

export function prepareStructuredOutputSchemaContract<T>(
  schema: z.ZodType<T>,
  options?: {
    agentId?: string | null
    intent?: string | null
    schemaName?: string
    schemaProvider?: StructuredOutputProvider
    previewChars?: number
  },
): StructuredOutputSchemaContract {
  const requiresEnvelope = !(schema instanceof z.ZodObject)
  const schemaName = options?.schemaName ?? buildStructuredOutputSchemaName({
    agentId: options?.agentId ?? null,
    intent: options?.intent ?? null,
    requiresEnvelope,
  })
  const schemaProvider = options?.schemaProvider ?? 'generic'
  const responseSchema = requiresEnvelope
    ? z.object({ result: schema })
    : schema
  const requestSchema = schemaProvider === 'openai'
    ? toOpenAISafeSchema(responseSchema)
    : responseSchema
  const previewChars = options?.previewChars ?? 240

  return {
    schemaName,
    schemaProvider,
    requiresEnvelope,
    requestSchema,
    responseSchema,
    requestSchemaDescriptor: describeStructuredOutputSchema(requestSchema, {
      schemaName,
      provider: schemaProvider,
      previewChars,
    }),
    responseSchemaDescriptor: describeStructuredOutputSchema(responseSchema, {
      schemaName: `${schemaName}.response`,
      provider: 'generic',
      previewChars,
    }),
  }
}

export function unwrapStructuredEnvelope<T>(
  value: unknown,
  requiresEnvelope: boolean,
): T {
  if (
    requiresEnvelope
    && value !== null
    && typeof value === 'object'
    && 'result' in value
  ) {
    return (value as { result: T }).result
  }

  return value as T
}

function inferSchemaProvider(strategy: StructuredOutputStrategy): StructuredOutputProvider {
  return strategy === 'openai-json-schema' ? 'openai' : 'generic'
}
