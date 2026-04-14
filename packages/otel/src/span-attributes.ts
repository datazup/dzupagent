/**
 * Semantic attribute keys for DzupAgent spans.
 *
 * Follows OpenTelemetry GenAI semantic conventions where applicable,
 * extends with `forge.*` namespace for agent-specific attributes.
 *
 * @example
 * ```ts
 * span.setAttribute(ForgeSpanAttr.AGENT_ID, 'code-gen-agent')
 * span.setAttribute(ForgeSpanAttr.GEN_AI_REQUEST_MODEL, 'claude-sonnet-4-6')
 * ```
 */
export const ForgeSpanAttr = {
  // --- Agent identity ---
  AGENT_ID: 'forge.agent.id',
  AGENT_NAME: 'forge.agent.name',
  RUN_ID: 'forge.run.id',
  PHASE: 'forge.pipeline.phase',
  TENANT_ID: 'forge.tenant.id',

  // --- Tool attributes ---
  TOOL_NAME: 'forge.tool.name',
  TOOL_DURATION_MS: 'forge.tool.duration_ms',
  TOOL_INPUT_SIZE: 'forge.tool.input_size_bytes',
  TOOL_OUTPUT_SIZE: 'forge.tool.output_size_bytes',

  // --- Memory attributes ---
  MEMORY_NAMESPACE: 'forge.memory.namespace',
  MEMORY_OPERATION: 'forge.memory.operation',
  MEMORY_RESULT_COUNT: 'forge.memory.result_count',

  // --- Cost attributes ---
  COST_CENTS: 'forge.cost.cents',
  TOKEN_COUNT: 'forge.tokens.total',

  // --- Budget attributes ---
  BUDGET_TOKENS_USED: 'forge.budget.tokens_used',
  BUDGET_TOKENS_LIMIT: 'forge.budget.tokens_limit',
  BUDGET_COST_USED: 'forge.budget.cost_used_cents',
  BUDGET_COST_LIMIT: 'forge.budget.cost_limit_cents',
  BUDGET_ITERATIONS: 'forge.budget.iterations',
  BUDGET_ITERATIONS_LIMIT: 'forge.budget.iterations_limit',

  // --- Error attributes ---
  ERROR_CODE: 'forge.error.code',
  ERROR_RECOVERABLE: 'forge.error.recoverable',

  // --- GenAI semantic conventions (OTel standard) ---
  GEN_AI_SYSTEM: 'gen_ai.system',
  GEN_AI_REQUEST_MODEL: 'gen_ai.request.model',
  GEN_AI_RESPONSE_MODEL: 'gen_ai.response.model',
  GEN_AI_REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
  GEN_AI_REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  GEN_AI_USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  GEN_AI_USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  GEN_AI_USAGE_TOTAL_TOKENS: 'gen_ai.usage.total_tokens',
} as const

/** Union type of all ForgeSpanAttr values */
export type ForgeSpanAttrKey = typeof ForgeSpanAttr[keyof typeof ForgeSpanAttr]
