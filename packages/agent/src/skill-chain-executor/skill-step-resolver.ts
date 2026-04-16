import type { WorkflowStep, WorkflowContext } from '../workflow/workflow-types.js'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { SkillRegistry } from '@dzupagent/core'
import { HumanMessage } from '@langchain/core/messages'
import { SkillNotFoundError } from './errors.js'

export interface SkillStepResolver {
  resolve(skillId: string): Promise<WorkflowStep>
  canResolve(skillId: string): boolean
}

export interface SharedAgentSkillResolverConfig {
  baseAgent: DzupAgent
  registry: SkillRegistry
  instructionInjectionMode?: 'prepend' | 'append' | 'replace'
  messageBuilder?: (state: Record<string, unknown>, skillId: string) => string
  /** Maximum number of agents to keep in cache. LRU eviction when exceeded. Default: unlimited. */
  cacheMaxSize?: number
  /** Time-to-live for cached agents in milliseconds. Default: no expiry. */
  cacheTtlMs?: number
}

interface CacheEntry {
  agent: DzupAgent
  cachedAt: number
}

type RequiredResolverConfig = Required<SharedAgentSkillResolverConfig>

export class SharedAgentSkillResolver implements SkillStepResolver {
  private readonly config: RequiredResolverConfig
  private readonly agentCache = new Map<string, CacheEntry>()

  constructor(config: SharedAgentSkillResolverConfig) {
    this.config = {
      instructionInjectionMode: 'prepend',
      messageBuilder: defaultMessageBuilder,
      cacheMaxSize: 0,
      cacheTtlMs: 0,
      ...config,
    }
  }

  async resolve(skillId: string): Promise<WorkflowStep> {
    const skill = this.config.registry.get(skillId)
    if (!skill) {
      throw new SkillNotFoundError(
        skillId,
        this.config.registry.list().map(s => s.id),
      )
    }

    let agent = this.getCachedAgent(skillId)
    if (!agent) {
      agent = this.buildAgent(skillId, skill.instructions)
      this.putCache(skillId, agent)
    }

    const messageBuilder = this.config.messageBuilder

    return {
      id: skillId,
      description: skill.description,
      execute: async (input: unknown, _ctx: WorkflowContext) => {
        const state = (input as Record<string, unknown>) ?? {}
        const prompt = messageBuilder(state, skillId)
        const result = await agent.generate(
          [new HumanMessage(prompt)],
        )
        return { [skillId]: result.content } as Record<string, string>
      },
    }
  }

  /** Clear the internal agent cache. */
  clearCache(): void {
    this.agentCache.clear()
  }

  /** Remove a specific skill's agent from the cache. */
  invalidate(skillId: string): void {
    this.agentCache.delete(skillId)
  }

  /**
   * Retrieve a cached agent, respecting TTL and refreshing LRU order.
   * Returns undefined if not cached or expired.
   */
  private getCachedAgent(skillId: string): DzupAgent | undefined {
    const entry = this.agentCache.get(skillId)
    if (!entry) return undefined

    // Check TTL expiry
    const { cacheTtlMs } = this.config
    if (cacheTtlMs > 0 && Date.now() - entry.cachedAt > cacheTtlMs) {
      this.agentCache.delete(skillId)
      return undefined
    }

    // Refresh LRU order: delete and re-set to move to end (most recently used)
    this.agentCache.delete(skillId)
    this.agentCache.set(skillId, entry)
    return entry.agent
  }

  /**
   * Insert an agent into the cache, evicting the LRU entry if maxSize is exceeded.
   */
  private putCache(skillId: string, agent: DzupAgent): void {
    const { cacheMaxSize } = this.config
    if (cacheMaxSize > 0 && this.agentCache.size >= cacheMaxSize) {
      // Evict the least recently used entry (first key in Map iteration order)
      const lruKey = this.agentCache.keys().next().value
      if (lruKey !== undefined) {
        this.agentCache.delete(lruKey)
      }
    }
    this.agentCache.set(skillId, { agent, cachedAt: Date.now() })
  }

  private buildAgent(skillId: string, skillInstructions: string): DzupAgent {
    const baseConfig = this.config.baseAgent.agentConfig
    const mergedInstructions = mergeInstructions(
      baseConfig.instructions,
      skillInstructions,
      this.config.instructionInjectionMode,
    )
    return new DzupAgent({
      ...baseConfig,
      id: `${baseConfig.id}:${skillId}`,
      instructions: mergedInstructions,
    })
  }

  canResolve(skillId: string): boolean {
    return this.config.registry.has(skillId)
  }
}

function mergeInstructions(
  base: string,
  skillInstructions: string,
  mode: 'prepend' | 'append' | 'replace',
): string {
  switch (mode) {
    case 'prepend': return `${skillInstructions}\n\n${base}`
    case 'append':  return `${base}\n\n${skillInstructions}`
    case 'replace': return skillInstructions
  }
}

function defaultMessageBuilder(state: Record<string, unknown>, skillId: string): string {
  const userMessage = typeof state['userMessage'] === 'string' ? state['userMessage'] : ''
  const previousOutputs = state['previousOutputs'] as Record<string, string> | undefined

  const parts: string[] = []
  if (userMessage) {
    parts.push(`# Task\n${userMessage}`)
  }
  if (previousOutputs && Object.keys(previousOutputs).length > 0) {
    parts.push('# Previous Step Outputs')
    for (const [id, output] of Object.entries(previousOutputs)) {
      parts.push(`## ${id}\n${output}`)
    }
  }
  parts.push(`# Current Step: ${skillId}`)
  return parts.join('\n\n')
}
