/**
 * LlmRecorder — record/replay RegistryMiddleware for deterministic CI.
 *
 * Record mode  (LLM_RECORD=1): lets the real LLM call through, then
 *   serialises (request, response) to a JSON fixture file.
 * Replay mode  (default):       loads the fixture and short-circuits the
 *   LLM call in beforeInvoke, returning the saved response without hitting
 *   the network.
 *
 * Plug into ModelRegistry:
 *   registry.use(new LlmRecorder({ fixtureDir: '__fixtures__/llm' }))
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type {
  RegistryMiddleware,
  MiddlewareContext,
  MiddlewareResult,
  MiddlewareTokenUsage,
} from '@dzupagent/core'

export type RecorderMode = 'record' | 'replay'

export interface LlmRecorderOptions {
  /**
   * Directory where fixture JSON files are stored.
   * Relative paths are resolved from process.cwd().
   */
  fixtureDir: string
  /**
   * 'record' — pass through to the LLM and save the response.
   * 'replay' — return the saved response; throw if fixture is missing.
   * Defaults to 'replay'. Set mode: 'record' or LLM_RECORD=1 env var.
   */
  mode?: RecorderMode
  /**
   * When true, throw on a cache miss in replay mode instead of falling
   * through to the real LLM. Default: true.
   */
  strict?: boolean
}

/** Shape stored in each fixture JSON file */
export interface LlmFixture {
  request: {
    messages: Array<{ role: string; content: string }>
    model?: string
    temperature?: number
    maxTokens?: number
    provider?: string
  }
  response: string
  usage?: { inputTokens: number; outputTokens: number }
  recordedAt: string
}

/**
 * Stable, order-independent hash of a MiddlewareContext used as the
 * fixture file name so identical logical requests resolve to the same file.
 */
function hashContext(ctx: MiddlewareContext): string {
  const key = JSON.stringify({
    messages: ctx.messages,
    model: ctx.model ?? '',
    temperature: ctx.temperature ?? null,
    maxTokens: ctx.maxTokens ?? null,
    provider: ctx.provider ?? '',
  })
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

export class LlmRecorder implements RegistryMiddleware {
  readonly name = 'llm-recorder'

  private readonly fixtureDir: string
  private readonly mode: RecorderMode
  private readonly strict: boolean

  constructor(options: LlmRecorderOptions) {
    this.fixtureDir = resolve(options.fixtureDir)
    this.mode =
      options.mode ??
      (process.env['LLM_RECORD'] ? 'record' : 'replay')
    this.strict = options.strict ?? true
  }

  // -------------------------------------------------------------------------
  // RegistryMiddleware hooks
  // -------------------------------------------------------------------------

  async beforeInvoke(context: MiddlewareContext): Promise<MiddlewareResult> {
    if (this.mode === 'record') {
      // Always pass through; recording happens in afterInvoke.
      return { cached: false }
    }

    // Replay mode: look up fixture
    const fixturePath = this.fixturePath(context)
    if (!existsSync(fixturePath)) {
      if (this.strict) {
        throw new Error(
          `[LlmRecorder] No fixture found for request (hash ${hashContext(context)}). ` +
          `Expected file: ${fixturePath}. ` +
          `Run with LLM_RECORD=1 to generate it.`,
        )
      }
      return { cached: false }
    }

    const fixture = this.loadFixture(fixturePath)
    const result: MiddlewareResult = { cached: true, response: fixture.response }
    if (fixture.usage) result.usage = fixture.usage
    return result
  }

  async afterInvoke(
    context: MiddlewareContext,
    response: string,
    usage?: MiddlewareTokenUsage,
  ): Promise<void> {
    if (this.mode !== 'record') return

    const fixture: LlmFixture = {
      request: {
        messages: context.messages,
        ...(context.model !== undefined ? { model: context.model } : {}),
        ...(context.temperature !== undefined ? { temperature: context.temperature } : {}),
        ...(context.maxTokens !== undefined ? { maxTokens: context.maxTokens } : {}),
        ...(context.provider !== undefined ? { provider: context.provider } : {}),
      },
      response,
      ...(usage ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } } : {}),
      recordedAt: new Date().toISOString(),
    }

    const fixturePath = this.fixturePath(context)
    mkdirSync(this.fixtureDir, { recursive: true })
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), 'utf-8')
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private fixturePath(ctx: MiddlewareContext): string {
    return join(this.fixtureDir, `${hashContext(ctx)}.json`)
  }

  private loadFixture(path: string): LlmFixture {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as LlmFixture
    } catch (err) {
      throw new Error(`[LlmRecorder] Failed to load fixture at ${path}: ${String(err)}`)
    }
  }

  /**
   * Manually write a fixture — useful in tests to seed replay responses
   * without ever hitting a real LLM.
   */
  seedFixture(context: MiddlewareContext, response: string, usage?: { inputTokens: number; outputTokens: number }): void {
    const fixture: LlmFixture = {
      request: {
        messages: context.messages,
        ...(context.model !== undefined ? { model: context.model } : {}),
        ...(context.temperature !== undefined ? { temperature: context.temperature } : {}),
        ...(context.maxTokens !== undefined ? { maxTokens: context.maxTokens } : {}),
        ...(context.provider !== undefined ? { provider: context.provider } : {}),
      },
      response,
      ...(usage ? { usage } : {}),
      recordedAt: new Date().toISOString(),
    }
    mkdirSync(this.fixtureDir, { recursive: true })
    writeFileSync(this.fixturePath(context), JSON.stringify(fixture, null, 2), 'utf-8')
  }

  /** Return the fixture file path for a given context (for test assertions). */
  getFixturePath(context: MiddlewareContext): string {
    return this.fixturePath(context)
  }

  /** True when a fixture already exists for this context. */
  hasFixture(context: MiddlewareContext): boolean {
    return existsSync(this.fixturePath(context))
  }
}
