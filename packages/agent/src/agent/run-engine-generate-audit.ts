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
import { redactPII, redactSecrets } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core/events'
import type {
  LlmCallAuditEntry,
  LlmCallAuditSink,
} from '../observability/llm-call-audit.js'
import type { ExecuteGenerateRunParams } from './run-engine/types.js'
import type { AuditRedactionMode } from './agent-types-observability.js'

const DEFAULT_AUDIT_REDACTION_MODE: AuditRedactionMode = 'secrets-and-pii'

interface ResolvedAuditRedactionPolicy {
  mode: AuditRedactionMode
  includeFullPayloads: boolean
}

interface SinkFailureEmitContext {
  eventBus?: DzupEventBus
  agentId: string
  runId?: string
  redactionMode: AuditRedactionMode
}

function resolveAuditRedactionPolicy(params: ExecuteGenerateRunParams): ResolvedAuditRedactionPolicy {
  return {
    mode: params.config.auditRedaction?.mode ?? DEFAULT_AUDIT_REDACTION_MODE,
    includeFullPayloads: params.config.auditRedaction?.includeFullPayloads ?? true,
  }
}

function redactAuditText(
  text: string,
  mode: AuditRedactionMode,
): { text: string; redacted: boolean } {
  if (mode === 'off') return { text, redacted: false }
  const withSecretsRedacted = redactSecrets(text)
  if (mode === 'secrets') {
    return {
      text: withSecretsRedacted,
      redacted: withSecretsRedacted !== text,
    }
  }
  const withPiiAndSecretsRedacted = redactPII(withSecretsRedacted)
  return {
    text: withPiiAndSecretsRedacted,
    redacted: withPiiAndSecretsRedacted !== text,
  }
}

/**
 * Push an LLM-call audit entry to the configured sink. Fire-and-forget:
 * synchronous throws and rejected promises are swallowed so the run
 * never fails because of an audit-sink defect.
 */
export async function recordAuditEntry(
  sink: LlmCallAuditSink,
  entry: LlmCallAuditEntry,
  context: SinkFailureEmitContext,
): Promise<void> {
  try {
    await sink.record(entry)
  } catch (err) {
    // Audit sink failures must never disturb the run. Compliance reports
    // surface missing entries via downstream reconciliation, not here.
    const rawMessage = err instanceof Error ? err.message : String(err)
    const redactedMessage = redactAuditText(rawMessage, context.redactionMode).text
    context.eventBus?.emit({
      type: 'audit:sink_failure',
      sink: 'llm-call-audit',
      agentId: context.agentId,
      ...(context.runId !== undefined ? { runId: context.runId } : {}),
      redactionMode: context.redactionMode,
      message: redactedMessage,
    })
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
  const auditRedactionPolicy = resolveAuditRedactionPolicy(params)
  const sinkFailureContext: SinkFailureEmitContext = {
    eventBus: params.config.eventBus,
    agentId: params.agentId,
    runId: params.options?.runId,
    redactionMode: auditRedactionPolicy.mode,
  }

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
    const redactedPrompt = promptStr === undefined
      ? undefined
      : redactAuditText(promptStr, auditRedactionPolicy.mode).text
    const promptSnippet = redactedPrompt?.slice(0, 500)
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
      const redactedResponse = responseStr === undefined
        ? undefined
        : redactAuditText(responseStr, auditRedactionPolicy.mode).text
      const responseSnippet = redactedResponse?.slice(0, 500)
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
        ...(auditRedactionPolicy.includeFullPayloads && redactedPrompt !== undefined ? { prompt: redactedPrompt } : {}),
        ...(auditRedactionPolicy.includeFullPayloads && redactedResponse !== undefined ? { response: redactedResponse } : {}),
        ...(promptSnippet !== undefined ? { promptSnippet } : {}),
        ...(responseSnippet !== undefined ? { responseSnippet } : {}),
      }, sinkFailureContext)
      return response
    } catch (err) {
      const rawErrorMessage = err instanceof Error ? err.message : String(err)
      const errorMessage = redactAuditText(rawErrorMessage, auditRedactionPolicy.mode).text
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
        ...(auditRedactionPolicy.includeFullPayloads && redactedPrompt !== undefined ? { prompt: redactedPrompt } : {}),
        ...(promptSnippet !== undefined ? { promptSnippet } : {}),
      }, sinkFailureContext)
      throw err
    }
  }
}
