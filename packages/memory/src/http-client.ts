/**
 * HttpMemoryClient — stub for a future remote memory service.
 *
 * The wire protocol is not yet finalised. Methods throw
 * `NotImplementedError` so callers that mistakenly construct this client
 * fail loudly rather than silently dropping writes. Once the protocol
 * lands, replace each method with a `fetch` over `config.baseUrl`.
 */

import type {
  MemoryClient,
  MemoryRecord,
  MemoryScope,
  MemoryQuery,
} from '@dzupagent/agent-types'

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`HttpMemoryClient.${method} is not implemented yet.`)
    this.name = 'NotImplementedError'
  }
}

export interface HttpMemoryClientConfig {
  baseUrl: string
  apiKey?: string
  /** Optional fetch override for testing or non-browser environments. */
  fetch?: typeof fetch
}

export class HttpMemoryClient implements MemoryClient {
  /** Retained for inspection by tooling once the wire protocol lands. */
  readonly config: HttpMemoryClientConfig

  constructor(config: HttpMemoryClientConfig) {
    if (!config.baseUrl) {
      throw new Error('HttpMemoryClient requires baseUrl')
    }
    this.config = config
  }

  async get(
    _namespace: string,
    _scope: MemoryScope,
    _query?: MemoryQuery,
  ): Promise<MemoryRecord[]> {
    throw new NotImplementedError('get')
  }

  async put(
    _namespace: string,
    _scope: MemoryScope,
    _record: MemoryRecord,
  ): Promise<void> {
    throw new NotImplementedError('put')
  }

  async delete(
    _namespace: string,
    _scope: MemoryScope,
    _recordId: string,
  ): Promise<boolean> {
    throw new NotImplementedError('delete')
  }
}
