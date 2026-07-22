import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { runBeforeModelCall } from "@dzupagent/core/orchestration";
import type { DzupEventBus } from "@dzupagent/core/events";
import {
  buildModelHookContext,
  resolveModelIdForHooks,
} from "../model-hooks.js";
import { defaultLogger, type FrameworkLogger } from "@dzupagent/core/utils";
import type { GenerateOptions } from "../agent-types.js";
import { IterationBudget } from "../../guardrails/iteration-budget.js";
import { StuckDetector } from "../../guardrails/stuck-detector.js";
import {
  DEFAULT_GUARDED_MAX_ITERATIONS,
  DEFAULT_UNGUARDED_BUDGET,
  _warnedAgentIds,
} from "../run-engine-defaults.js";
import { createToolLoopLearningHook } from "../tool-loop-learning.js";
import { estimateConversationTokensForMessages } from "../message-utils.js";
import { rehydrateMessagesFromJournal } from "../resume-utils.js";
import { omitUndefined } from "../../utils/exact-optional.js";
import {
  injectPromptCacheMarkers,
  injectPromptCacheMarkersForModel,
} from "@dzupagent/context";
import {
  ContentScanner,
  PromptInjectionBlockedError,
  type PromptInjectionMode,
  type PiiMode,
} from "@dzupagent/security";
import { HumanMessage } from "@langchain/core/messages";
import type { PreparedRunState, PrepareRunStateParams } from "./types.js";

/**
 * Bind per-call sampling options (DZUPAGENT-CODE-H-02) onto the resolved model.
 *
 * OpenAI-compat (and any other) callers pass `temperature`, `maxTokens`, and
 * `stop` through {@link GenerateOptions}; historically these were validated then
 * dropped, so generation silently ignored them. We now thread them to the single
 * seam every invocation path (generate, stream, failover) flows through — the
 * bound model built here in `prepareRunState`.
 *
 * Capability-detects `.bind()` (the Runnable API) exactly the way `bindTools`
 * detects `.bindTools`. `.bind()` returns a wrapper that merges these kwargs
 * into the model's invocation params; the run engine only ever calls
 * `.invoke()`/`.stream()` on the result, both of which the wrapper preserves.
 * When no options are set (the common path) this is an identity return. When the
 * resolved model does not expose `.bind()` (e.g. a stub test model), the options
 * are a documented no-op rather than a throw.
 *
 * `stop` is a first-class LangChain call option; `temperature`/`maxTokens` are
 * forwarded as bound kwargs, which the LangChain chat integrations honour when
 * the underlying provider supports them (unsupported providers ignore them).
 */
export function applySamplingOptions(
  model: BaseChatModel,
  options?: GenerateOptions
): BaseChatModel {
  if (!options) return model;
  const bound: Record<string, unknown> = {};
  if (options.temperature !== undefined)
    bound["temperature"] = options.temperature;
  if (options.maxTokens !== undefined) bound["maxTokens"] = options.maxTokens;
  if (options.stop !== undefined) bound["stop"] = options.stop;
  if (Object.keys(bound).length === 0) return model;
  if ("bind" in model && typeof model.bind === "function") {
    return (
      model as BaseChatModel & {
        bind: (kwargs: Record<string, unknown>) => BaseChatModel;
      }
    ).bind(bound) as BaseChatModel;
  }
  return model;
}

