/**
 * LLM call audit helpers for the generate tool loop (MC-026b-2).
 *
 * RF-12 / REC-M-05: every LLM invocation is recorded in the configured
 * audit sink for compliance traceability. Wrapping is fire-and-forget
 * — synchronous throws and rejected promises are swallowed so a faulty
 * sink can never abort an in-progress run.
 *
 * Extracted from `run-engine-generate-helpers.ts` so the audit-sink
 * wiring lives apart from the tool-loop coordinator.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { extractTokenUsage } from '@dzupagent/core/llm'
import type {
  LlmCallAuditEntry,
  LlmCallAuditSink,
} from '../observability/llm-call-audit.js'
import type { ExecuteGenerateRunParams } from './run-engine/types.js'

/**
 * Push an LLM-call audit entry to the configured sink. Fire-and-forget:
 * synchronous throws and rejected promises are swallowed so the run
 * never fails because of an audit-sink defect.
 */
export async function recordAuditEntry(
  sink: LlmCallAuditSink,
  entry: LlmCallAuditEntry,
): Promise<void> {
  try {
    await sink.record(entry)
  } catch {
    // Audit sink failures must never disturb the run. Compliance reports
    // surface missing entries via downstream reconciliation, not here.
  }
}

/**
 * Wrap the caller-supplied `invokeModel` so each LLM call is forwarded
 * to the configured audit sink (RF-12). Returns a function with the
 * exact same signature as the inner `invokeModel`, so the tool loop
 * can swap it in transparently.
 *
 * Returned wrapper performs:
 *  - bounded prompt / response previews (500-char snippets)
 *  - duration measurement (ms)
 *  - tenantId tagging (REC-M-05)
 *  - success and failure entries with usage / error attribution
 */
export function wrapInvokeModelWithAudit(
  params: ExecuteGenerateRunParams,
): (model: BaseChatModel, messages: BaseMessage[]) => Promise<BaseMessage> {
  const auditStore = params.config.auditStore
  // Hot-path optimisation: when no audit sink is configured, return the
  // raw caller invoker unchanged so we don't pay the wrapper cost.
  if (!auditStore) {
    return params.invokeModel
  }

  const auditTenantId = params.config.memoryScope?.['tenantId']

  return async (model, messages) => {
    const startMs = Date.now()
    const modelId =
      (model as BaseChatModel & { model?: string }).model
      ?? (typeof params.config.model === 'string' ? params.config.model : 'unknown')
    // REC-M-05 — serialise the outgoing prompt so compliance pipelines
    // can reconstruct the exact conversation turn that triggered each
    // model call. Serialisation is best-effort and never throws.
    let promptStr: string | undefined
    try {
      promptStr = JSON.stringify(
        messages.map((m) => ({
          type:
            (m as BaseMessage & { _getType?: () => string })._getType?.()
            ?? m.constructor.name,
          content:
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
      )
    } catch {
      // Serialisation failure must never abort the run.
    }
    // REC-M-05 — bounded prompt preview for compliance dashboards. Always
    // truncated to 500 chars so audit entries stay small even when the
    // full `prompt` field is dropped downstream for privacy.
    const promptSnippet = promptStr?.slice(0, 500)
    try {
      const response = await params.invokeModel(model, messages)
      const usage = extractTokenUsage(response, modelId)
      // REC-M-05 — capture the model response string on the success path.
      let responseStr: string | undefined
      try {
        responseStr =
          typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content)
      } catch {
        // Serialisation failure must never abort the run.
      }
      const responseSnippet = responseStr?.slice(0, 500)
      void recordAuditEntry(auditStore, {
        agentId: params.agentId,
        ...(params.options?.runId !== undefined ? { runId: params.options.runId } : {}),
        ...(auditTenantId !== undefined ? { tenantId: auditTenantId } : {}),
        model: modelId,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        durationMs: Date.now() - startMs,
        timestamp: Date.now(),
        success: true,
        ...(promptStr !== undefined ? { prompt: promptStr } : {}),
        ...(responseStr !== undefined ? { response: responseStr } : {}),
        ...(promptSnippet !== undefined ? { promptSnippet } : {}),
        ...(responseSnippet !== undefined ? { responseSnippet } : {}),
      })
      return response
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      void recordAuditEntry(auditStore, {
        agentId: params.agentId,
        ...(params.options?.runId !== undefined ? { runId: params.options.runId } : {}),
        ...(auditTenantId !== undefined ? { tenantId: auditTenantId } : {}),
        model: modelId,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - startMs,
        timestamp: Date.now(),
        success: false,
        error: errorMessage,
        ...(promptStr !== undefined ? { prompt: promptStr } : {}),
        ...(promptSnippet !== undefined ? { promptSnippet } : {}),
      })
      throw err
    }
  }
}
