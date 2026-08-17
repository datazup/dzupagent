/**
 * DzupAgent run coordinators — extracted from `dzip-agent.ts` to keep the
 * composition-root class under the file-line budget (DZUPAGENT-ARCH-M-06).
 *
 * These are pure delegation helpers over the run engine and model-invocation
 * coordinators. They take an explicit dependency bundle sourced from the
 * owning {@link DzupAgent} instance rather than closing over `this`, so the
 * behaviour is identical to the previous private-method implementation.
 */
import type { ZodType } from "zod";
import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  TokenBucket,
  StructuredOutputModelCapabilities,
} from "@dzupagent/core/llm";
import type { DistributedRateLimiter } from "../guardrails/distributed-rate-limiter.js";
import type { DistributedCostLedger } from "../guardrails/distributed-budget.js";
import type {
  DzupAgentConfig,
  GenerateOptions,
  GenerateResult,
  AgentStreamEvent,
} from "./agent-types.js";
import type { AgentMiddlewareRuntime } from "./middleware-runtime.js";
import type { StopReason } from "./tool-loop.js";
import { streamRun } from "./streaming-run.js";
import {
  executeGenerateRun,
  prepareRunState,
  type ExecuteGenerateRunParams,
  type PrepareRunStateParams,
} from "./run-engine.js";
import { maybeWriteBackMemory as maybeWriteBackMemoryFinalizer } from "./agent-finalizers.js";
import {
  invokeModelWithMiddleware as invokeModelWithMiddlewareCoord,
  transformToolResultWithMiddleware as transformToolResultWithMiddlewareCoord,
  type ModelInvocationDeps,
  type ProviderAttempt,
} from "./model-invocation.js";
import { generateStructured as generateStructuredRun } from "./structured-generate.js";
import { omitUndefined } from "../utils/exact-optional.js";
import { bindTools as bindToolsHelper } from "./provider-selection.js";
import { resolveMemoryRunId } from "./dzip-agent-resolvers.js";
import {
  buildRunHookContext,
  dispatchOnRunComplete,
  dispatchOnRunError,
  dispatchOnRunStart,
  toRunError,
} from "./run-lifecycle-hooks.js";

/**
 * Read the optional per-model structured-output capability descriptor.
 *
 * Moved verbatim from `dzip-agent.ts` alongside {@link runGenerateStructured}.
 */
function resolveStructuredOutputCapabilities(
  model: BaseChatModel
): StructuredOutputModelCapabilities | undefined {
  return (
    model as BaseChatModel & {
      structuredOutputCapabilities?: StructuredOutputModelCapabilities;
    }
  ).structuredOutputCapabilities;
}

/**
 * Which terminal {@link StopReason}s may persist a run's final content to
 * long-term memory.
 *
 * Deliberately a TOTAL `Record<StopReason, boolean>`: adding a member to
 * `StopReason` makes this map incomplete and fails the build, forcing an
 * explicit decision here instead of letting the new member fall silently into
 * the write-back path.
 *
 * This replaced `(result.stopReason as string) !== "failed"`. `"failed"` is
 * not a `StopReason` member and has no producer anywhere in the repo -- it
 * belongs to the unrelated `RunStatus` / `StreamingStatus` / pipeline-state
 * vocabularies -- so the `as string` cast silenced the compiler and left the
 * guard unconditionally true: every errored, aborted, stuck, budget-exhausted,
 * token-exhausted and compression-failed run wrote its partial content into
 * long-term memory.
 *
 * Only `"complete"` writes back. That is not a new policy: it is the rule the
 * streaming half of this same feature already applies inline -- both
 * `streaming-run-fallback.ts` and `streaming-run-iteration.ts` gate
 * `maybeWriteBackMemory` on `stopReason === 'complete'` -- so `generate()` and
 * `stream()` now agree. Every other member describes a run that stopped before
 * it finished answering, so its content is partial by construction.
 */
