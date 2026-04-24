/**
 * Tool permission scoping types.
 *
 * Defines the pluggable permission contract evaluated by the agent tool
 * loop before invoking a tool. When a `ToolPermissionPolicy` is supplied,
 * every tool call is checked via {@link ToolPermissionPolicy.hasPermission}
 * with the calling agent's id. Denied calls short-circuit the invocation
 * and surface as a `TOOL_PERMISSION_DENIED` `ForgeError`.
 *
 * The policy is intentionally data-only here (Layer 0) so higher layers
 * can implement it without dragging runtime dependencies into
 * `@dzupagent/agent-types`. The default ownership-based implementation
 * lives alongside `DynamicToolRegistry` in `@dzupagent/agent`.
 */

/**
 * Scope of a registered tool.
 *
 * - `'private'` — only the `ownerId` agent may invoke the tool.
 * - `'shared'`  — any agent may invoke the tool.
 * - `'borrowed'` — the tool was lent to a sub-agent (e.g. via the
 *   supervisor pattern). Borrowed tools are invokable by the borrower but
 *   cannot be re-delegated onward — preventing "tool laundering" where a
 *   specialist hands tools to another specialist outside the original
 *   grant.
 */
export type ToolScope = 'private' | 'shared' | 'borrowed'

/**
 * Metadata tracked for each tool in a permission-aware registry.
 */
export interface ToolPermissionEntry {
  /** Tool name (LangChain StructuredTool.name). */
  name: string
  /** Agent id that owns this tool, if any. */
  ownerId?: string
  /** Tool scope. Defaults to `'private'` when an `ownerId` is present. */
  scope: ToolScope
}

/**
 * Pluggable policy for deciding whether `callerAgentId` is allowed to
 * invoke a given tool.
 *
 * Implementations should be fast (the check runs per tool call) and
 * side-effect free. Return `true` to allow the invocation, `false` to
 * reject it. When rejected the tool loop throws a `ForgeError` with code
 * `TOOL_PERMISSION_DENIED` so the error flows through the usual error
 * handling and audit surfaces.
 *
 * When the policy is `undefined` on the agent/tool-loop config, no
 * permission check runs — keeping the surface backward compatible.
 */
export interface ToolPermissionPolicy {
  /**
   * @param callerAgentId - The id of the agent requesting the invocation.
   * @param toolName      - The tool the caller wants to invoke.
   * @returns true if the caller is permitted to invoke the tool.
   */
  hasPermission(callerAgentId: string, toolName: string): boolean
}
