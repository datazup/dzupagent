/**
 * Multi-stage output sanitization pipeline.
 *
 * Runs agent response content through a configurable series of stages
 * (PII redaction, secrets redaction, content policy, size limiting).
 */

import { redactSecrets } from './secrets-scanner.js'
import { redactPII } from './pii-detector.js'

export interface SanitizationStage {
  name: string
  /** Process content through this stage. Return modified content. */
  process(content: string): string | Promise<string>
  /** Whether this stage is enabled (default: true) */
  enabled?: boolean
}

export interface OutputPipelineConfig {
  /** Stages to run in order */
  stages: SanitizationStage[]
  /** Maximum output length in characters (default: 100_000) */
  maxOutputLength?: number
}

export interface PipelineResult {
  content: string
  /** Which stages modified the content */
  appliedStages: string[]
  /** Whether content was truncated */
  truncated: boolean
  /** Original length before processing */
  originalLength: number
}

const DEFAULT_MAX_OUTPUT_LENGTH = 100_000

/**
 * Output sanitization pipeline -- runs content through a series of stages.
 */
export class OutputPipeline {
  private readonly stages: SanitizationStage[]
  private readonly maxOutputLength: number

  constructor(config: OutputPipelineConfig) {
    this.stages = [...config.stages]
    this.maxOutputLength = config.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH
  }

  /** Run content through all enabled stages. */
  async process(content: string): Promise<PipelineResult> {
    const originalLength = content.length
    const appliedStages: string[] = []
    let current = content

    for (const stage of this.stages) {
      if (stage.enabled === false) continue

      const before = current
      current = await stage.process(current)

      if (current !== before) {
        appliedStages.push(stage.name)
      }
    }

    let truncated = false
    if (current.length > this.maxOutputLength) {
      current = current.slice(0, this.maxOutputLength) + '\n[TRUNCATED]'
      truncated = true
    }

    return { content: current, appliedStages, truncated, originalLength }
  }

  /** Add a stage dynamically (appended at the end, before size-limit). */
  addStage(stage: SanitizationStage): void {
    this.stages.push(stage)
  }

  /** Enable or disable a stage by name. */
  setStageEnabled(name: string, enabled: boolean): void {
    const stage = this.stages.find((s) => s.name === name)
    if (stage) {
      stage.enabled = enabled
    }
  }
}

/**
 * Create the default output sanitization pipeline.
 * Stages: PII detection -> secrets redaction -> content policy -> size limiting
 */
export function createDefaultPipeline(config?: {
  enablePII?: boolean
  enableSecrets?: boolean
  maxLength?: number
  customDenyList?: string[]
}): OutputPipeline {
  const stages: SanitizationStage[] = [
    {
      name: 'pii-redaction',
      enabled: config?.enablePII !== false,
      process: (content: string) => redactPII(content),
    },
    {
      name: 'secrets-redaction',
      enabled: config?.enableSecrets !== false,
      process: (content: string) => redactSecrets(content),
    },
  ]

  // Content policy stage (optional deny-list of regex patterns)
  const denyList = config?.customDenyList
  if (denyList && denyList.length > 0) {
    const denyPatterns = denyList.map((p) => new RegExp(p, 'gi'))
    stages.push({
      name: 'content-policy',
      enabled: true,
      process: (content: string) => {
        let result = content
        for (const pattern of denyPatterns) {
          pattern.lastIndex = 0
          result = result.replace(pattern, '[BLOCKED]')
        }
        return result
      },
    })
  }

  return new OutputPipeline({
    stages,
    maxOutputLength: config?.maxLength ?? DEFAULT_MAX_OUTPUT_LENGTH,
  })
}
