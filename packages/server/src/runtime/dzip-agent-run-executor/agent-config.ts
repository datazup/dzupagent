import type {
  AuditRedactionPolicy,
  GuardrailConfig,
  LlmCallAuditSink,
  ProviderFailoverPolicy,
  ToolExecutionConfig,
} from "@dzupagent/agent/runtime";
import type { DzupAgentRunExecutorOptions } from "./options.js";

/**
 * AGENT-H-01 policy/observability surfaces forwarded into `DzupAgent` on every
 * server-dispatched run. Each field is only present when the corresponding
 * executor option is defined, so the framework's own defaults are preserved.
 */
export interface AgentPolicyConfig {
  guardrails?: GuardrailConfig;
  auditStore?: LlmCallAuditSink;
  auditRedaction?: AuditRedactionPolicy;
  toolExecution?: ToolExecutionConfig;
  providerFailover?: ProviderFailoverPolicy;
  memoryScope?: Record<string, string>;
}

/**
 * Resolves the memory scope forwarded into DzupAgent. An explicit
 * `options.memoryScope` wins; otherwise the run's tenantId (when present) is
 * used so memory isolation is enforced at the framework level in addition to
 * the server-side tenant stamp on events.
 */
export function resolveMemoryScope(
  options: DzupAgentRunExecutorOptions | undefined,
  tenantId: string | undefined
): Record<string, string> | undefined {
  if (options?.memoryScope !== undefined) return options.memoryScope;
  if (tenantId !== undefined) return { tenantId };
  return undefined;
}

/**
 * Builds the AGENT-H-01 policy slice spread into the `DzupAgent` constructor
 * config. Fields are omitted (not set to `undefined`) when unconfigured so the
 * constructor sees exactly the keys it did when this was inlined.
 */
export function buildAgentPolicyConfig(
  options: DzupAgentRunExecutorOptions | undefined,
  memoryScope: Record<string, string> | undefined
): AgentPolicyConfig {
  return {
    ...(options?.guardrails !== undefined
      ? { guardrails: options.guardrails }
      : {}),
    ...(options?.auditStore !== undefined
      ? { auditStore: options.auditStore }
      : {}),
    ...(options?.auditRedaction !== undefined
      ? { auditRedaction: options.auditRedaction }
      : {}),
    ...(options?.toolExecution !== undefined
      ? { toolExecution: options.toolExecution }
      : {}),
    ...(options?.providerFailover !== undefined
      ? { providerFailover: options.providerFailover }
      : {}),
    ...(memoryScope !== undefined ? { memoryScope } : {}),
  };
}