const MEMORY_WRITE_BACK_BY_STOP_REASON: Record<StopReason, boolean> = {
  complete: true,
  iteration_limit: false,
  budget_exceeded: false,
  aborted: false,
  error: false,
  stuck: false,
  token_exhausted: false,
  compression_failed: false,
  approval_pending: false,
};

/**
 * Dependency bundle for {@link runGenerate}, sourced from the owning
 * {@link DzupAgent} instance. Callbacks bind to `this` at the call site.
 */
export interface RunGenerateDeps {
  agentId: string;
  config: DzupAgentConfig;
  resolvedModel: BaseChatModel;
  middlewareRuntime: AgentMiddlewareRuntime;
  prepareMessages: (
    messages: BaseMessage[]
  ) => Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }>;
  getTools: () => StructuredToolInterface[];
  invokeModel: (
    model: BaseChatModel,
    messages: BaseMessage[],
    tools: StructuredToolInterface[]
  ) => Promise<BaseMessage>;
  maybeUpdateSummary: (
    messages: BaseMessage[],
    memoryFrame?: unknown
  ) => Promise<void>;
  resolveMemoryRunId: () => string | undefined;
}

/**
 * Execute a single non-streaming agent run: prepare run state, run the
 * ReAct loop through the run engine, and finalise memory write-back.
 *
 * This is the run boundary for the `onRunStart` / `onRunComplete` /
 * `onRunError` lifecycle hooks:
 *
 *  - `onRunStart` fires BEFORE any run state is prepared, so a hook observes
 *    the run even when `prepareMessages` or a security scan aborts it;
 *  - `onRunComplete` fires AFTER memory write-back, so hooks observe a fully
 *    finalised run — and fires for every returned result regardless of
 *    `stopReason` (see `dispatchOnRunComplete`);
 *  - `onRunError` fires for anything thrown out of the run — including a
 *    throwing write-back — and the original error is then RE-THROWN
 *    unchanged.
 *
 * All three are error-isolated: a hook that throws cannot break the run.
 */
export async function runGenerate(
  deps: RunGenerateDeps,
  messages: BaseMessage[],
  options?: GenerateOptions
): Promise<GenerateResult> {
  const hookCtx = buildRunHookContext(
    deps.config,
    deps.agentId,
    deps.resolveMemoryRunId()
  );
  await dispatchOnRunStart(deps.config, hookCtx);

  try {
    const runState = await prepareRunState(
      omitUndefined<PrepareRunStateParams>({
        config: deps.config,
        resolvedModel: deps.resolvedModel,
        messages,
        options,
        prepareMessages: (inputMessages) => deps.prepareMessages(inputMessages),
        getTools: () => deps.getTools(),
        bindTools: bindToolsHelper,
        runBeforeAgentHooks: (initialState) =>
          deps.middlewareRuntime.runBeforeAgentHooks(initialState),
      })
    );

    const result = await executeGenerateRun(
      omitUndefined<ExecuteGenerateRunParams>({
        agentId: deps.agentId,
        config: deps.config,
        options,
        runState,
        invokeModel: (model, preparedMessages) =>
          deps.invokeModel(model, preparedMessages, runState.tools),
        transformToolResult: (toolName, input, result) =>
          transformToolResultWithMiddlewareCoord(
            deps.middlewareRuntime,
            toolName,
            input,
            result
          ),
        maybeUpdateSummary: (allMessages, memoryFrame) =>
          deps.maybeUpdateSummary(allMessages, memoryFrame),
      })
    );

    if ((result.stopReason as string) !== "failed") {
      const runId = deps.resolveMemoryRunId();
      await maybeWriteBackMemoryFinalizer({
        agentId: deps.agentId,
        ...(runId !== undefined ? { runId } : {}),
        config: deps.config,
        content: result.content,
      });
    }

    await dispatchOnRunComplete(deps.config, hookCtx, result);
    return result;
  } catch (error) {
    await dispatchOnRunError(deps.config, hookCtx, toRunError(error));
    throw error;
  }
}

/**
 * Dependency bundle for {@link runGenerateStructured}, sourced from the
 * owning {@link DzupAgent} instance.
 */
