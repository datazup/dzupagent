export interface SkillDefinition {
  name: string
  description: string
  path: string
  compatibility?: string
  allowedTools?: string[]
  metadata?: Record<string, unknown>
}
