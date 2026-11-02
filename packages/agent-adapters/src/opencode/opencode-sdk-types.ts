/** Structural subset of @opencode-ai/sdk/client 1.19.5 (not the v2 API).
 * Keep the optional package lazy; the attached host owns server qualification.
 */
export interface OpenCodeResult<T> { data?: T; error?: unknown }
export interface OpenCodeRequest {
  query: { directory: string }
  signal: AbortSignal
  throwOnError: true
}
export interface OpenCodePart {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  callID?: string
  tool?: string
  state?: {
    status: string
    input: Record<string, unknown>
    output?: string
    error?: string
    time?: { start: number; end?: number }
  }
}
export interface OpenCodeMessage {
  id: string
  sessionID: string
  role: string
  parentID?: string
  time: { created: number; completed?: number }
  error?: unknown
  finish?: string
  tokens?: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } }
  cost?: number
}
export interface OpenCodePromptResult { info: OpenCodeMessage; parts: OpenCodePart[] }
export interface OpenCodeEvent { type: string; properties: Record<string, unknown> }
export interface OpenCodeClient {
  tool: { ids(options: OpenCodeRequest): Promise<OpenCodeResult<string[]>> }
  session: {
    create(options: OpenCodeRequest & { body: { title: string } }): Promise<OpenCodeResult<{ id: string; directory: string }>>
    prompt(options: OpenCodeRequest & {
      path: { id: string }
      body: {
        messageID: string
        parts: Array<{ type: 'text'; text: string }>
        tools: Record<string, boolean>
        system?: string
        model?: { providerID: string; modelID: string }
      }
    }): Promise<OpenCodeResult<OpenCodePromptResult>>
    abort(options: OpenCodeRequest & { path: { id: string } }): Promise<OpenCodeResult<boolean>>
  }
  event: {
    subscribe(options: OpenCodeRequest & { sseMaxRetryAttempts: number }): Promise<{ stream: AsyncIterable<OpenCodeEvent> }>
  }
  postSessionIdPermissionsPermissionId(options: OpenCodeRequest & {
    path: { id: string; permissionID: string }
    body: { response: 'once' | 'reject' }
  }): Promise<OpenCodeResult<boolean>>
}
export interface OpenCodeSdk {
  createOpencodeClient(options: {
    baseUrl: string
    directory: string
    fetch: typeof globalThis.fetch
  }): OpenCodeClient
}
export type OpenCodeSdkLoader = () => Promise<OpenCodeSdk>

export function requireData<T>(result: OpenCodeResult<T>): T {
  if (!result || result.error !== undefined || result.data === undefined) {
    // Upstream diagnostics can include secrets or prompt text.
    throw new Error('OpenCode request failed')
  }
  return result.data
}
