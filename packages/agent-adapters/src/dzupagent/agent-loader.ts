/**
 * DzupAgentAgentLoader -- loads AgentDefinition from .dzupagent/agents/*.md files.
 *
 * Reads from up to three locations (in order):
 *   1. ~/.dzupagent/agents/           (global -- shared across all projects)
 *   2. <workspace>/.dzupagent/agents/ (workspace -- git root, when it differs from project)
 *   3. <project>/.dzupagent/agents/   (project-level -- overrides global & workspace by name)
 *
 * Results are cached by file mtime to keep subsequent calls under 1ms.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import type { AdapterProviderId, DzupAgentPaths } from '../types.js'
import type { AdapterSkillBundle } from '../skills/adapter-skill-types.js'
import type { AdapterSkillRegistry } from '../skills/adapter-skill-registry.js'
import type { DzupAgentFileLoader } from './file-loader.js'
import { parseMarkdownFile } from './md-frontmatter-parser.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentDefinition {
  name: string
  description: string
  version: number
  preferredProvider?: AdapterProviderId | undefined
  skillNames: string[]
  memoryScope: 'global' | 'workspace' | 'project'
  constraints: AdapterSkillBundle['constraints']
  personaPrompt: string
  filePath: string
  importedFrom?: string | undefined
}

export interface DzupAgentAgentLoaderOptions {
  paths: DzupAgentPaths
  skillLoader: DzupAgentFileLoader
  skillRegistry: AdapterSkillRegistry
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_PROVIDER_IDS = new Set<string>([
  'claude', 'codex', 'gemini', 'gemini-sdk', 'qwen', 'crush', 'goose', 'openrouter',
])

const VALID_MEMORY_SCOPES = new Set<string>(['global', 'workspace', 'project'])

function safeString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

function safeStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return []
}

function fileNameWithoutExt(filePath: string): string {
  const base = basename(filePath)
  const ext = extname(base)
  return ext ? base.slice(0, -ext.length) : base
}

function parseConstraints(raw: unknown): AdapterSkillBundle['constraints'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}

  const c = raw as Record<string, unknown>
  const result: AdapterSkillBundle['constraints'] = {}

  if (typeof c['maxBudgetUsd'] === 'number') result.maxBudgetUsd = c['maxBudgetUsd']

  const approval = c['approvalMode']
  if (approval === 'auto' || approval === 'required' || approval === 'conditional') {
    result.approvalMode = approval
  }

  const network = c['networkPolicy']
  if (network === 'off' || network === 'restricted' || network === 'on') {
    result.networkPolicy = network
  }

  const tool = c['toolPolicy']
  if (tool === 'strict' || tool === 'balanced' || tool === 'open') {
    result.toolPolicy = tool
  }

  return result
}

/**
 * Extract the content of the `## Persona` section from parsed markdown sections.
 * Falls back to empty string if no Persona section exists.
 */
function extractPersonaSection(sections: ReadonlyArray<{ heading: string; content: string }>): string {
  for (const section of sections) {
    if (section.heading.toLowerCase() === 'persona') {
      return section.content
    }
  }
  return ''
}

function buildAgentDefinition(filePath: string, content: string): AgentDefinition {
  const parsed = parseMarkdownFile(content)
  const fm = parsed.frontmatter

  const nameFromFile = fileNameWithoutExt(filePath)
  const name = safeString(fm['name'] as string | undefined, nameFromFile)
  const description = safeString(fm['description'] as string | undefined, '')

  const versionRaw = fm['version']
  const version = typeof versionRaw === 'number' ? versionRaw : 1

  const providerRaw = fm['preferredProvider']
  const preferredProvider =
    typeof providerRaw === 'string' && VALID_PROVIDER_IDS.has(providerRaw)
      ? (providerRaw as AdapterProviderId)
      : undefined

  const skillNames = safeStringArray(fm['skills'])

  const memoryScopeRaw = fm['memoryScope']
  const memoryScope =
    typeof memoryScopeRaw === 'string' && VALID_MEMORY_SCOPES.has(memoryScopeRaw)
      ? (memoryScopeRaw as 'global' | 'workspace' | 'project')
      : 'project'

  const constraints = parseConstraints(fm['constraints'])

  // Extract ## Persona from the parsed sections
  const personaPrompt = extractPersonaSection(parsed.sections)

  const importedFromRaw = fm['importedFrom']
  const importedFrom = typeof importedFromRaw === 'string' ? importedFromRaw : undefined

  return {
    name,
    description,
    version,
    preferredProvider,
    skillNames,
    memoryScope,
    constraints,
    personaPrompt,
    filePath,
    importedFrom,
  }
}

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  mtime: number
  result: AgentDefinition
}

// ---------------------------------------------------------------------------
// DzupAgentAgentLoader
// ---------------------------------------------------------------------------

export class DzupAgentAgentLoader {
  private readonly paths: DzupAgentPaths
  private readonly skillLoader: DzupAgentFileLoader
  private readonly skillRegistry: AdapterSkillRegistry
  private cache = new Map<string, CacheEntry>()

