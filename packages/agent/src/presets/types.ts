export interface AgentPreset {
  name: string
  description: string
  instructions: string
  /** Tool names this preset expects (matched at runtime) */
  toolNames: string[]
  guardrails: {
    maxIterations: number
    maxCostCents?: number
    maxTokens?: number
  }
  memoryProfile?: 'minimal' | 'balanced' | 'memory-heavy'
  selfCorrection?: {
    enabled: boolean
    reflectionThreshold?: number
    maxReflectionIterations?: number
  }
  defaultModelTier?: string
}

export interface PresetRuntimeDeps {
  /** Model instance or registry */
  model: unknown
  /** Available tools — filtered by preset.toolNames */
  tools?: unknown[]
  /** Memory service */
  memory?: unknown
  /** Event bus */
  eventBus?: unknown
  /** Override preset fields */
  overrides?: Partial<Pick<AgentPreset, 'instructions' | 'guardrails' | 'memoryProfile'>>
}
