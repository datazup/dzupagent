/**
 * DzupAgent tool / memory-run resolvers — extracted from `dzip-agent.ts` to
 * keep the composition-root class under the file-line budget
 * (DZUPAGENT-ARCH-M-06).
 *
 * Pure functions over explicit arguments; no `this` capture, so behaviour is
 * identical to the previous private-method implementations.
 */
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { PermissionTier } from "@dzupagent/core/tools";
import type { DzupAgentConfig, GenerateOptions } from "./agent-types.js";
import type { AgentMiddlewareRuntime } from "./middleware-runtime.js";
import { filterToolsByTier } from "../tools/tool-tier-registry.js";

/** Inputs for {@link resolveAvailableTools} / {@link getTools}. */
export interface ToolResolutionInput {
  config: DzupAgentConfig;
  middlewareRuntime: AgentMiddlewareRuntime;
  mailboxTools: StructuredToolInterface[];
  permissionTier: PermissionTier;
}

/**
 * Resolve config + mailbox tools through the middleware runtime (which may
 * add dynamically-resolved tools). Extracted from
 * `DzupAgent#resolveAvailableTools`.
 */
export function resolveAvailableTools(
  input: ToolResolutionInput
): StructuredToolInterface[] {
  const configTools = input.config.tools ?? [];
  return input.middlewareRuntime.resolveTools([
    ...configTools,
    ...input.mailboxTools,
  ]);
}

/**
 * Apply the permission-tier filter to the resolved tool set on every read so
 * middleware-resolved tools (added dynamically) are also gated (MC-AGT-05).
 * Extracted from `DzupAgent#getTools`.
 */
export function getTools(
  input: ToolResolutionInput
): StructuredToolInterface[] {
  return filterToolsByTier(resolveAvailableTools(input), input.permissionTier);
}

/**
 * Resolve the effective memory run id for a call. Extracted from
 * `DzupAgent#resolveMemoryRunId`.
 */
export function resolveMemoryRunId(
  config: DzupAgentConfig,
  options?: GenerateOptions
): string | undefined {
  return options?.runId ?? config.toolExecution?.runId;
}

/**
 * Resolve the optional memory read context (`{ runId }`) for a call.
 * Extracted from `DzupAgent#resolveMemoryReadContext`.
 */
export function resolveMemoryReadContext(
  config: DzupAgentConfig,
  options?: GenerateOptions
): { runId: string } | undefined {
  const runId = resolveMemoryRunId(config, options);
  return runId ? { runId } : undefined;
}
