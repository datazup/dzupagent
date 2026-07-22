import type {
  AuditRedactionPolicy,
  GuardrailConfig,
  LlmCallAuditSink,
  ProviderFailoverPolicy,
  ToolExecutionConfig,
} from "@dzupagent/agent/runtime";
import type { RunExecutor } from "../run-worker.js";
import type {
  CustomToolResolver,
  ConnectorTokenProfile,
  GitWorkspaceProfile,
  HttpConnectorProfile,
  ToolResolverOptions,
} from "../tool-resolver.js";
import type { TokenLifecycleLike } from "../../routes/run-context.js";

export interface DzupAgentRunExecutorOptions {
  fallback?: RunExecutor;
  toolResolver?: CustomToolResolver;
  /** 'strict' throws if any tools remain unresolved; 'lenient' warns (default). */
  resolvePolicy?: ToolResolverOptions["resolvePolicy"];
  /** Optional registry to register the per-run TokenLifecycleManager into. */
  tokenLifecycleRegistry?: Map<string, TokenLifecycleLike>;
  /** Server-owned HTTP connector profiles keyed by profile name. */
  httpConnectorProfiles?: Record<string, HttpConnectorProfile>;
  /** Default HTTP connector profile name. */
  defaultHttpConnectorProfile?: string;
  /** Server-owned GitHub connector token profiles keyed by profile name. */
  githubConnectorProfiles?: Record<string, ConnectorTokenProfile>;
  /** Default GitHub connector profile name. */
  defaultGithubConnectorProfile?: string;
  /** Server-owned Slack connector token profiles keyed by profile name. */
  slackConnectorProfiles?: Record<string, ConnectorTokenProfile>;
  /** Default Slack connector profile name. */
  defaultSlackConnectorProfile?: string;
  /** Server-owned Git workspace profiles keyed by profile name. */
  gitWorkspaceProfiles?: Record<string, GitWorkspaceProfile>;
  /** Default Git workspace profile name. */
  defaultGitWorkspaceProfile?: string;
  /** Unsafe legacy compatibility for metadata.httpBaseUrl/httpHeaders. */
  allowUnsafeMetadataHttpConnector?: boolean;
  /** Unsafe legacy compatibility for metadata.cwd, root-contained by selected workspace. */
  allowUnsafeMetadataGitCwd?: boolean;
  /** Model context window size (tokens). Default: 200_000 */
  contextWindowTokens?: number;
  /** Reserved output tokens. Default: 4_096 */
  reservedOutputTokens?: number;
  /**
   * AGENT-H-01: Safety guardrails forwarded into DzupAgent on every run.
   * Enables input/output filtering and policy enforcement at the framework level.
   */
  guardrails?: GuardrailConfig;
  /**
   * AGENT-H-01: LLM-call audit sink forwarded into DzupAgent on every run.
   * Records every model invocation for compliance traceability (RF-12).
   */
  auditStore?: LlmCallAuditSink;
  /**
   * AGENT-H-01: Redaction policy for audit entries. Defaults to secrets-and-pii
   * when auditStore is set.
   */
  auditRedaction?: AuditRedactionPolicy;
  /**
   * AGENT-H-01: Tool execution configuration (per-tool timeouts, retries, argument
   * validation). Forwarded into DzupAgent to enforce server-side tool governance.
   */
  toolExecution?: ToolExecutionConfig;
  /**
   * AGENT-H-01: Provider failover policy forwarded into DzupAgent. Enables
   * cross-provider retry/fallback on model API failures.
   */
  providerFailover?: ProviderFailoverPolicy;
  /**
   * AGENT-H-01: Memory scope keys forwarded into DzupAgent. Typically carries
   * tenantId so memory isolation is enforced at the framework level in addition
   * to the server-side tenant stamp on events.
   */
  memoryScope?: Record<string, string>;
}
