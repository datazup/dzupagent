/**
 * Factory helpers for constructing a DzupAgent with pre-built dependencies.
 *
 * {@link createAgentWithMemory} is the recommended bootstrap entry point for
 * agents that should start with a snapshot of the memory service already
 * baked into their system prompt. It builds a {@link FrozenSnapshot} from
 * the supplied memory, namespace, and scope before handing off to the
 * DzupAgent constructor.
 */
import type { MemoryService } from '@dzupagent/memory'
import { buildFrozenSnapshot } from '@dzupagent/context'

import { DzupAgent } from './dzip-agent.js'
import type { DzupAgentConfig } from './agent-types.js'

/**
 * Build a frozen memory snapshot from the supplied memory service and
 * return a fully-constructed {@link DzupAgent}.
 *
 * The freshly-built snapshot always wins over any `frozenSnapshot` already
 * present on `config` — the factory is the canonical source of the
 * snapshot in this bootstrap path.
 *
 * `memory`, `namespace`, and `scope` are all optional and fall back to
 * `config.memory`, `config.memoryNamespace`, and `config.memoryScope`
 * respectively. If neither the explicit `memory` param nor `config.memory`
 * is provided, this throws a descriptive error.
 */
export async function createAgentWithMemory(
  config: DzupAgentConfig,
  memory?: MemoryService | null,
  namespace?: string,
  scope?: Record<string, string>,
): Promise<DzupAgent> {
  const effectiveMemory = memory ?? config.memory
  if (!effectiveMemory) {
    throw new Error(
      'createAgentWithMemory: no MemoryService provided — pass memory param or set config.memory',
    )
  }
  const effectiveNamespace = namespace ?? config.memoryNamespace ?? 'default'
  const effectiveScope = scope ?? config.memoryScope ?? {}
  const frozenSnapshot = await buildFrozenSnapshot(
    effectiveMemory,
    effectiveNamespace,
    effectiveScope,
  )
  return new DzupAgent({ ...config, frozenSnapshot })
}
