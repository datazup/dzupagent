/**
 * Sub-agent spawner — creates context-isolated child agents.
 * Inspired by DeepAgentsJS SubAgentMiddleware pattern.
 *
 * Supports both single-turn invocations (spawn) and full
 * ReAct tool-calling loops (spawnReAct).
 */
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { ModelRegistry } from '../llm/model-registry.js'
import type { SkillLoader } from '../skills/skill-loader.js'
import { extractTokenUsage } from '../llm/invoke.js'
import { mergeFileChanges } from './file-merge.js'
import { REACT_DEFAULTS } from './subagent-types.js'
import type { SubAgentConfig, SubAgentResult, SubAgentUsage } from './subagent-types.js'

interface ToolCall {
  id?: string
  name: string
  args: Record<string, unknown>
}

/** File-writing tool names whose results may contain file paths */
const FILE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'create_file'])

export class SubAgentSpawner {
  constructor(
    private registry: ModelRegistry,
    private options?: { skillLoader?: SkillLoader; maxDepth?: number },
  ) {}

  /**
   * Spawn an isolated sub-agent with its own context window.
   * Single-turn invocation — no tool-calling loop.
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
    const systemPrompt = await this.buildSystemPrompt(config)

    // 3. Build context from parent files
    const contextBlock = this.buildContextBlock(config, parentFiles)

    // 4. Invoke the model directly (simple single-turn)
    const messages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      new HumanMessage(task + contextBlock),
    ]

    const effectiveModel = config.tools && config.tools.length > 0 && 'bindTools' in model
      ? (model as BaseChatModel & { bindTools: (tools: StructuredToolInterface[]) => BaseChatModel }).bindTools(config.tools) as BaseChatModel
      : model

    const response = await effectiveModel.invoke(messages)

    // 5. Extract files from response (if any tool calls produced files)
    const files: Record<string, string> = {}

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
   * Spawn a sub-agent that runs a full ReAct tool-calling loop.
   *
   * The loop: invoke model -> check for tool calls -> execute tools ->
   * append tool results -> repeat until no tool calls or limits reached.
   *
   * @param config - Sub-agent configuration (must include tools for meaningful use)
   * @param task - The task description
   * @param parentFiles - Optional parent VFS to pass as context
   */
  async spawnReAct(
    config: SubAgentConfig,
    task: string,
    parentFiles?: Record<string, string>,
  ): Promise<SubAgentResult> {
    const maxDepth = this.options?.maxDepth ?? REACT_DEFAULTS.maxDepth
    const currentDepth = config._depth ?? 0

    if (currentDepth >= maxDepth) {
      return {
        messages: [new AIMessage(`[Sub-agent "${config.name}" stopped: max recursion depth ${maxDepth} reached]`)],
        files: {},
        metadata: { agentName: config.name, stoppedReason: 'max_depth' },
        hitIterationLimit: false,
      }
    }

    const maxIterations = config.maxIterations ?? REACT_DEFAULTS.maxIterations
    const timeoutMs = config.timeoutMs ?? REACT_DEFAULTS.timeoutMs

    // 1. Resolve model and bind tools
    const baseModel = this.resolveModel(config)
    const tools = config.tools ?? []
    const toolMap = new Map(tools.map(t => [t.name, t]))

    const model = tools.length > 0 && 'bindTools' in baseModel
      ? (baseModel as BaseChatModel & { bindTools: (tools: StructuredToolInterface[]) => BaseChatModel }).bindTools(tools) as BaseChatModel
      : baseModel

    // 2. Build initial messages
    const systemPrompt = await this.buildSystemPrompt(config)
    const contextBlock = this.buildContextBlock(config, parentFiles)
    const allMessages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      new HumanMessage(task + contextBlock),
    ]

    // 3. Setup timeout via AbortController
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    // 4. Run ReAct loop
    const usage: SubAgentUsage = { inputTokens: 0, outputTokens: 0, llmCalls: 0 }
    const files: Record<string, string> = {}
    let hitIterationLimit = false
    const modelName = (baseModel as BaseChatModel & { model?: string }).model ?? 'unknown'

