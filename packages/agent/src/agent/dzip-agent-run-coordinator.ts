/**
 * DzupAgent run coordinators — extracted from `dzip-agent.ts` to keep the
 * composition-root class under the file-line budget (DZUPAGENT-ARCH-M-06).
 *
 * These are pure delegation helpers over the run engine and model-invocation
 * coordinators. They take an explicit dependency bundle sourced from the
 * owning {@link DzupAgent} instance rather than closing over `this`, so the
 * behaviour is identical to the previous private-method implementation.
 */
import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { TokenBucket } from "@dzupagent/core/llm";
import type { DistributedRateLimiter } from "../guardrails/distributed-rate-limiter.js";
import type { DistributedCostLedger } from "../guardrails/distributed-budget.js";
import type {
  DzupAgentConfig,
  GenerateOptions,
  GenerateResult,
  AgentStreamEvent,
} from "./agent-types.js";
import type { AgentMiddlewareRuntime } from "./middleware-runtime.js";
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
import { omitUndefined } from "../utils/exact-optional.js";
import { bindTools as bindToolsHelper } from "./provider-selection.js";

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
 * Extracted verbatim from `DzupAgent#runGenerate`.
 */
export async function runGenerate(
  deps: RunGenerateDeps,
  messages: BaseMessage[],
  options?: GenerateOptions
): Promise<GenerateResult> {
  const runState = await prepareRunState(
    omitUndefined<PrepareRunStateParams>({
      config: deps.config,
      resolvedModel: deps.resolvedModel,
      messages,
      options,
      prepareMessages: (inputMessages) => deps.prepareMessages(inputMessages),
      getTools: () => deps.getTools(),
      bindTools: bindToolsHelper,
      runBeforeAgentHooks: () => deps.middlewareRuntime.runBeforeAgentHooks(),
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

  return result;
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
 * Extracted verbatim from `DzupAgent#stream`.
 */
export function runStream(
  deps: RunStreamDeps,
  messages: BaseMessage[],
  options?: GenerateOptions
): AsyncGenerator<AgentStreamEvent> {
  return streamRun(
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
      runBeforeAgentHooks: () => deps.middlewareRuntime.runBeforeAgentHooks(),
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
}
