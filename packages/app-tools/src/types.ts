export type PermissionLevel = 'read' | 'write' | 'admin'

export interface SideEffect {
  type: 'creates_external_resource' | 'modifies_external_resource' | 'sends_notification' | 'writes_file'
  description?: string
}

export interface DomainToolDefinition {
  name: string               // dot-namespaced: "pm.create_task"
  description: string
  inputSchema: Record<string, unknown>   // JSON Schema object
  outputSchema: Record<string, unknown>  // JSON Schema object
  permissionLevel: PermissionLevel
  sideEffects: SideEffect[]
  requiresApproval?: boolean
  namespace: string          // e.g. "pm", "project_docs", "topics"
}

export interface DomainToolRegistry {
  register(tool: DomainToolDefinition): void
  get(name: string): DomainToolDefinition | undefined
  list(): DomainToolDefinition[]
  listByNamespace(namespace: string): DomainToolDefinition[]
}
