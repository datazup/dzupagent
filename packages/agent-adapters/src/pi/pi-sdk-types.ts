/**
 * Private structural seam for @earendil-works/pi-coding-agent 1.5.0.
 * Verified emitted declarations: coding-agent 4/103/135/172/186/189/196/236,
 * pi-agent-core 6 and pi-ai 180, retained by P02-ADMISSION.md.
 * Deliberately no static import of the optional SDK (or its transitive SDKs).
 */
export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
  reasoning?: number
  totalTokens: number
  cost: { total: number; totalFromProvider?: boolean }
}

export interface PiMessage {
  role: string
  content: string | Array<{ type: string; text?: string; id?: string }>
  stopReason?: 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred'
  usage?: PiUsage
  errorMessage?: string
  deferred?: unknown
}

export type PiEvent =
  | { type: 'message_update'; message: PiMessage; assistantMessageEvent: { type: string; delta?: string } }
  | { type: 'message_end'; message: PiMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: { content: PiMessage['content']; usage?: PiUsage }; isError: boolean; durationMs?: number }
  | { type: 'agent_end'; messages: PiMessage[]; willRetry: boolean }
  | { type: 'agent_settled'; aborted: boolean }
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string }
  | { type: 'agent_start' | 'turn_start' | 'message_start' | 'turn_end' | 'tool_execution_update' | 'queue_update' | 'compaction_start' | 'compaction_end' | 'entry_appended' | 'session_info_changed' | 'thinking_level_changed' | 'summarization_retry_scheduled' | 'summarization_retry_attempt_start' | 'summarization_retry_finished' | 'bash_execution_update' }

export interface PiToolCall {
  type: 'tool_call'
  toolCallId: string
  toolName: string
  input: unknown
}

export interface PiToolDecision { block?: boolean; reason?: string; terminate?: boolean }
export interface PiExtensionAPI {
  on(event: 'tool_call', handler: (event: PiToolCall) => Promise<PiToolDecision | undefined>): () => void
}
export type PiExtensionFactory = (api: PiExtensionAPI) => void | Promise<void>

export interface PiSessionManager {
  getSessionId(): string
  getCwd(): string
  getSessionFile(): string | undefined
}

export interface PiSession {
  readonly sessionId: string
  readonly messages: PiMessage[]
  readonly isStreaming: boolean
  readonly isRetrying: boolean
  readonly pendingMessageCount: number
  readonly state: { readonly pendingToolCalls: ReadonlySet<string> }
  subscribe(listener: (event: PiEvent) => void): () => void
  prompt(text: string, options: { expandPromptTemplates: false; source: 'rpc' }): Promise<void>
  abort(): Promise<void>
  dispose(): void
  getSessionStats(): { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost: number }
}

export interface PiSettings {
  packages: never[]
  extensions: never[]
  skills: never[]
  prompts: never[]
  themes: never[]
  enableSkillCommands: false
  enableAnalytics: false
  enableInstallTelemetry: false
  cacheWarming: 'off'
  compaction: { enabled: false }
}

export interface PiResourceOptions {
  cwd: string
  agentDir: string
  settingsManager: unknown
  noExtensions: true
  noSkills: true
  noPromptTemplates: true
  noThemes: true
  noContextFiles: true
  additionalExtensionPaths: never[]
  additionalSkillPaths: never[]
  additionalPromptTemplatePaths: never[]
  additionalThemePaths: never[]
  extensionFactories: PiExtensionFactory[]
  systemPrompt: string
  appendSystemPrompt: string[]
  systemPromptOverride: (base: string | undefined) => string | undefined
  appendSystemPromptOverride: (base: string[]) => string[]
}

export interface PiResourceLoader { reload(): Promise<void> }
export interface PiModelRuntime { getModel(provider: string, model: string): unknown }

export interface PiCreateOptions {
  cwd: string
  agentDir: string
  settingsManager: unknown
  resourceLoader: PiResourceLoader
  modelRuntime: PiModelRuntime
  sessionManager: PiSessionManager
  model: unknown
  thinkingLevel?: string
  tools: string[]
  excludeTools: string[]
}

export interface PiSdk {
  VERSION: string
  SettingsManager: { inMemory(settings: PiSettings, options: { projectTrusted: false }): unknown }
  DefaultResourceLoader: new (options: PiResourceOptions) => PiResourceLoader
  ModelRuntime: { create(options: { authPath: string; modelsPath: null; modelsStorePath: string; allowModelNetwork: false; refreshOnCreate: false; signal: AbortSignal }): Promise<PiModelRuntime> }
  SessionManager: {
    create(cwd: string, sessionDir: string): PiSessionManager
    findById(cwd: string, id: string, sessionDir: string): string | undefined
    open(path: string, sessionDir: string): PiSessionManager
  }
  createAgentSession(options: PiCreateOptions): Promise<{ session: PiSession }>
}

export type PiSdkLoader = () => Promise<PiSdk>
