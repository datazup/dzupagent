/**
 * Policy conformance projection for {@link AdapterRegistryRouter} attempts.
 *
 * Owns the "shape the per-attempt input" concern that is orthogonal to routing
 * and to circuit-breaker bookkeeping: resolving the active policy + conformance
 * mode (including the legacy options-transport compatibility path), running the
 * policy conformance check, projecting the compiled policy into the adapter
 * input, and building/emitting the associated conformance + legacy-option
 * deprecation events.
 *
 * These are free functions parameterised by the router's collaborators
 * (conformance checker, event emitter) so `registry-router.ts` retains only the
 * routing/selection + attempt-loop orchestration.
 */

import { ForgeError } from "@dzupagent/core/advanced";

import type {
  AdapterProviderId,
  AgentInput,
  AgentStreamEvent,
} from "../types.js";
import type { AdapterPolicy } from "../policy/policy-compiler.js";
import { compilePolicyForProvider } from "../policy/policy-compiler.js";
import {
  PolicyConformanceChecker,
  type PolicyViolation,
} from "../policy/policy-conformance.js";
import {
  POLICY_ACTIVE_OPTION_KEY,
  POLICY_CONFORMANCE_MODE_OPTION_KEY,
  POLICY_GUARDRAILS_OPTION_KEY,
  type PolicyConformanceMode,
} from "../pipeline/policy-context-transport.js";
import type { RouterEventEmitter } from "./circuit-breaker-state.js";

export type LegacyPolicyTransportResolution<T> = {
  value: T;
  usedLegacyOptionKey: boolean;
  legacyOptionKey?:
    | typeof POLICY_ACTIVE_OPTION_KEY
    | typeof POLICY_CONFORMANCE_MODE_OPTION_KEY;
};

const LEGACY_POLICY_CONTEXT_STRICT_ENV = "DZUP_STRICT_POLICY_CONTEXT";

export type BuiltAttemptInput = {
  attemptInput: AgentInput;
  warningEvents: Array<Extract<AgentStreamEvent, { type: "adapter:progress" }>>;
  legacyOptionWarningEvents: Array<
    Extract<AgentStreamEvent, { type: "adapter:progress" }>
  >;
  conformanceMode: PolicyConformanceMode;
  conformanceViolations: PolicyViolation[];
};

export function buildAttemptInput(
  checker: PolicyConformanceChecker,
  emit: RouterEventEmitter,
  baseInput: AgentInput,
  providerId: AdapterProviderId,
  signal: AbortSignal,
  attemptIdx: number,
  totalAttempts: number,
  emittedLegacyOptionWarnings: Set<
    typeof POLICY_ACTIVE_OPTION_KEY | typeof POLICY_CONFORMANCE_MODE_OPTION_KEY
  >
): BuiltAttemptInput {
  const policyResolution = readActivePolicy(baseInput);
  const conformanceModeResolution = readConformanceMode(baseInput);
  const policy = policyResolution.value;
  const conformanceMode = conformanceModeResolution.value;
  const legacyOptionWarningEvents = buildLegacyOptionWarningEvents(
    emit,
    providerId,
    attemptIdx,
    totalAttempts,
    baseInput.correlationId,
    emittedLegacyOptionWarnings,
    [policyResolution, conformanceModeResolution]
  );
  if (!policy) {
    return {
      attemptInput: { ...baseInput, signal },
      warningEvents: [],
      legacyOptionWarningEvents,
      conformanceMode,
      conformanceViolations: [],
    };
  }

  const compiled = compilePolicyForProvider(providerId, policy);
  const result = checker.check(providerId, policy, compiled);
  const blockingViolations =
    conformanceMode === "strict"
      ? result.violations
      : result.violations.filter((v) => v.severity === "error");
  const nonBlockingViolations = result.violations.filter(
    (v) => !blockingViolations.includes(v)
  );

  if (blockingViolations.length > 0) {
    emitConformanceViolationEvents(
      emit,
      providerId,
      conformanceMode,
      blockingViolations,
      baseInput.correlationId,
      "blocked_attempt"
    );
    throw createPolicyConformanceError(
      providerId,
      blockingViolations,
      conformanceMode
    );
  }

  const options = { ...(baseInput.options ?? {}) };
  delete options["sandboxMode"];
  delete options["approvalPolicy"];
  delete options["permissionMode"];
  delete options["networkAccessEnabled"];
  delete options["maxBudgetUsd"];
  delete options["maxTurns"];
  delete options[POLICY_ACTIVE_OPTION_KEY];
  delete options[POLICY_CONFORMANCE_MODE_OPTION_KEY];
  delete options[POLICY_GUARDRAILS_OPTION_KEY];

  const guardrailOverlay =
    compiled.guardrails.maxIterations !== undefined ||
    compiled.guardrails.maxCostCents !== undefined ||
    (compiled.guardrails.blockedTools?.length ?? 0) > 0;

  return {
    attemptInput: {
      ...baseInput,
      signal,
      // Attempt execution should not surface orchestration metadata to adapters.
      policyContext: undefined,
      options: {
        ...options,
        ...compiled.config,
        ...compiled.inputOptions,
        ...(guardrailOverlay
          ? { [POLICY_GUARDRAILS_OPTION_KEY]: { ...compiled.guardrails } }
          : {}),
      },
      maxTurns: baseInput.maxTurns ?? compiled.guardrails.maxIterations,
    },
    warningEvents: buildWarnOnlyConformanceEvents(
      providerId,
      conformanceMode,
      nonBlockingViolations,
      attemptIdx,
      totalAttempts,
      baseInput.correlationId
    ),
    legacyOptionWarningEvents,
    conformanceMode,
    conformanceViolations: nonBlockingViolations,
  };
}

