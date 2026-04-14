/**
 * Crush CLI adapter for local code-oriented model runners.
 */

import { ForgeError } from '@dzupagent/core'

import type {
  AdapterConfig,
  AdapterCapabilityProfile,
  AdapterProviderId,
  AgentEvent,
  AgentInput,
} from '../types.js'
import { BaseCliAdapter } from '../base/base-cli-adapter.js'
import { getString } from '../utils/event-record.js'
import {
  mapCliProviderEvent,
  type CliEventMappingConfig,
} from '../utils/provider-event-normalization.js'
import { isBinaryAvailable } from '../utils/process-helpers.js'

const PROVIDER_ID: AdapterProviderId = 'crush'
const CRUSH_BINARY = 'crush'
const CRUSH_OUTPUT_FORMAT_ARGS = ['--output-format', 'jsonl'] as const

const CRUSH_EVENT_CONFIG: CliEventMappingConfig = {
  providerId: PROVIDER_ID,
  defaultErrorMessage: 'Unknown Crush CLI error',
}

function parseNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value)
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10)
  }
  return undefined
}

export class CrushAdapter extends BaseCliAdapter {
  constructor(config: AdapterConfig = {}) {
    super(PROVIDER_ID, config)
  }

  protected getBinaryName(): string {
    return CRUSH_BINARY
  }

  protected async assertReady(): Promise<void> {
    const available = await isBinaryAvailable(CRUSH_BINARY)
    if (!available) {
      throw new ForgeError({
        code: 'ADAPTER_SDK_NOT_INSTALLED',
        message: `'${CRUSH_BINARY}' binary not found in PATH`,
        recoverable: false,
        suggestion: 'Install the Crush local model runner and ensure it is available in PATH',
        context: { command: CRUSH_BINARY, providerId: PROVIDER_ID },
      })
    }
  }

  async *resumeSession(
    _sessionId: string,
    _input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    throw new ForgeError({
      code: 'ADAPTER_SESSION_NOT_FOUND',
      message: 'Crush adapter does not support session resume yet',
      recoverable: false,
      suggestion: 'Start a new session instead',
      context: { providerId: PROVIDER_ID },
    })
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: false,
    }
  }

  protected mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | undefined {
    return mapCliProviderEvent(record, sessionId, CRUSH_EVENT_CONFIG)
  }

  protected buildArgs(input: AgentInput): string[] {
    const args: string[] = []

    args.push(...CRUSH_OUTPUT_FORMAT_ARGS)

    if (input.prompt) {
      args.push('--prompt', input.prompt)
    }

    if (input.systemPrompt) {
      args.push('--system', input.systemPrompt)
    }

    if (this.config.model) {
      args.push('--model', this.config.model)
    }

    if (this.config.sandboxMode) {
      // Crush uses --permission to control filesystem access level
      const modeMap: Record<string, string> = {
        'read-only': 'read-only',
        'workspace-write': 'workspace',
        'full-access': 'full',
      }
      const mapped = modeMap[this.config.sandboxMode]
      if (mapped) {
        args.push('--permission', mapped)
      }
    }

    if (input.maxTurns !== undefined) {
      args.push('--max-turns', String(input.maxTurns))
    }

    const providerOpts = this.config.providerOptions ?? {}

    const quantization = getString(
      providerOpts,
      'quantization',
      'quant',
      'quantizationMode',
    )
    if (quantization && quantization.trim().length > 0) {
      args.push('--quantization', quantization)
    }

    const gpuLayers = parseNonNegativeInt(
      providerOpts['gpuLayers'] ?? providerOpts['gpu_layers'] ?? providerOpts['gpu-layers'],
    )
    if (gpuLayers !== undefined) {
      args.push('--gpu-layers', String(gpuLayers))
    }

    const contextSize = parseNonNegativeInt(
      providerOpts['contextSize'] ?? providerOpts['context_size'] ?? providerOpts['context-size'],
    )
    if (contextSize !== undefined && contextSize > 0) {
      args.push('--context-size', String(contextSize))
    }

    return args
  }
}
