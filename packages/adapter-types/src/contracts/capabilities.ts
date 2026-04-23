import type { AdapterProviderId } from './provider.js'

export type CapabilityStatus = 'active' | 'degraded' | 'dropped' | 'unsupported'

export interface ProviderCapabilityRow {
  systemPrompt: CapabilityStatus
  toolBindings: CapabilityStatus
  approvalMode: CapabilityStatus
  networkPolicy: CapabilityStatus
  budgetLimit: CapabilityStatus
  warnings: string[]
  /**
   * Index signature so callers can read rows generically
   * (for example when formatting a matrix into a table).
   */
  [key: string]: CapabilityStatus | string[] | undefined
}

export interface SkillCapabilityMatrix {
  skillId: string
  skillName: string
  providers: Partial<Record<AdapterProviderId, ProviderCapabilityRow>>
}