export function readActivePolicy(
  input: AgentInput
): LegacyPolicyTransportResolution<AdapterPolicy | undefined> {
  const typed = input.policyContext?.activePolicy;
  if (typed && typeof typed === "object") {
    return { value: typed as AdapterPolicy, usedLegacyOptionKey: false };
  }

  // Legacy compatibility path for callers that still write policy metadata into options.
  const raw = input.options?.[POLICY_ACTIVE_OPTION_KEY];
  if (!raw || typeof raw !== "object") {
    return { value: undefined, usedLegacyOptionKey: false };
  }
  return {
    value: raw as AdapterPolicy,
    usedLegacyOptionKey: true,
    legacyOptionKey: POLICY_ACTIVE_OPTION_KEY,
  };
}

export function readConformanceMode(
  input: AgentInput
): LegacyPolicyTransportResolution<PolicyConformanceMode> {
  const typed = input.policyContext?.conformanceMode;
  if (typed === "warn-only" || typed === "strict") {
    return { value: typed, usedLegacyOptionKey: false };
  }

  // Legacy compatibility path for callers that still write policy metadata into options.
  const raw = input.options?.[POLICY_CONFORMANCE_MODE_OPTION_KEY];
  if (raw === "warn-only" || raw === "strict") {
    return {
      value: raw,
      usedLegacyOptionKey: true,
      legacyOptionKey: POLICY_CONFORMANCE_MODE_OPTION_KEY,
    };
  }
  return { value: "strict", usedLegacyOptionKey: false };
}

export function buildLegacyOptionWarningEvents(
  emit: RouterEventEmitter,
  providerId: AdapterProviderId,
  attemptIdx: number,
  totalAttempts: number,
  correlationId: string | undefined,
  emittedLegacyOptionWarnings: Set<
    typeof POLICY_ACTIVE_OPTION_KEY | typeof POLICY_CONFORMANCE_MODE_OPTION_KEY
  >,
  resolutions: Array<LegacyPolicyTransportResolution<unknown>>
): Array<Extract<AgentStreamEvent, { type: "adapter:progress" }>> {
  const events: Array<Extract<AgentStreamEvent, { type: "adapter:progress" }>> =
    [];
  const legacyOptionKeysUsed: Array<
    typeof POLICY_ACTIVE_OPTION_KEY | typeof POLICY_CONFORMANCE_MODE_OPTION_KEY
  > = [];
  for (const resolution of resolutions) {
    if (!resolution.usedLegacyOptionKey || !resolution.legacyOptionKey)
      continue;
    legacyOptionKeysUsed.push(resolution.legacyOptionKey);
    if (emittedLegacyOptionWarnings.has(resolution.legacyOptionKey)) continue;
    emittedLegacyOptionWarnings.add(resolution.legacyOptionKey);
    events.push({
      type: "adapter:progress",
      providerId,
      timestamp: Date.now(),
      phase: "policy:legacy_option_deprecated",
      message: `Deprecated policy option key '${resolution.legacyOptionKey}' was consumed; use policyContext transport instead`,
      current: attemptIdx + 1,
      total: totalAttempts,
      details: {
        kind: "policy_legacy_option_deprecated",
        optionKey: resolution.legacyOptionKey,
        replacement: "policyContext",
      },
      ...(correlationId ? { correlationId } : {}),
    });
    emit({
      type: "policy:legacy_option_deprecated",
      providerId,
      optionKey: resolution.legacyOptionKey,
      replacement: "policyContext",
      ...(correlationId ? { correlationId } : {}),
    });
  }

  if (
    legacyOptionKeysUsed.length > 0 &&
    process.env[LEGACY_POLICY_CONTEXT_STRICT_ENV] === "1"
  ) {
    const consumedKeys = Array.from(new Set(legacyOptionKeysUsed)).sort();
    throw new ForgeError({
      code: "ADAPTER_EXECUTION_FAILED",
      message: `Legacy policy option keys are disallowed in strict migration mode: ${consumedKeys.join(
        ", "
      )}`,
      recoverable: false,
      context: {
        source: "AdapterRegistryRouter.buildLegacyOptionWarningEvents",
        providerId,
        strictEnv: LEGACY_POLICY_CONTEXT_STRICT_ENV,
        consumedKeys,
      },
    });
  }
  return events;
}

