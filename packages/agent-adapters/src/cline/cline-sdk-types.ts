/** Structural subset of @cline/sdk, @cline/core and @cline/shared 0.2.0.
 * Keep this module runtime-free: only the dedicated worker may load Cline.
 */
export interface ClineToolPolicy { enabled: boolean; autoApprove: false }
export interface ClineApprovalRequest {
  sessionId: string
  agentId: string
  conversationId: string
  iteration: number
  toolCallId: string
  toolName: string
  input: unknown
  policy: { enabled?: boolean; autoApprove?: boolean }
}
export interface ClineApprovalResult { approved: boolean; reason?: string }
export interface ClineNativeEvent { type: string; payload: Record<string, unknown> }
export interface ClineNativeResult {
  sessionId: string
  result?: { text: string; finishReason: string; usage?: unknown; durationMs?: number }
}
export interface ClineStartInput {
  config: {
    sessionId: string
    cwd: string
    workspaceRoot: string
    providerId: string
    modelId: string
    systemPrompt: string
    mode: 'act'
    enableTools: boolean
    enableSpawnAgent: false
    enableAgentTeams: false
    disableMcpSettingsTools: true
    mcpApps: false
    yolo: false
    pluginPaths: []
    agentPluginPaths: []
    extensions: []
    skills: []
    maxIterations?: number
    checkpoint: { enabled: false }
    compaction: { enabled: false }
    toolPolicies: Record<string, ClineToolPolicy>
  }
  prompt: string
  interactive: false
  localRuntime: { configExtensions: []; extensions: []; extraTools: [] }
  plugins: { '*': { enabled: false } }
  toolPolicies: Record<string, ClineToolPolicy>
  capabilities: { requestToolApproval(request: ClineApprovalRequest): Promise<ClineApprovalResult> }
}
export interface ClineCoreInstance {
  subscribe(listener: (event: ClineNativeEvent) => void, options: { sessionId: string }): () => void
  start(input: ClineStartInput): Promise<ClineNativeResult>
  stop(sessionId: string): Promise<void>
  dispose(): Promise<void>
}
export interface ClineSdk {
  ClineCore: {
    create(options: {
      backendMode: 'local'
      automation: false
      clientName: string
      distinctId: string
      toolPolicies: Record<string, ClineToolPolicy>
      capabilities: ClineStartInput['capabilities']
    }): Promise<ClineCoreInstance>
  }
}