export async function prepareRunState(
  params: PrepareRunStateParams
): Promise<PreparedRunState> {
  // RF-04 (SEC-08) — when the caller did not supply ANY guardrails, install a
  // default `IterationBudget` so a runaway loop cannot burn unbounded tokens.
  //
  // DZUPAGENT-AGENT-L-03 fix: an empty `guardrails: {}` object is NOT a
  // get-out-of-jail card for the default token/iteration budget. Only a
  // guardrails object with at least one defined cap field is used verbatim;
  // an empty object falls back to DEFAULT_UNGUARDED_BUDGET just like the
  // absent case. The startup warning is still suppressed for empty objects
  // (the caller explicitly passed guardrails, even if empty) to avoid noise.
  const hasExplicitGuardrails = params.config.guardrails !== undefined;
  // True only when the caller supplied at least one cap field.
  const hasPopulatedGuardrails =
    hasExplicitGuardrails &&
    Object.keys(params.config.guardrails ?? {}).length > 0;
  const logger: FrameworkLogger =
    (params.config as { logger?: FrameworkLogger }).logger ?? defaultLogger;

  const maxIterations =
    params.options?.maxIterations ??
    params.config.guardrails?.maxIterations ??
    params.config.maxIterations ??
    (hasExplicitGuardrails
      ? DEFAULT_GUARDED_MAX_ITERATIONS
      : DEFAULT_UNGUARDED_BUDGET.maxIterations);

  const budget = hasPopulatedGuardrails
    ? new IterationBudget(params.config.guardrails!)
    : new IterationBudget({
        // Combined input + output cap honours `DEFAULT_UNGUARDED_BUDGET.inputTokens`
        // — input spend alone exhausts the budget at parity with the spec; the
        // semantic input/output split is preserved on the constant for callers
        // that introspect it.
        maxTokens: DEFAULT_UNGUARDED_BUDGET.inputTokens,
        maxIterations: DEFAULT_UNGUARDED_BUDGET.maxIterations,
      });

  // Emit a one-shot startup warning per agent id so operators notice the
  // fallback. Repeat `generate()` / `stream()` calls on the same agent stay
  // quiet to avoid log spam.
  if (!hasExplicitGuardrails && !_warnedAgentIds.has(params.config.id)) {
    _warnedAgentIds.add(params.config.id);
    logger.warn(
      "Agent constructed without explicit guardrails — applying default budget. Configure `config.guardrails` for production.",
      {
        agentId: params.config.id,
        defaultBudget: DEFAULT_UNGUARDED_BUDGET,
      }
    );
  }

  const prepared = await params.prepareMessages(params.messages);
  const preparedMessages = prepared.messages;
  const memoryFrame = prepared.memoryFrame;

  // When resuming from a checkpoint, reconstruct message history from the journal
  // so the agent continues from the last committed step rather than re-executing.
  let finalMessages = preparedMessages;
  const resumeSeq = params.options?._resume?.lastStateSeq;
  if (
    resumeSeq !== undefined &&
    params.journal != null &&
    params.runId != null
  ) {
    const allEntries = await params.journal.getAll(params.runId);
    const entriesUpToSeq = allEntries.filter((e) => e.seq <= resumeSeq);
    const startedEntry = allEntries.find((e) => e.type === "run_started");
    const originalInput =
      startedEntry != null
        ? String((startedEntry.data as { input?: unknown }).input ?? "")
        : extractFirstHumanMessage(preparedMessages);
    const rehydrated = rehydrateMessagesFromJournal(
      entriesUpToSeq,
      originalInput
    );
    if (rehydrated.length > 0) {
      finalMessages = rehydrated;
    }
  }

  // OWASP-aligned content scan (audit MC-01 / AG-08 / AG-09).
  //
  // When `config.security.promptInjection` is `'warn'` or `'block'`, every
  // HumanMessage in the prepared transcript is scanned via
  // `@dzupagent/security`. A `'block'` verdict aborts the run with
  // `PromptInjectionBlockedError`; a `'sanitize'` verdict rewrites the
  // matched span(s) before they reach the model.
  finalMessages = await scanHumanMessages(
    finalMessages,
    params.config.security?.promptInjection,
    params.config.security?.pii,
    params.config.eventBus,
    params.config.id,
    params.runId
  );

  // WS3 Task 3.2 — model-lifecycle hooks run BEFORE prompt-cache injection.
  // ORDERING IS LOAD-BEARING: `beforeModelCall` may rewrite the message array,
  // and cache breakpoints must be computed on the FINAL array — injecting
  // markers first would let a hook edit silently invalidate breakpoint
  // placement. Error-isolated in the core dispatcher (a throwing hook is
  // swallowed and the transcript passes through unchanged).
  {
    const resolvedModelId = resolveModelIdForHooks(
      params.config.model,
      params.resolvedModel
    );
    const hookCtx = buildModelHookContext(
      params.config,
      params.config.id,
      params.runId ?? params.options?.runId
    );
    finalMessages = await runBeforeModelCall(
      params.config.hooks?.beforeModelCall
        ? [params.config.hooks.beforeModelCall]
        : undefined,
      params.config.eventBus,
      finalMessages,
      resolvedModelId,
      hookCtx
    );
  }

  // Inject Anthropic prompt-cache markers for Claude models (RF-13 / AG-12 / REC-H-10).
  // No-op for non-Claude model IDs and short prompts — safe for all providers.
  // When `config.model` is a `BaseChatModel` instance (rather than a string id)
  // we still want caching to apply, so derive the id from the resolved model.
  if (typeof params.config.model === "string") {
    finalMessages = injectPromptCacheMarkers(
      finalMessages,
      params.config.model
    );
  } else {
    finalMessages = injectPromptCacheMarkersForModel(
      finalMessages,
      params.resolvedModel
    );
  }

  const tierFilteredTools = params.getTools();
  // REC-M-06 — Apply `toolPermissionPolicy` at tool-issuance time so the
  // model is never told that a forbidden tool is available. Without this gate
  // the policy was only enforced at execution time (inside the tool executor),
  // which meant the model could be prompted with a tool, choose it, and then
  // receive a denial — causing a confusing mid-run failure instead of a clean
  // upfront exclusion.
  //
  // The gate is opt-in: when `toolExecution.permissionPolicy` is absent (the
  // common case), the behaviour is identical to the pre-fix path. When the
  // policy is present and an `agentId` is resolvable, any tool that the policy
  // denies is stripped from the list before the model sees it. The executor's
  // existing pre-flight and issuance-time checks are preserved as a TOCTOU
  // safety net (policy may mutate between issuance and invocation).
  const issuancePolicy = params.config.toolExecution?.permissionPolicy;
  const issuanceAgentId = params.config.id;
  const tools =
    issuancePolicy && issuanceAgentId
      ? tierFilteredTools.filter((tool) =>
          issuancePolicy.hasPermission(issuanceAgentId, tool.name)
        )
      : tierFilteredTools;
  const model = applySamplingOptions(
    params.bindTools(params.resolvedModel, tools),
    params.options
  );

  // Charge the prompt-build phase to the token lifecycle plugin (if any)
  // so per-phase token breakdowns appear in lifecycle reports. This runs
  // AFTER prepareMessages/rehydration so it reflects the final transcript
  // that will be sent to the model.
  if (params.config.tokenLifecyclePlugin) {
    const promptTokens = estimateConversationTokensForMessages(finalMessages);
    params.config.tokenLifecyclePlugin.trackPhase("prompt", promptTokens);
  }

  await params.runBeforeAgentHooks();

  const stuckDetector =
    params.config.guardrails?.stuckDetector === false
      ? undefined
      : new StuckDetector(
          typeof params.config.guardrails?.stuckDetector === "object"
            ? params.config.guardrails.stuckDetector
            : undefined
        );

  const learningHook = createToolLoopLearningHook(params.config.selfLearning);
  if (learningHook) {
    await learningHook.loadSpecialistConfig().catch(() => {
      /* non-fatal */
    });
  }

  return omitUndefined({
    maxIterations,
    budget,
    preparedMessages: finalMessages,
    tools,
    toolMap: new Map(tools.map((tool) => [tool.name, tool])),
    model,
    stuckDetector,
    memoryFrame,
  });
}

