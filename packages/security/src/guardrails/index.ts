/**
 * Composable security guardrails for untrusted content crossing a trust
 * boundary into the model context.
 *
 * @module @dzupagent/security/guardrails
 */
export { PromptInjectionGuard } from "./prompt-injection-guard.js";
export type { GuardOptions, ScreenResult } from "./prompt-injection-guard.js";
export {
  TOOL_RESULT_LABEL,
  fenceToolError,
  fenceToolResult,
} from "./tool-result-fence.js";
export type {
  FenceToolResultOptions,
  ToolResultGuardLike,
} from "./tool-result-fence.js";
