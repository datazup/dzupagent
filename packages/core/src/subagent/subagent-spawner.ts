/**
 * Sub-agent spawner — creates context-isolated child agents.
 * Inspired by DeepAgentsJS SubAgentMiddleware pattern.
 */
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ModelRegistry } from '../llm/model-registry.js'
import type { SkillLoader } from '../skills/skill-loader.js'
import { mergeFileChanges } from './file-merge.js'
import type { SubAgentConfig, SubAgentResult } from './subagent-types.js'

export class SubAgentSpawner {
  constructor(
    private registry: ModelRegistry,
    private options?: { skillLoader?: SkillLoader },
  ) {}

  /**
   * Spawn an isolated sub-agent with its own context window.
   *
   * @param config - Sub-agent configuration
   * @param task - The task description (becomes HumanMessage)
   * @param parentFiles - Optional parent VFS to pass as context
   */
  async spawn(
    config: SubAgentConfig,
    task: string,
    parentFiles?: Record<string, string>,
  ): Promise<SubAgentResult> {
    // 1. Resolve model
    const model = this.resolveModel(config)

    // 2. Build system prompt with skills
    let systemPrompt = config.systemPrompt
    if (config.skills && config.skills.length > 0 && this.options?.skillLoader) {
      const allSkills = await this.options.skillLoader.discoverSkills()
      const configSkills = config.skills!
      const relevantSkills = allSkills.filter(s => configSkills.includes(s.name))
      if (relevantSkills.length > 0) {
        // Load full content for relevant skills and append
        for (const skill of relevantSkills) {
          const content = await this.options.skillLoader.loadSkillContent(skill.name)
          if (content) {
            systemPrompt += `\n\n## Skill: ${skill.name}\n\n${content}`
          }
        }
      }
    }

    // 3. Build context from parent files
    let contextBlock = ''
    if (parentFiles && Object.keys(parentFiles).length > 0) {
      const filtered = config.contextFilter
        ? config.contextFilter({ files: parentFiles })
        : { files: parentFiles }
      const files = (filtered as Record<string, unknown>).files as Record<string, string> | undefined
      if (files && Object.keys(files).length > 0) {
        const fileList = Object.entries(files)
          .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
          .join('\n\n')
        contextBlock = `\n\n## Existing Files\n\n${fileList}`
      }
    }

    // 4. Invoke the model directly (simple single-turn for now)
    // In future, this could use a full ReAct agent with tools
    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(task + contextBlock),
    ]

    const effectiveModel = config.tools && config.tools.length > 0 && 'bindTools' in model
      ? (model as BaseChatModel & { bindTools: (tools: typeof config.tools) => BaseChatModel }).bindTools(config.tools) as BaseChatModel
      : model

    const response = await effectiveModel.invoke(messages)

    // 5. Extract files from response (if any tool calls produced files)
    const files: Record<string, string> = {}

    // For simple invocations, parse file content from the response
    // The actual file extraction will depend on tool call results
    // in a full ReAct agent implementation

    return {
      messages: [response],
      files,
      metadata: {
        agentName: config.name,
        modelUsed: (model as BaseChatModel & { model?: string }).model ?? 'unknown',
      },
    }
  }

  /**
   * Spawn a sub-agent and merge its file results back into a parent VFS.
   */
  async spawnAndMerge(
    config: SubAgentConfig,
    task: string,
    parentFiles: Record<string, string>,
  ): Promise<{ result: SubAgentResult; mergedFiles: Record<string, string> }> {
    const result = await this.spawn(config, task, parentFiles)
    const mergedFiles = mergeFileChanges(parentFiles, result.files)
    return { result, mergedFiles }
  }

  private resolveModel(config: SubAgentConfig): BaseChatModel {
    if (!config.model) {
      return this.registry.getModel('codegen')
    }
    if (typeof config.model === 'string') {
      // ModelTier string — resolve from registry
      return this.registry.getModel(config.model)
    }
    // Already a BaseChatModel instance
    return config.model
  }
}
