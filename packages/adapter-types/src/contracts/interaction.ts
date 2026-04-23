// ---------------------------------------------------------------------------
// Interaction Policy — mid-execution question/permission handling
// ---------------------------------------------------------------------------

/**
 * How the adapter should handle mid-execution questions, clarification
 * requests, and permission prompts from a sub-agent.
 */
export type InteractionPolicyMode =
  | 'auto-approve'    // always answer yes/grant (backward-compatible default)
  | 'auto-deny'       // always answer no/deny (safe for untrusted runs)
  | 'default-answers' // match question text against a regex → answer map
  | 'ai-autonomous'   // use a secondary LLM call to decide
  | 'ask-caller'      // emit adapter:interaction_required and wait for caller

export interface InteractionPolicy {
  mode: InteractionPolicyMode
  /** Used when mode === 'default-answers' */
  defaultAnswers?: {
    /** Each pattern string is compiled to RegExp and tested against the question text. */
    patterns: Array<{ pattern: string; answer: string }>
  } | undefined
  /** Used when mode === 'ai-autonomous' */
  aiAutonomous?: {
    /** Context injected into the LLM reasoning prompt (e.g. task constraints). */
    context?: string | undefined
    /** Model hint for the secondary LLM call. Adapters may ignore this. */
    model?: string | undefined
  } | undefined
  /** Used when mode === 'ask-caller' */
  askCaller?: {
    /** Timeout in ms to wait for caller response. Default: 60_000. */
    timeoutMs?: number | undefined
    /** Policy applied on timeout. Default: 'auto-deny'. */
    timeoutFallback?: 'auto-approve' | 'auto-deny' | undefined
  } | undefined
}
