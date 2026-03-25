/**
 * Embedding provider barrel — re-exports all embedding implementations.
 */

export { createOpenAIEmbedding } from './openai-embedding.js'
export type { OpenAIEmbeddingConfig } from './openai-embedding.js'

export { createVoyageEmbedding } from './voyage-embedding.js'
export type { VoyageEmbeddingConfig } from './voyage-embedding.js'

export { createCohereEmbedding } from './cohere-embedding.js'
export type { CohereEmbeddingConfig } from './cohere-embedding.js'

export { createOllamaEmbedding } from './ollama-embedding.js'
export type { OllamaEmbeddingConfig } from './ollama-embedding.js'

export { createCustomEmbedding } from './custom-embedding.js'
export type { CustomEmbeddingConfig } from './custom-embedding.js'
