import type { AdapterProviderId } from "./provider.js";

/** Task descriptor used by the router to decide which adapter to use */
export interface TaskDescriptor {
  prompt: string;
  tags: string[];
  budgetConstraint?: "low" | "medium" | "high" | "unlimited" | undefined;
  preferredProvider?: AdapterProviderId | undefined;
  requiresExecution?: boolean | undefined;
  requiresReasoning?: boolean | undefined;
  workingDirectory?: string | undefined;
  /**
   * Skill IDs this task expects to invoke. Routers that consult per-skill
   * health metrics will use this to bias provider selection toward providers
   * with strong historical performance for these skills.
   */
  skillIds?: string[] | undefined;
  /**
   * System prompt that will be sent alongside the task prompt.
   * When present, routers must include its token count in the context
   * budget used for provider/model selection — omitting it causes
   * under-estimation and can result in context overflow at runtime.
   */
  systemPrompt?: string | undefined;
  /**
   * Pre-computed input token count (prompt + systemPrompt + any injections).
   * When provided, routers use this directly instead of re-estimating from
   * prompt text — useful when the caller has already run a precise tokenizer.
   */
  estimatedInputTokens?: number | undefined;
}

/** Decision made by the task router */
export interface RoutingDecision {
  provider: AdapterProviderId | "auto";
  reason: string;
  fallbackProviders?: AdapterProviderId[] | undefined;
  confidence: number;
}

/** Pluggable strategy for routing tasks to adapters */
export interface TaskRoutingStrategy {
  readonly name: string;
  route(
    task: TaskDescriptor,
    availableProviders: AdapterProviderId[]
  ): RoutingDecision;
}
