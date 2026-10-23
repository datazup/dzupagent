import type { AdapterProviderId } from '../types.js'
import type { SystemPromptPayload } from '../prompts/system-prompt-builder.js'
import { buildExecutionOfferAssessmentPrompt } from '../prompts/execution-offer-assessment.js'
import { routeExecutionOffers } from './execution-offer-routing.js'
import type { ExecutionOfferAssessmentProposal, ExecutionOfferRoutingRequest, ExecutionOfferRoutingDecision } from './execution-offer-routing.js'

/** Host enforces these limits on the single provider call and reports joined usage. */
export interface ExecutionOfferAssessmentPort {
  assess(input: {
    readonly prompt: SystemPromptPayload
    readonly signal: AbortSignal
    readonly maxTokens: number
    readonly maxCostMicros: number
    readonly maxCalls: 1
  }): Promise<{ readonly output: unknown; readonly usage: { readonly tokens: number; readonly costMicros: number } }>
}
const active = new WeakSet<ExecutionOfferAssessmentPort>()

/** Optional asynchronous layer. Legacy synchronous route() never calls a provider. */
export async function assessExecutionOffers(request: ExecutionOfferRoutingRequest, options: {
  readonly port?: ExecutionOfferAssessmentPort
  readonly provider: AdapterProviderId
  readonly taskContext: string
  readonly maxPromptCharacters: number
  readonly maxTokens: number
  readonly maxCostMicros: number
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}): Promise<{ readonly decision: ExecutionOfferRoutingDecision; readonly assessmentStatus: string; readonly usage?: { readonly tokens: number; readonly costMicros: number } }> {
  // Never assess an already assessed decision: a routing request gets at most one call.
  let baseline = routeExecutionOffers(request)
  if (request.assessment || baseline.action !== 'select' || !options.port) return { decision: baseline, assessmentStatus: 'not-requested' }
  if (![options.maxTokens, options.maxCostMicros, options.timeoutMs, options.maxPromptCharacters].every(v => Number.isSafeInteger(v) && v > 0) ||
      options.maxCostMicros > request.remainingBudgetMicros || options.timeoutMs > 60000 || options.maxTokens > 100000) return { decision: baseline, assessmentStatus: 'invalid-allowance' }
  if (options.signal?.aborted) return { decision: baseline, assessmentStatus: 'cancelled' }
  if (active.has(options.port)) return { decision: baseline, assessmentStatus: 'recursive-assessment-refused' }
  // Reserve the entire assessment ceiling conservatively, including unknown
  // usage on timeout. A new lane name is never a fresh task allowance.
  request = { ...request, remainingBudgetMicros: request.remainingBudgetMicros - options.maxCostMicros }
  baseline = routeExecutionOffers(request)
  if (baseline.action !== 'select') return { decision: baseline, assessmentStatus: 'assessment-budget-unavailable' }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  let usage: { tokens: number; costMicros: number } | undefined
  let dispatched = false, settled = false
  active.add(options.port)
  try {
    const prompt = buildExecutionOfferAssessmentPrompt({ decision: baseline, assessorProvider: options.provider, maxCharacters: options.maxPromptCharacters,
      taskContext: options.taskContext, allowance: { maxTokens: options.maxTokens, maxCostMicros: options.maxCostMicros, timeoutMs: options.timeoutMs } })
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error(options.signal?.aborted ? 'cancelled' : 'timeout')), { once: true })
      timer = setTimeout(abort, options.timeoutMs)
    })
    // Promise.race retains rejection handlers on the late provider result. Its
    // answer can never change this completed decision or dispatch anything.
    dispatched = true
    const pending = Promise.resolve().then(() => options.port!.assess({ prompt, signal: controller.signal,
      maxTokens: options.maxTokens, maxCostMicros: options.maxCostMicros, maxCalls: 1 })).finally(() => {
      settled = true; active.delete(options.port!)
    })
    const result = await Promise.race([pending, cancelled])
    usage = result.usage
    if (!usage || ![usage.tokens, usage.costMicros].every(v => Number.isSafeInteger(v) && v >= 0) || usage.tokens > options.maxTokens || usage.costMicros > options.maxCostMicros) throw new Error('usage-unqualified')
    if (!result.output || typeof result.output !== 'object' || Array.isArray(result.output)) throw new Error('malformed-output')
    const proposal = result.output as ExecutionOfferAssessmentProposal
    const decision = routeExecutionOffers({ ...request, remainingBudgetMicros: request.remainingBudgetMicros,
      assessment: proposal })
    return { decision, assessmentStatus: 'accepted', usage }
  } catch (error) {
    if (options.signal?.aborted) return { decision: routeExecutionOffers({ ...request, assessment: {
      schema: 'dzupagent.executionOfferAssessment/v1', action: 'wait', policyRevision: request.policy.revision,
      inputDigest: baseline.inputDigest, rationale: 'Caller cancelled; retain the source and any outstanding provider reservation.',
    } }), assessmentStatus: 'cancelled', ...(usage ? { usage } : {}) }
    return { decision: baseline, assessmentStatus: error instanceof Error ? error.message : 'unavailable', ...(usage ? { usage } : {}) }
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    controller.abort()
    if (!dispatched || settled) active.delete(options.port)
  }
}