    try {
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (controller.signal.aborted) {
          allMessages.push(new AIMessage(`[Sub-agent "${config.name}" stopped: timeout after ${timeoutMs}ms]`))
          break
        }

        // Invoke LLM
        const response = await model.invoke(allMessages)
        usage.llmCalls++

        // Track token usage
        const iterUsage = extractTokenUsage(response, modelName)
        usage.inputTokens += iterUsage.inputTokens
        usage.outputTokens += iterUsage.outputTokens

        allMessages.push(response)

        // Check for tool calls
        const ai = response as AIMessage
        const toolCalls = ai.tool_calls as ToolCall[] | undefined

        if (!toolCalls || toolCalls.length === 0) {
          // No tool calls — final response
          break
        }

        // Execute each tool call
        for (const tc of toolCalls) {
          const toolCallId = tc.id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          const tool = toolMap.get(tc.name)

          if (!tool) {
            allMessages.push(new ToolMessage({
              content: `Error: Tool "${tc.name}" not found. Available tools: ${[...toolMap.keys()].join(', ')}`,
              tool_call_id: toolCallId,
              name: tc.name,
            }))
            continue
          }

          try {
            const result = await tool.invoke(tc.args)
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result)

            allMessages.push(new ToolMessage({
              content: resultStr,
              tool_call_id: toolCallId,
              name: tc.name,
            }))

            // Extract file data from write_file / edit_file / create_file tool calls
            this.extractFilesFromToolCall(tc.name, tc.args, resultStr, files)
          } catch (err: unknown) {
            // Non-fatal: return error as ToolMessage so the LLM can recover
            const errMsg = err instanceof Error ? err.message : String(err)
            allMessages.push(new ToolMessage({
              content: `Error executing tool "${tc.name}": ${errMsg}`,
              tool_call_id: toolCallId,
              name: tc.name,
            }))
          }
        }

        // Check if this was the last allowed iteration
        if (iteration === maxIterations - 1) {
          hitIterationLimit = true
        }
      }
    } finally {
      clearTimeout(timer)
    }

    return {
      messages: allMessages,
      files,
      metadata: {
        agentName: config.name,
        modelUsed: modelName,
        depth: currentDepth,
      },
      usage,
      hitIterationLimit,
    }
  }

  /**
   * Spawn a sub-agent and merge its file results back into a parent VFS.
   *
   * When the config includes tools, uses spawnReAct for a full tool-calling
   * loop. Otherwise falls back to single-turn spawn.
   */
  async spawnAndMerge(
    config: SubAgentConfig,
    task: string,
    parentFiles: Record<string, string>,
  ): Promise<{ result: SubAgentResult; mergedFiles: Record<string, string> }> {
    const result = config.tools && config.tools.length > 0
      ? await this.spawnReAct(config, task, parentFiles)
      : await this.spawn(config, task, parentFiles)
    const mergedFiles = mergeFileChanges(parentFiles, result.files)
    return { result, mergedFiles }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveModel(config: SubAgentConfig): BaseChatModel {
    if (!config.model) {
      return this.registry.getModel('codegen')
    }
    if (typeof config.model === 'string') {
      return this.registry.getModel(config.model)
    }
    return config.model
  }

  /**
   * Build system prompt, appending loaded skill content.
   */
  private async buildSystemPrompt(config: SubAgentConfig): Promise<string> {
    let systemPrompt = config.systemPrompt
    if (config.skills && config.skills.length > 0 && this.options?.skillLoader) {
      const allSkills = await this.options.skillLoader.discoverSkills()
      const configSkills = config.skills
      const relevantSkills = allSkills.filter(s => configSkills.includes(s.name))
      for (const skill of relevantSkills) {
        const content = await this.options.skillLoader.loadSkillContent(skill.name)
        if (content) {
          systemPrompt += `\n\n## Skill: ${skill.name}\n\n${content}`
        }
      }
    }
    return systemPrompt
  }

  /**
   * Build file-context block string from parent files.
   */
  private buildContextBlock(
    config: SubAgentConfig,
    parentFiles?: Record<string, string>,
  ): string {
    if (!parentFiles || Object.keys(parentFiles).length === 0) {
      return ''
    }

    const filtered = config.contextFilter
      ? config.contextFilter({ files: parentFiles })
      : { files: parentFiles }
    const files = (filtered as Record<string, unknown>).files as Record<string, string> | undefined
    if (!files || Object.keys(files).length === 0) {
      return ''
    }

    const fileList = Object.entries(files)
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
      .join('\n\n')
    return `\n\n## Existing Files\n\n${fileList}`
  }

  /**
   * Extract file path/content from tool call arguments or results.
   * Handles common patterns: { path: string, content: string } args for
   * write_file/edit_file/create_file tools.
   */
  private extractFilesFromToolCall(
    toolName: string,
    args: Record<string, unknown>,
    _resultStr: string,
    files: Record<string, string>,
  ): void {
    if (!FILE_TOOL_NAMES.has(toolName)) return

    const filePath = args['path'] ?? args['file_path'] ?? args['filePath']
    const content = args['content'] ?? args['new_content'] ?? args['newContent']

    if (typeof filePath === 'string' && typeof content === 'string') {
      files[filePath] = content
    }
  }
}
