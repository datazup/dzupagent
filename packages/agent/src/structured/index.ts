/**
 * Structured output engine — barrel export.
 */
export type {
  StructuredOutputStrategy,
  StructuredOutputCapabilities,
  StructuredOutputConfig,
  StructuredOutputResult,
} from './structured-output-types.js'

export {
  generateStructured,
  detectStrategy,
  resolveStructuredOutputCapabilities,
} from './structured-output-engine.js'

export type {
  StructuredLLM,
  StructuredLLMWithMeta,
} from './structured-output-engine.js'
