/**
 * Composable security guardrails for untrusted content crossing a trust
 * boundary into the model context.
 *
 * @module @dzupagent/security/guardrails
 */
export { PromptInjectionGuard } from "./prompt-injection-guard.js";
export type { GuardOptions, ScreenResult } from "./prompt-injection-guard.js";
