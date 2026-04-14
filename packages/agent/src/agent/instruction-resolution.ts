import { loadAgentsFiles } from '../instructions/instruction-loader.js'
import { mergeInstructions, type MergedInstructions } from '../instructions/instruction-merger.js'

export interface AgentInstructionResolverConfig {
  agentId: string
  instructions: string
  instructionsMode?: 'static' | 'static+agents'
  agentsDir?: string
}

function buildStaticInstructionsResult(instructions: string): MergedInstructions {
  return {
    systemPrompt: instructions,
    agentHierarchy: [],
    sources: [],
  }
}

export class AgentInstructionResolver {
  private mergedInstructionsCache: MergedInstructions | null = null
  private mergedInstructionsLoading: Promise<MergedInstructions> | null = null

  constructor(private readonly config: AgentInstructionResolverConfig) {}

  async resolve(): Promise<string> {
    if (this.config.instructionsMode !== 'static+agents') {
      return this.config.instructions
    }

    if (this.mergedInstructionsCache) {
      return this.mergedInstructionsCache.systemPrompt
    }

    if (!this.mergedInstructionsLoading) {
      this.mergedInstructionsLoading = this.loadAndMergeInstructions()
    }

    const merged = await this.mergedInstructionsLoading
    this.mergedInstructionsCache = merged
    this.mergedInstructionsLoading = null
    return merged.systemPrompt
  }

  private async loadAndMergeInstructions(): Promise<MergedInstructions> {
    try {
      const dir = this.config.agentsDir ?? process.cwd()
      const files = await loadAgentsFiles(dir)

      if (files.length === 0) {
        return buildStaticInstructionsResult(this.config.instructions)
      }

      const allSections = files.flatMap((file) => file.sections)
      const allSources = files.map((file) => file.path)

      return mergeInstructions(
        this.config.instructions,
        allSections,
        this.config.agentId,
        allSources,
      )
    } catch {
      return buildStaticInstructionsResult(this.config.instructions)
    }
  }
}
