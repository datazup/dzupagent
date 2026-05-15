/**
 * Shared policy metadata transport keys/types used across prepare and runtime
 * projection paths. Kept isolated to avoid pipeline<->registry import cycles.
 */

export type PolicyConformanceMode = 'strict' | 'warn-only'
export const POLICY_GUARDRAILS_OPTION_KEY = '__policyGuardrails'
export const POLICY_ACTIVE_OPTION_KEY = '__activePolicy'
export const POLICY_CONFORMANCE_MODE_OPTION_KEY = '__policyConformanceMode'

