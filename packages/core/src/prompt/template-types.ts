/** Variable declaration for a prompt template */
export interface TemplateVariable {
  name: string
  description: string
  required: boolean
  defaultValue?: string
  /** Open-ended source category (not locked to domain-specific types) */
  source?: string
}

/** Generic context — any key/value map */
export type TemplateContext = Record<string, unknown>

/** Resolved prompt returned by PromptResolver */
export interface ResolvedPrompt {
  content: string
  config: Record<string, unknown>
}

/** Query for resolving a prompt template */
export interface PromptResolveQuery {
  type: string
  category?: string
  tenantId?: string
  userId?: string
  templateId?: string
}

/** Stored template returned by PromptStore */
export interface StoredTemplate {
  id: string
  type: string
  category: string
  content: string
  variables: TemplateVariable[]
  config: Record<string, unknown>
}

/** Bulk query for preloading templates */
export interface BulkPromptQuery {
  types: string[]
  tenantId?: string
  userId?: string
}