export interface RunGenerateStructuredDeps {
  agentId: string;
  config: DzupAgentConfig;
  resolvedModel: BaseChatModel;
  prepareMessages: (
    messages: BaseMessage[]
  ) => Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }>;
  generate: (
    messages: BaseMessage[],
    options?: GenerateOptions
  ) => Promise<GenerateResult>;
}

/**
 * Generate a response with structured output validated against a Zod schema.
 *
 * DELIBERATELY dispatches NO run-lifecycle hooks of its own. `structured-generate`
 * has two paths: a native structured-output path (a single bound model call) and
 * a text fallback that delegates to `deps.generate(...)` — i.e. straight back
 * into {@link runGenerate}. Dispatching here would fire `onRunStart` /
 * `onRunComplete` TWICE for every fallback run. Suppressing the inner dispatch
 * instead would need a re-entrancy flag threaded through the public
 * `GenerateOptions`, which is a larger contract change than this repair.
 *
 * Consequence, stated plainly: `generateStructured` emits run-lifecycle hooks
 * exactly when it routes through `generate` (the text fallback), and none on
 * the native structured-output path.
 */
export async function runGenerateStructured<T>(
  deps: RunGenerateStructuredDeps,
  messages: BaseMessage[],
  schema: ZodType<T>,
  options?: GenerateOptions
): Promise<{ data: T; usage: GenerateResult["usage"] }> {
  return generateStructuredRun(
    {
      agentId: deps.agentId,
      config: deps.config,
      resolvedModel: deps.resolvedModel,
      prepareMessages: (inputMessages) => deps.prepareMessages(inputMessages),
      generate: (msgs, opts) => deps.generate(msgs, opts),
      resolveStructuredOutputCapabilities,
    },
    messages,
    schema,
    options
  );
}

/**
 * Dependency bundle for {@link invokeModelWithMiddleware}, sourced from the
 * owning {@link DzupAgent} instance.
 */
export interface InvokeModelDeps {
  agentId: string;
  tenantId: string;
  config: DzupAgentConfig;
  resolvedProvider: string | undefined;
  rateLimiter: TokenBucket | undefined;
  distributedRateLimiter: DistributedRateLimiter | undefined;
  distributedCostLedger: DistributedCostLedger | undefined;
  middlewareRuntime: AgentMiddlewareRuntime;
  getProviderAttempts: (tools: StructuredToolInterface[]) => ProviderAttempt[];
  shouldRunFailover: (err: Error, messages: BaseMessage[]) => boolean;
  /** Run-scoped cancellation, derived from the whole-run deadline when set. */
  signal?: AbortSignal;
}

/**
 * Dispatch a model call through the middleware runtime, applying rate-limit
 * gating, breaker accounting, distributed cost recording, and same-run
 * provider failover (when enabled).
 *
 * Extracted verbatim from `DzupAgent#invokeModelWithMiddleware`.
 */
export async function invokeModelWithMiddleware(
  deps: InvokeModelDeps,
  model: BaseChatModel,
  messages: BaseMessage[],
  tools: StructuredToolInterface[] = []
): Promise<BaseMessage> {
  const invocationDeps: ModelInvocationDeps = {
    agentId: deps.agentId,
    tenantId: deps.tenantId,
    rateLimiter: deps.rateLimiter,
    distributedRateLimiter: deps.distributedRateLimiter,
    distributedCostLedger: deps.distributedCostLedger,
    eventBus: deps.config.eventBus,
    middlewareRuntime: deps.middlewareRuntime,
    registry: deps.config.registry,
    resolvedProvider: deps.resolvedProvider,
    getProviderAttempts: () => deps.getProviderAttempts(tools),
    shouldRunFailover: (err) => deps.shouldRunFailover(err, messages),
    // ORCH-DSL-L1-C-01 / L1-H-02: per-call deadline and the run-scoped signal
    // (derived from guardrails.maxDurationMs) reach the one unbounded await.
    ...(deps.config.guardrails?.modelTimeoutMs !== undefined
      ? { modelTimeoutMs: deps.config.guardrails.modelTimeoutMs }
      : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  };
  return invokeModelWithMiddlewareCoord(invocationDeps, model, messages);
}

/**
 * Dependency bundle for {@link runStream}, sourced from the owning
 * {@link DzupAgent} instance.
 */
export interface RunStreamDeps {
  agentId: string;
  config: DzupAgentConfig;
  resolvedModel: BaseChatModel;
  resolvedProvider: string | undefined;
  resolvedTier: string | undefined;
  middlewareRuntime: AgentMiddlewareRuntime;
  getProviderAttempts: (tools: StructuredToolInterface[]) => ProviderAttempt[];
  prepareMessages: (
    messages: BaseMessage[]
  ) => Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }>;
  getTools: () => StructuredToolInterface[];
  invokeModel: (
    model: BaseChatModel,
    messages: BaseMessage[]
  ) => Promise<BaseMessage>;
  maybeUpdateSummary: (
    messages: BaseMessage[],
    memoryFrame?: unknown
  ) => Promise<void>;
  maybeWriteBackMemory: (content: string, runId?: string) => Promise<void>;
}

