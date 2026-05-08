/**
 * _shared-handles.ts — Narrowing helpers that cast `ResolvedTool.handle` by
 * `kind` discriminant.
 *
 * `ResolvedTool.handle` is typed `unknown` in flow-ast per ADR §5.3 (the AST
 * package must not depend on runtime handle shapes). These helpers verify
 * the `kind` discriminant, then perform the single sanctioned cast into the
 * properly-typed handle interface exported by `@dzupagent/core`.
 *
 * @module lower/_shared-handles
 */

import type { ResolvedTool } from '@dzupagent/flow-ast'
import type {
  AgentHandle,
  McpToolHandle,
  SkillHandle,
  WorkflowHandle,
} from '@dzupagent/core/advanced'

export function asSkillHandle(rt: ResolvedTool): SkillHandle {
  if (rt.kind !== 'skill') {
    throw new Error(
      `asSkillHandle: expected kind 'skill', got '${rt.kind}' for ref '${rt.ref}'`,
    )
  }
  return rt.handle as SkillHandle
}

export function asMcpToolHandle(rt: ResolvedTool): McpToolHandle {
  if (rt.kind !== 'mcp-tool') {
    throw new Error(
      `asMcpToolHandle: expected kind 'mcp-tool', got '${rt.kind}' for ref '${rt.ref}'`,
    )
  }
  return rt.handle as McpToolHandle
}

export function asWorkflowHandle(rt: ResolvedTool): WorkflowHandle {
  if (rt.kind !== 'workflow') {
    throw new Error(
      `asWorkflowHandle: expected kind 'workflow', got '${rt.kind}' for ref '${rt.ref}'`,
    )
  }
  return rt.handle as WorkflowHandle
}

export function asAgentHandle(rt: ResolvedTool): AgentHandle {
  if (rt.kind !== 'agent') {
    throw new Error(
      `asAgentHandle: expected kind 'agent', got '${rt.kind}' for ref '${rt.ref}'`,
    )
  }
  return rt.handle as AgentHandle
}
