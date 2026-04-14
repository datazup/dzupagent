/**
 * LLM Recorder — record and replay LLM interactions for deterministic testing.
 *
 * Modes:
 * - `record`: Calls the real model and saves responses to fixture files
 * - `replay`: Returns saved responses without network calls
 * - `passthrough`: Calls the real model without saving (default behavior)
 *
 * @example
 * ```ts
 * const recorder = new LLMRecorder({
 *   fixtureDir: '__fixtures__/llm',
 *   mode: process.env.LLM_RECORD ? 'record' : 'replay',
 * })
 *
 * // In tests:
 * const model = recorder.wrap(realModel)
 * const result = await model.invoke(messages) // uses fixture in replay mode
 * ```
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { join, dirname } from 'node:path'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { MockChatModel } from './mock-model.js'

export type RecorderMode = 'record' | 'replay' | 'passthrough'

export interface RecorderConfig {
  /** Directory to store fixture files */
  fixtureDir: string
  /** Operating mode */
  mode: RecorderMode
  /** Custom hash function for fixture naming */
  hashInput?: (messages: BaseMessage[]) => string
}

export interface Fixture {
  input: Array<{ role: string; content: unknown }>
  output: { role: string; content: string }
  model?: string
  recordedAt: string
}

export class LLMRecorder {
  private config: RecorderConfig

  constructor(config: RecorderConfig) {
    this.config = config
  }

  /**
   * Wrap a model with record/replay behavior.
   *
   * In `replay` mode, returns a MockChatModel that reads from fixtures.
   * In `record` mode, calls the real model and saves the response.
   * In `passthrough` mode, calls the real model without saving.
   */
  wrap(model: BaseChatModel): BaseChatModel {
    if (this.config.mode === 'passthrough') return model

    if (this.config.mode === 'replay') {
      // Return a mock that loads fixtures on demand
      return new ReplayModel(this.config)
    }

    // Record mode: wrap the real model
    return new RecordingModel(model, this.config)
  }

  /** Create a replay model for a specific named scenario */
  replay(scenarioName: string): MockChatModel {
    const fixturePath = join(this.config.fixtureDir, `${scenarioName}.json`)
    const fixture = this.loadFixture(fixturePath)
    return new MockChatModel([fixture.output.content])
  }

  /** Check if a fixture exists for given messages */
  hasFixture(messages: BaseMessage[]): boolean {
    const hash = this.hashMessages(messages)
    const fixturePath = join(this.config.fixtureDir, `${hash}.json`)
    return existsSync(fixturePath)
  }

  /** List all fixture files in the fixture directory */
  listFixtures(): string[] {
    if (!existsSync(this.config.fixtureDir)) return []
    const { readdirSync } = require('node:fs') as typeof NodeFs
    return readdirSync(this.config.fixtureDir)
      .filter((f: string) => f.endsWith('.json'))
      .map((f: string) => f.replace('.json', ''))
  }

  hashMessages(messages: BaseMessage[]): string {
    if (this.config.hashInput) return this.config.hashInput(messages)
    const content = messages.map(m => {
      const c = m.content
      return typeof c === 'string' ? c : JSON.stringify(c)
    }).join('|')
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  saveFixture(fixturePath: string, fixture: Fixture): void {
    mkdirSync(dirname(fixturePath), { recursive: true })
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2))
  }

  loadFixture(fixturePath: string): Fixture {
    if (!existsSync(fixturePath)) {
      throw new Error(
        `LLM fixture not found: ${fixturePath}. ` +
        `Run tests with LLM_RECORD=1 to record fixtures.`,
      )
    }
    return JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture
  }
}

/**
 * Internal: Model wrapper that replays from fixtures.
 */
class ReplayModel extends MockChatModel {
  private recorder: LLMRecorder

  constructor(config: RecorderConfig) {
    super(['']) // placeholder — overridden by _generate
    this.recorder = new LLMRecorder(config)
  }

  async _generate(messages: BaseMessage[]): Promise<{ generations: Array<{ text: string; message: AIMessage }> }> {
    const hash = this.recorder.hashMessages(messages)
    const fixturePath = join(
      (this.recorder as unknown as { config: RecorderConfig }).config.fixtureDir,
      `${hash}.json`,
    )
    const fixture = this.recorder.loadFixture(fixturePath)
    const content = fixture.output.content

    return {
      generations: [{ text: content, message: new AIMessage(content) }],
    }
  }
}

/**
 * Internal: Model wrapper that records responses.
 */
class RecordingModel extends MockChatModel {
  private realModel: BaseChatModel
  private recorder: LLMRecorder

  constructor(model: BaseChatModel, config: RecorderConfig) {
    super(['']) // placeholder
    this.realModel = model
    this.recorder = new LLMRecorder(config)
  }

  async _generate(messages: BaseMessage[]): Promise<{ generations: Array<{ text: string; message: AIMessage }> }> {
    // Call the real model
    const result = await this.realModel.invoke(messages)
    const content = typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content)

    // Save fixture
    const hash = this.recorder.hashMessages(messages)
    const fixturePath = join(
      (this.recorder as unknown as { config: RecorderConfig }).config.fixtureDir,
      `${hash}.json`,
    )

    this.recorder.saveFixture(fixturePath, {
      input: messages.map(m => ({
        role: m._getType(),
        content: m.content,
      })),
      output: { role: 'assistant', content },
      recordedAt: new Date().toISOString(),
    })

    return {
      generations: [{ text: content, message: new AIMessage(content) }],
    }
  }
}