/**
 * Stream agent events, assembling the {@link StreamRunContext} the streaming
 * loop requires from the owning agent's dependency bundle.
 *
 * Dispatches the same run-lifecycle hooks as {@link runGenerate}, so a hook set
 * observes `generate()` and `stream()` symmetrically:
 *
 *  - `onRunStart` fires on the FIRST `next()` (this stays a lazy generator —
 *    merely calling `agent.stream(...)` without iterating starts nothing);
 *  - `onRunComplete` fires once the event stream is exhausted, carrying the
 *    payload of the last `done` event (the closest streaming analogue of a
 *    `GenerateResult`);
 *  - `onRunError` fires for anything thrown out of the loop, which is then
 *    re-thrown.
 *
 * A consumer that abandons the iterator early (`break` / `return`) fires
 * NEITHER terminal hook — the run neither completed nor errored, and inventing
 * a completion for a partially-consumed stream would misreport it.
 */
export async function* runStream(
  deps: RunStreamDeps,
  messages: BaseMessage[],
  options?: GenerateOptions
): AsyncGenerator<AgentStreamEvent> {
  const hookCtx = buildRunHookContext(
    deps.config,
    deps.agentId,
    resolveMemoryRunId(deps.config, options)
  );
  await dispatchOnRunStart(deps.config, hookCtx);

  let lastDoneData: unknown;
  try {
    const events = streamRun(
      {
        agentId: deps.agentId,
        config: deps.config,
        resolvedModel: deps.resolvedModel,
        resolvedProvider: deps.resolvedProvider,
        resolvedTier: deps.resolvedTier,
        registry: deps.config.registry,
        getProviderAttempts: (tools) => deps.getProviderAttempts(tools),
        prepareMessages: (inputMessages) => deps.prepareMessages(inputMessages),
        getTools: () => deps.getTools(),
        bindTools: bindToolsHelper,
        runBeforeAgentHooks: (initialState) =>
          deps.middlewareRuntime.runBeforeAgentHooks(initialState),
        invokeModelWithMiddleware: (model, preparedMessages) =>
          deps.invokeModel(model, preparedMessages),
        transformToolResultWithMiddleware: (toolName, input, result) =>
          transformToolResultWithMiddlewareCoord(
            deps.middlewareRuntime,
            toolName,
            input,
            result
          ),
        maybeUpdateSummary: (allMessages, memoryFrame) =>
          deps.maybeUpdateSummary(allMessages, memoryFrame),
        maybeWriteBackMemory: (content, runId) =>
          deps.maybeWriteBackMemory(content, runId),
      },
      messages,
      options
    );

    for await (const event of events) {
      if (event.type === "done") lastDoneData = event.data;
      yield event;
    }

    await dispatchOnRunComplete(deps.config, hookCtx, lastDoneData);
  } catch (error) {
    await dispatchOnRunError(deps.config, hookCtx, toRunError(error));
    throw error;
  }
}
