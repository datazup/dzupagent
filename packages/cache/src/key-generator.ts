import { createHash } from 'node:crypto'
import type { CacheableRequest } from './types.js'

/**
 * Generate a deterministic SHA-256 cache key from an LLM request.
 *
 * The key is derived from the normalized request payload (messages, model,
 * temperature, maxTokens) so identical requests always produce the same key.
 *
 * Ported from @datazup/llm-cache with enhanced namespace support for
 * multi-tenant isolation.
 */
export function generateCacheKey(request: CacheableRequest, namespace?: string): string {
  const content = JSON.stringify({
    messages: request.messages.map(m => `${m.role}:${m.content}`),
    model: request.model,
    temperature: request.temperature ?? 0,
    maxTokens: request.maxTokens,
  })
  const hash = createHash('sha256').update(content).digest('hex')
  return namespace ? `${namespace}:llm:${hash}` : `llm:${hash}`
}