  constructor(options: DzupAgentAgentLoaderOptions) {
    this.paths = options.paths
    this.skillLoader = options.skillLoader
    this.skillRegistry = options.skillRegistry
  }

  /**
   * Load all agents from global + workspace + project directories.
   * Later tiers override earlier ones with the same agent name:
   *   global < workspace < project
   * Results are cached until file mtime changes.
   */
  async loadAgents(): Promise<AgentDefinition[]> {
    const globalAgents = await this.loadFromDir(this.paths.globalDir)

    const wsDir = this.paths.workspaceDir
    const workspaceAgents =
      wsDir !== undefined && wsDir !== this.paths.projectDir
        ? await this.loadFromDir(wsDir)
        : []

    const projectAgents = await this.loadFromDir(this.paths.projectDir)

    // Merge: workspace overrides global, project overrides workspace (by name)
    const byName = new Map<string, AgentDefinition>()
    for (const a of globalAgents) byName.set(a.name, a)
    for (const a of workspaceAgents) byName.set(a.name, a)
    for (const a of projectAgents) byName.set(a.name, a)

    return [...byName.values()]
  }

  /**
   * Load a single agent by name, or undefined if not found.
   */
  async loadAgent(name: string): Promise<AgentDefinition | undefined> {
    const all = await this.loadAgents()
    return all.find((a) => a.name === name)
  }

  /**
   * Compile agent for provider: returns string = persona + compiled skills.
   * Missing skill references are skipped with a console.warn, not thrown.
   */
  async compileForProvider(agent: AgentDefinition, providerId: AdapterProviderId): Promise<string> {
    const parts: string[] = []

    if (agent.personaPrompt) {
      parts.push(agent.personaPrompt)
    }

    for (const skillName of agent.skillNames) {
      const bundle = await this.skillLoader.loadSkill(skillName)
      if (!bundle) {
        console.warn(`[DzupAgentAgentLoader] skill not found: ${skillName}`)
        continue
      }
      const compiled = this.skillRegistry.compile(bundle, providerId)
      const systemPrompt = compiled.runtimeConfig['systemPrompt']
      if (typeof systemPrompt === 'string' && systemPrompt.length > 0) {
        parts.push(systemPrompt)
      }
    }

    return parts.join('\n\n')
  }

  /**
   * Force-invalidate the in-memory mtime cache.
   */
  invalidateCache(): void {
    this.cache.clear()
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async loadFromDir(baseDir: string): Promise<AgentDefinition[]> {
    const agentsDir = join(baseDir, 'agents')
    let entries: string[]

    try {
      entries = await readdir(agentsDir)
    } catch {
      return [] // directory does not exist -- not an error
    }

    const mdFiles = entries.filter((e) => e.endsWith('.md'))
    const results: AgentDefinition[] = []

    await Promise.all(
      mdFiles.map(async (filename) => {
        const filePath = join(agentsDir, filename)
        const parsed = await this.loadFileCached(filePath)
        if (parsed !== undefined) results.push(parsed)
      }),
    )

    return results
  }

  private async loadFileCached(filePath: string): Promise<AgentDefinition | undefined> {
    try {
      const stats = await stat(filePath)
      const mtime = stats.mtimeMs

      const cached = this.cache.get(filePath)
      if (cached !== undefined && cached.mtime === mtime) {
        return cached.result
      }

      const content = await readFile(filePath, 'utf-8')
      const result = buildAgentDefinition(filePath, content)
      this.cache.set(filePath, { mtime, result })
      return result
    } catch {
      return undefined // file disappeared or unreadable -- skip silently
    }
  }
}

// ---------------------------------------------------------------------------
// Supervisor config helper
// ---------------------------------------------------------------------------

/** Routing preference entry for supervisor configuration. */
interface AgentRoutingPreference {
  agentName: string
  preferredProvider: AdapterProviderId
  description: string
  skillNames: string[]
  memoryScope: 'global' | 'workspace' | 'project'
}

/**
 * Convert AgentDefinition[] to a partial supervisor routing configuration.
 *
 * Maps each agent's `preferredProvider` to a routing preference entry.
 * Only agents that have a `preferredProvider` set (either from the definition
 * itself or from the `preferredProviders` override map) are included.
 *
 * @param agents - The agent definitions to convert
 * @param preferredProviders - Optional overrides for agent -> provider mapping (by agent name)
 */
export function agentDefinitionsToSupervisorConfig(
  agents: AgentDefinition[],
  preferredProviders?: Partial<Record<string, AdapterProviderId>>,
): Record<string, unknown> {
  const routingPreferences: AgentRoutingPreference[] = []

  for (const agent of agents) {
    const provider =
      preferredProviders?.[agent.name] ?? agent.preferredProvider
    if (provider === undefined) continue

    routingPreferences.push({
      agentName: agent.name,
      preferredProvider: provider,
      description: agent.description,
      skillNames: agent.skillNames,
      memoryScope: agent.memoryScope,
    })
  }

  return {
    routingPreferences,
    agentCount: agents.length,
    providersUsed: [...new Set(routingPreferences.map((r) => r.preferredProvider))],
  }
}
