/**
 * Prompt-injection guardrail for the adapter execution layer.
 *
 * The composable {@link PromptInjectionGuard} lives in `@dzupagent/security`
 * (a zero-dependency package depended on by both `@dzupagent/agent` and
 * `@dzupagent/agent-adapters`) so the SAME guard instance can wrap untrusted
 * content at every trust boundary without forming a dependency cycle —
 * `agent-adapters` already depends on `agent`, so the guard cannot originate
 * here if the core tool loop is to reuse it.
 *
 * This module re-exports it under the adapter guardrails surface (MC-3) so
 * adapter authors can wrap untrusted cross-provider handoff context, retrieved
 * documents, and tool results with a labelled, delimited quoted-data block:
 *
 *     guard.wrap(untrusted, { label: 'previous_provider' })
 *
 * @module
 */
export {
  PromptInjectionGuard,
  type GuardOptions,
  type ScreenResult,
} from "@dzupagent/security";
