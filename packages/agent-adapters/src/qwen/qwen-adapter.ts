/**
 * Qwen CLI adapter.
 *
 * Qwen models are commonly exposed through OpenAI-compatible endpoints, but
 * this adapter targets the CLI surface used by local or wrapped deployments.
 *
 * Streaming lifecycle: this adapter inherits from {@link BaseCliAdapter},
 * which already composes {@link AdapterStreamRunner} internally — so it
 * shares the same heartbeat, abort, and audit emission as the SDK-backed
 * adapters (Claude/Codex). For bespoke CLI shapes that cannot live inside
 * `BaseCliAdapter.execute()`, see {@link CliAdapterStreamSource} in
 * `../base/cli-stream-source.ts`. (REC-L-06 closed — see audit closure
 * 2026-05-08.)
 */

import { ForgeError } from '@dzupagent/core/events'

import type {
  AdapterConfig,
  AdapterCapabilityProfile,
  AdapterProviderId,
  AgentEvent,
  AgentInput,
} from '../types.js'
import { BaseCliAdapter } from '../base/base-cli-adapter.js'
import {
  mapCliProviderEvent,
  type CliEventMappingConfig,
} from '../utils/provider-event-normalization.js'
import { isBinaryAvailable } from '../utils/process-helpers.js'

const PROVIDER_ID: AdapterProviderId = 'qwen'
const QWEN_BINARY = 'qwen'
const QWEN_OUTPUT_FORMAT_ARGS = ['--output-format', 'jsonl'] as const

const QWEN_EVENT_CONFIG: CliEventMappingConfig = {
  providerId: PROVIDER_ID,
  extraToolNameKeys: ['function'],
  defaultErrorMessage: 'Unknown Qwen CLI error',
}

export class QwenAdapter extends BaseCliAdapter {
  constructor(config: AdapterConfig = {}) {
    super(PROVIDER_ID, config)
  }

  protected getBinaryName(): string {
    return QWEN_BINARY
  }

  protected async assertReady(): Promise<void> {
    const available = await isBinaryAvailable(QWEN_BINARY)
    if (!available) {
      throw new ForgeError({
        code: 'ADAPTER_SDK_NOT_INSTALLED',
        message: `'${QWEN_BINARY}' binary not found in PATH`,
        recoverable: false,
        suggestion:
          'Install the Qwen CLI, or use Qwen models via ModelRegistry with an ' +
          'OpenAI-compatible provider (set baseUrl to your DashScope or local endpoint)',
        context: { command: QWEN_BINARY, providerId: PROVIDER_ID },
      })
    }
  }

  protected getUnavailableBinaryMessage(binary: string): string {
    return `'${binary}' binary not found in PATH. ` +
      'Qwen models can be accessed via ModelRegistry with OpenAI-compatible provider.'
  }

  protected mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | undefined {
    return mapCliProviderEvent(record, sessionId, QWEN_EVENT_CONFIG)
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: false,
    }
  }

  protected buildArgs(input: AgentInput): string[] {
    const args: string[] = []

    args.push(...QWEN_OUTPUT_FORMAT_ARGS)

    if (input.prompt) {
      args.push('--prompt', input.prompt)
    }

    if (input.resumeSessionId) {
      args.push('--session', input.resumeSessionId)
    }

    if (input.systemPrompt) {
      args.push('--system', input.systemPrompt)
    }

    if (this.config.model) {
      args.push('--model', this.config.model)
    }

    const sandboxMode =
      (typeof input.options?.['sandboxMode'] === 'string'
        ? input.options['sandboxMode']
        : this.config.sandboxMode)
    if (sandboxMode) {
      // Qwen CLI uses --sandbox with mode values analogous to Gemini
      const modeMap: Record<string, string> = {
        'read-only': 'sandbox',
        'workspace-write': 'workspace',
        'full-access': 'none',
      }
      const mapped = modeMap[sandboxMode]
      if (mapped) {
        args.push('--sandbox', mapped)
      }
    }

    if (input.maxTurns !== undefined) {
      args.push('--max-turns', String(input.maxTurns))
    }

    return args
  }

  protected buildEnv(): Record<string, string> {
    const env = super.buildEnv()

    if (this.config.apiKey) {
      // DashScope uses DASHSCOPE_API_KEY
      env['DASHSCOPE_API_KEY'] = this.config.apiKey
    }

    return env
  }
}
