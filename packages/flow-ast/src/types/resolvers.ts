/**
 * Resolves opaque tool/skill/workflow references emitted by flow-ast
 * into concrete, callable metadata during flow-compiler Stage 3
 * (semantic validation).
 *
 * Implementations typically wrap SkillRegistry + WorkflowRegistry +
 * MCPClient + any AgentRegistry facade. Resolution must be synchronous
 * from the compiler's perspective — if async lookup is required, it
 * should be pre-warmed before compile() is invoked.
 */
export interface ToolResolver {
  /**
   * Look up a reference by name. Returns `null` (not throws) for unknown
   * references so the compiler can aggregate all unresolved refs into a
   * single validation error report instead of failing on the first miss.
   */
  resolve(ref: string): ResolvedTool | null;

  /**
   * Enumerate every ref the resolver currently knows about. Used by the
   * compiler to produce "did you mean …?" diagnostics and by tooling
   * (LSP / pretty-printer) to offer completions.
   */
  listAvailable(): string[];
}

/**
 * Async variant of {@link ToolResolver} for registries whose lookup
 * cannot be pre-warmed: remote agent registries, lazy MCP bootstrap,
 * database-backed skill stores.
 *
 * Stage 3 semantic resolution accepts `ToolResolver | AsyncToolResolver`
 * and awaits the result when `resolve()` returns a Promise (duck-typed —
 * no `kind` brand per Wave 11 ADR §3.3). `listAvailable()` remains
 * synchronous — resolvers that cannot enumerate synchronously must cache
 * their catalogue internally and refresh it out-of-band (TTL, LISTEN/NOTIFY,
 * etc.). The compiler calls `listAvailable()` only when emitting suggestions
 * and cannot tolerate a per-suggestion network round-trip.
 *
 * Prefer the synchronous {@link ToolResolver} for in-memory fixtures and
 * pre-warmed registries — there is no benefit to paying the await cost.
 */
export interface AsyncToolResolver {
  /**
   * Look up a reference by name. Returns `null` (not throws) for unknown
   * references so the compiler can aggregate every unresolved ref into a
   * single validation report. Rejection is reserved for infrastructure
   * failure (network, DB) — it surfaces as a Stage 3 error with code
   * `RESOLVER_INFRA_ERROR`.
   */
  resolve(ref: string): Promise<ResolvedTool | null>;

  /**
   * Enumerate every ref currently in the resolver's catalogue.
   * MUST be synchronous. See interface-level JSDoc for rationale.
   */
  listAvailable(): string[];
}

export type ResolvedToolKind = "mcp-tool" | "skill" | "workflow" | "agent";

export interface ResolvedTool {
  /** The original opaque ref string as it appeared in the flow source. */
  ref: string;
  /** What the ref actually points at — drives compiler lowering choices. */
  kind: ResolvedToolKind;
  /** JSON-Schema (or Zod-derived schema) describing accepted input. */
  inputSchema: unknown;
  /** Optional JSON-Schema for declared output shape. */
  outputSchema?: unknown;
  /** Opaque, stable handle the runtime uses to invoke the resolved entity. */
  handle: unknown;
  /** Optional generic metadata surfaced by host registries for planning tools. */
  meta?: Record<string, unknown>;
  /** Reviewed classification, credential, effect, output, and evidence policy. */
  securityPolicy?: FlowToolSecurityPolicy;
}

export interface HostToolRegistryEntry {
  ref: string;
  kind: ResolvedToolKind;
  inputSchema: unknown;
  outputSchema?: unknown;
  handle?: unknown;
  aliases?: string[];
  description?: string;
  meta?: Record<string, unknown>;
  /** Reviewed classification, credential, effect, output, and evidence policy. */
  securityPolicy?: FlowToolSecurityPolicy;
}

/**
 * Resolves a compile-time toolset reference (the `toolset: <name>` field on
 * AgentNode) into the concrete list of tool refs the agent is allowed to
 * invoke at runtime.
 *
 * Stage 2 of the Flow DSL pipeline calls this resolver during semantic
 * resolution; the resolved list is merged with any inline `tools[]` on the
 * node and written back as the canonical `tools[]` on the AST. Downstream
 * runtimes (codev-app's `flow-node-executor-agent`) filter the agent's tool
 * surface against this expanded list — toolsets are runtime-enforced, not
 * a zero-impact annotation (Codex amendment 2026-05-18).
 *
 * Returns `null` (not throws) for unknown toolset names so the compiler can
 * aggregate every UNRESOLVED_TOOLSET_REF into a single Stage-3 report. An
 * empty array is a legal result — it just means "no extra tools beyond the
 * inline list".
 */
export interface ToolsetResolver {
  resolve(ref: string): readonly string[] | null;
  /**
   * Enumerate every toolset ref currently known. Used for "did you mean…?"
   * suggestions on UNRESOLVED_TOOLSET_REF.
   */
  listAvailable(): string[];
}

/**
 * Async variant of {@link ToolsetResolver} for catalogues backed by lazy
 * loaders (DB, remote registry). Stage 3 duck-types on the return type of
 * `resolve()`; synchronous resolvers never hit the microtask queue.
 */
export interface AsyncToolsetResolver {
  resolve(ref: string): Promise<readonly string[] | null>;
  listAvailable(): string[];
}

/**
 * Catalogue entry for the helper {@link createToolsetResolverFromCatalog} in
 * `@dzupagent/flow-compiler`. Mirrors the shape consumers already use for
 * host tool registries: each entry declares the canonical name and the
 * expanded tool refs it stands for.
 */
export interface ToolsetCatalogEntry {
  name: string;
  tools: readonly string[];
  description?: string;
}
import type { FlowToolSecurityPolicy } from "./integration-security.js";
