/**
 * Code generation service — generates individual source files via LLM.
 * Uses ModelRegistry from @dzupagent/core for model resolution.
 */
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { ModelRegistry, ModelTier, TokenUsage } from '@dzupagent/core'
import { extractTokenUsage } from '@dzupagent/core'
import { extractLargestCodeBlock, detectLanguage } from './code-block-parser.js'

export interface GenerateFileParams {
  filePath: string
  purpose: string
  referenceFiles?: Record<string, string>
  context?: Record<string, string>
}

export interface GenerateFileResult {
  content: string
  source: 'llm'
  tokensUsed: TokenUsage
  language: string
}

export class CodeGenService {
  constructor(
    private registry: ModelRegistry,
    private options?: { modelTier?: ModelTier },
  ) {}

  /**
   * Generate a single source file using the LLM.
   */
  async generateFile(
    params: GenerateFileParams,
    systemPrompt: string,
  ): Promise<GenerateFileResult> {
    const model = this.registry.getModel(this.options?.modelTier ?? 'codegen')
    const language = detectLanguage(params.filePath)

    let userMessage = `Generate the file: ${params.filePath}\nPurpose: ${params.purpose}\nLanguage: ${language}`

    if (params.referenceFiles && Object.keys(params.referenceFiles).length > 0) {
      const refs = Object.entries(params.referenceFiles)
        .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
        .join('\n\n')
      userMessage += `\n\n## Reference Files\n\n${refs}`
    }

    if (params.context && Object.keys(params.context).length > 0) {
      const ctx = Object.entries(params.context)
        .map(([key, value]) => `- ${key}: ${value}`)
        .join('\n')
      userMessage += `\n\n## Context\n\n${ctx}`
    }

    userMessage += `\n\nGenerate the complete file content. Wrap the code in a markdown code block with the appropriate language tag.`

    const response = await model.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userMessage),
    ])

    const rawContent = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content)

    const content = extractLargestCodeBlock(rawContent)
    const modelName = (model as unknown as { model?: string }).model
    const tokensUsed = extractTokenUsage(response, modelName)

    return { content, source: 'llm', tokensUsed, language }
  }
}
