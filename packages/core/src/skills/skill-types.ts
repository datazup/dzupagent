export interface SkillDefinition {
  name: string
  description: string
  path: string
  compatibility?: string | undefined
  allowedTools?: string[] | undefined
  metadata?: Record<string, unknown> | undefined
}