export function buildWarnOnlyConformanceEvents(
  providerId: AdapterProviderId,
  conformanceMode: PolicyConformanceMode,
  violations: PolicyViolation[],
  attemptIdx: number,
  totalAttempts: number,
  correlationId: string | undefined
): Array<Extract<AgentStreamEvent, { type: "adapter:progress" }>> {
  if (conformanceMode !== "warn-only" || violations.length === 0) return [];

  return violations.map((violation) => ({
    type: "adapter:progress",
    providerId,
    timestamp: Date.now(),
    phase: "policy:conformance_warning",
    message: `Policy warning on ${providerId}: ${violation.field} (${violation.reason})`,
    current: attemptIdx + 1,
    total: totalAttempts,
    details: {
      kind: "policy_conformance_violation",
      providerId,
      field: violation.field,
      reason: violation.reason,
      severity: violation.severity,
      conformanceMode,
      fallbackBehavior:
        attemptIdx === 0
          ? "continue_primary_attempt"
          : "continue_fallback_attempt",
    },
    ...(correlationId ? { correlationId } : {}),
  }));
}

export function emitWarnOnlyConformanceViolations(
  emit: RouterEventEmitter,
  providerId: AdapterProviderId,
  conformanceMode: PolicyConformanceMode,
  violations: PolicyViolation[],
  attemptIdx: number,
  correlationId: string | undefined
): void {
  if (conformanceMode !== "warn-only" || violations.length === 0) return;

  emitConformanceViolationEvents(
    emit,
    providerId,
    conformanceMode,
    violations,
    correlationId,
    attemptIdx === 0 ? "continue_primary_attempt" : "continue_fallback_attempt"
  );
}

export function emitConformanceViolationEvents(
  emit: RouterEventEmitter,
  providerId: AdapterProviderId,
  conformanceMode: PolicyConformanceMode,
  violations: PolicyViolation[],
  correlationId: string | undefined,
  fallbackBehavior:
    | "continue_primary_attempt"
    | "continue_fallback_attempt"
    | "blocked_attempt"
): void {
  for (const violation of violations) {
    emit({
      type: "policy:conformance_violation",
      providerId,
      field: violation.field,
      reason: violation.reason,
      severity: violation.severity,
      conformanceMode,
      fallbackBehavior,
      ...(correlationId ? { correlationId } : {}),
    });
  }
}

export function createPolicyConformanceError(
  providerId: AdapterProviderId,
  violations: PolicyViolation[],
  conformanceMode: PolicyConformanceMode
): ForgeError {
  const details = violations
    .map((v) => `  - ${v.field}: ${v.reason}`)
    .join("\n");
  return new ForgeError({
    code: "ADAPTER_EXECUTION_FAILED",
    message: `Policy conformance check failed for provider '${providerId}':\n${details}`,
    recoverable: false,
    context: {
      source: "AdapterRegistryRouter.buildAttemptInput",
      providerId,
      conformanceMode,
      violationCount: violations.length,
    },
  });
}
