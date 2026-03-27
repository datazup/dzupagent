/**
 * LLM-based intent classification — used as fallback when keywords don't match.
 */
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

export class LLMClassifier {
  constructor(
    private model: BaseChatModel,
    private promptTemplate: string,
    private validIntents: string[],
  ) {}

  /**
   * Classify user text into one of the valid intents via LLM.
   * The promptTemplate should contain {message} and {intents} placeholders.
   */
  async classify(text: string): Promise<string | null> {
    const prompt = this.promptTemplate
      .replace('{message}', text)
      .replace('{intents}', this.validIntents.join(', '))

    try {
      const response = await this.model.invoke([
        new SystemMessage('You are an intent classifier. Respond with ONLY the intent name, nothing else.'),
        new HumanMessage(prompt),
      ])

      const result = typeof response.content === 'string'
        ? response.content.trim().toLowerCase()
        : ''

      // Validate the response is a known intent
      if (this.validIntents.includes(result)) {
        return result
      }

      // Try partial match (LLM might return extra text)
      for (const intent of this.validIntents) {
        if (result.includes(intent)) {
          return intent
        }
      }

      return null
    } catch {
      return null
    }
  }
}