/**
 * Scan every HumanMessage in `messages` for prompt-injection / PII content.
 *
 * - On `promptInjection === 'block'`: any finding raises
 *   {@link PromptInjectionBlockedError}.
 * - On `promptInjection === 'warn'`: matched spans are rewritten to
 *   `[REDACTED-INJECTION]` and the message content replaced.
 * - When `pii !== 'off'`, PII findings on incoming user input are also
 *   sanitized inline (the sanitize verdict from the scanner rewrites
 *   SSN/CC/IBAN/JWT/API-key matches with typed redaction markers).
 *
 * Returns a new message array; the original is left untouched. When no
 * scanning is configured the function is an O(n) pass-through.
 */
async function scanHumanMessages(
  messages: BaseMessage[],
  promptInjection: PromptInjectionMode | undefined,
  pii: PiiMode | undefined,
  eventBus: DzupEventBus | undefined,
  agentId: string,
  runId: string | undefined
): Promise<BaseMessage[]> {
  const piMode: PromptInjectionMode = promptInjection ?? "warn";
  const piiMode: PiiMode = pii ?? "off";
  if (piMode === "off" && piiMode === "off") return messages;

  const scanner = new ContentScanner({ promptInjection: piMode, pii: piiMode });
  const out: BaseMessage[] = [];
  let changed = false;
  for (const m of messages) {
    const typed = m as { _getType?: () => string };
    const isHuman =
      typeof typed._getType === "function" && typed._getType() === "human";
    if (!isHuman || typeof m.content !== "string") {
      out.push(m);
      continue;
    }
    const result = await scanner.scan(m.content);
    if (result.verdict === "allow") {
      out.push(m);
      continue;
    }
    eventBus?.emit({
      type: "agent:context_fallback",
      agentId,
      ...(runId !== undefined ? { runId } : {}),
      reason:
        result.verdict === "block" ? "security:blocked" : "security:sanitized",
      before: m.content.length,
      after: result.sanitized.length,
    });
    if (result.verdict === "block") {
      throw new PromptInjectionBlockedError(result.findings);
    }
    changed = true;
    out.push(new HumanMessage(result.sanitized));
  }
  return changed ? out : messages;
}

/**
 * Best-effort extraction of the first human-authored message content from a
 * prepared transcript. Used as a fallback when the journal lacks a
 * `run_started` entry during resume rehydration.
 */
function extractFirstHumanMessage(messages: BaseMessage[]): string {
  for (const m of messages) {
    const typed = m as { _getType?: () => string };
    if (typeof typed._getType === "function" && typed._getType() === "human") {
      return typeof m.content === "string"
        ? m.content
        : JSON.stringify(m.content);
    }
  }
  return "";
}
