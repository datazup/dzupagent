/**
 * Langfuse tracing middleware — creates callback handlers for LangChain.
 * Accepts config as parameters (no env.ts dependency).
 */

export interface LangfuseConfig {
  publicKey: string
  secretKey: string
  baseUrl?: string
  enabled?: boolean
}

export interface LangfuseHandlerOptions {
  sessionId?: string
  userId?: string
  metadata?: Record<string, unknown>
  tags?: string[]
}

/**
 * Create a Langfuse callback handler for LangChain tracing.
 * Returns null if Langfuse is not configured or disabled.
 *
 * Note: This function dynamically imports langfuse-langchain to avoid
 * hard dependency. The package must be installed by the consumer.
 */
export async function createLangfuseHandler(
  config: LangfuseConfig,
  options?: LangfuseHandlerOptions,
): Promise<unknown | null> {
  if (!config.enabled || !config.publicKey || !config.secretKey) {
    return null
  }

  try {
    // Dynamic import to avoid hard dependency
    const { CallbackHandler } = await import('langfuse-langchain') as {
      CallbackHandler: new (params: Record<string, unknown>) => unknown
    }
    return new CallbackHandler({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options?.userId ? { userId: options.userId } : {}),
      ...(options?.metadata ? { metadata: options.metadata } : {}),
      ...(options?.tags ? { tags: options.tags } : {}),
    })
  } catch {
    // langfuse-langchain not installed — return null
    return null
  }
}
