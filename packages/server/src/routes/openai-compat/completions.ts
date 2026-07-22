/**
 * POST /v1/chat/completions — OpenAI-compatible chat completions.
 *
 * This module re-implements the completions route with three gap fixes:
 *
 * GAP-1: System messages are extracted and composed with the stored agent
 *        instructions instead of being serialised into the flat prompt.
 *
 * GAP-2: Streaming finish_reason correctly emits 'length' when the agent
 *        hit its iteration or budget limit (hitIterationLimit from done event).
 *
 * GAP-3: Non-streaming responses include tool_calls in the choice message when
 *        the agent invoked tools during generation.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types.js";
import { streamSSE } from "hono/streaming";
import { HumanMessage } from "@langchain/core/messages";
import { DzupAgent } from "@dzupagent/agent/runtime";
import type { DzupEventBus } from "@dzupagent/core/events";
import type { ModelRegistry } from "@dzupagent/core/llm";
import type { AgentExecutionSpecStore } from "@dzupagent/core/persistence";
import {
  DEFAULT_TENANT_ID,
  getOptionalRequestingTenantId,
} from "../tenant-scope.js";
import { logRouteError } from "../route-error.js";
import { OpenAICompletionMapper } from "./completion-mapper.js";
import {
  mapRequest,
  mapFinalStreamChunk,
  mapResponseWithTools,
  validateCompletionRequest,
  notFoundError,
  serverError,
  generateCompletionId,
} from "./request-mapper.js";
import { getSerializedJsonSizeBytes } from "../../validation/route-validator.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenAICompatCompletionsConfig {
  agentStore: AgentExecutionSpecStore;
  modelRegistry: ModelRegistry;
  eventBus: DzupEventBus;
}

const OPENAI_MESSAGES_MAX_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createOpenAICompatCompletionsRoute(
  config: OpenAICompatCompletionsConfig,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  /** Used for streaming text/tool chunks — GAP-2 is handled separately */
  const baseMapper = new OpenAICompletionMapper();

  app.post("/", async (c) => {
    // --- Parse body ---
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          error: {
            message: "Could not parse the request body as valid JSON.",
            type: "invalid_request_error",
            param: null,
            code: "invalid_request_error",
          },
        },
        400,
      );
    }

    // --- Validate ---
    const validation = validateCompletionRequest(body);
    if (!validation.ok) {
      return c.json(validation.error, 400);
    }
    const request = validation.request;

    if (
      getSerializedJsonSizeBytes(request.messages) > OPENAI_MESSAGES_MAX_BYTES
    ) {
      return c.json(
        {
          error: {
            message: "messages too large (max 512 KB)",
            type: "invalid_request_error",
            param: "messages",
            code: "payload_too_large",
          },
        },
        413,
      );
    }

    // --- GAP-1: Extract system messages and map request ---
    const mapped = mapRequest(request);

    // --- Resolve agent ---
    const requestingTenantId = getOptionalRequestingTenantId(c);
    const agentDef = await config.agentStore.get(mapped.agentId);
    const agentTenantId =
      (agentDef?.tenantId ?? DEFAULT_TENANT_ID) || DEFAULT_TENANT_ID;
    if (
      !agentDef ||
      (requestingTenantId !== undefined && agentTenantId !== requestingTenantId)
    ) {
      return c.json(notFoundError(request.model), 404);
    }

    // --- GAP-1: Compose system instructions ---
    // If the caller supplied system messages, they override the stored
    // agent instructions.  If no system message was provided, fall back
    // to the stored instructions.
    const effectiveInstructions =
      mapped.systemOverride !== null
        ? [agentDef.instructions, mapped.systemOverride]
            .filter(Boolean)
            .join("\n\n")
        : agentDef.instructions;

    // --- Instantiate DzupAgent with composed instructions ---
    const agent = new DzupAgent({
      id: agentDef.id,
      name: agentDef.name,
      description: agentDef.description,
      instructions: effectiveInstructions,
      model: (agentDef.modelTier || "chat") as
        | "chat"
        | "reasoning"
        | "codegen"
        | "embedding",
      registry: config.modelRegistry,
      eventBus: config.eventBus,
    });

    const completionId = generateCompletionId();
    const promptMessage = new HumanMessage(mapped.prompt);

    // --- Streaming mode ---
    if (request.stream === true) {
      return streamSSE(c, async (stream) => {
        const abortController = new AbortController();

        const requestSignal = c.req.raw.signal;
        const onAbort = (): void => {
          abortController.abort();
        };
        requestSignal.addEventListener("abort", onAbort, { once: true });

        stream.onAbort(() => {
          abortController.abort();
        });

        try {
          // CODE-H-02: forward OpenAI sampling options into generation.
          const iter = agent.stream([promptMessage], mapped.options);

          for await (const event of iter) {
            if (abortController.signal.aborted) break;

            if (event.type === "text") {
              const content =
                typeof event.data["content"] === "string"
                  ? event.data["content"]
                  : "";
              if (content) {
                const chunk = baseMapper.mapChunk(
                  content,
                  request.model,
                  completionId,
                  0,
                  false,
                );
                await stream.writeSSE({ data: JSON.stringify(chunk) });
              }
              continue;
            }

            if (event.type === "done") {
              // GAP-2: Use mapFinalStreamChunk so hitIterationLimit → 'length'
              const finalChunk = mapFinalStreamChunk(
                request.model,
                completionId,
                event.data,
              );
              await stream.writeSSE({ data: JSON.stringify(finalChunk) });
              break;
            }

            if (event.type === "error") {
              // ERR-C-01: the agent error event's message may carry provider/internal
              // detail. Log it server-side; send the client a generic message only.
              const internal =
                typeof event.data["message"] === "string"
                  ? event.data["message"]
                  : "Internal error during streaming";
              logRouteError(
                c,
                "openai.completions.stream.event",
                new Error(internal),
                500,
              );
              await stream.writeSSE({
                data: JSON.stringify({
                  error: {
                    message: "Internal error during streaming",
                    type: "server_error",
                    param: null,
                    code: "internal_error",
                  },
                }),
              });
              break;
            }

            if (event.type === "tool_call") {
              const toolCall = event.data as {
                name?: string;
                args?: Record<string, unknown>;
                id?: string;
                index?: number;
              };
              const toolIndex =
                typeof toolCall.index === "number" ? toolCall.index : 0;
              const toolId =
                typeof toolCall.id === "string"
                  ? toolCall.id
                  : generateCompletionId();
              const toolName =
                typeof toolCall.name === "string" ? toolCall.name : "unknown";
              const toolArgs =
                typeof toolCall.args === "object" && toolCall.args !== null
                  ? JSON.stringify(toolCall.args)
                  : "";

              const initChunk = baseMapper.mapToolCallInitChunk(
                toolId,
                toolName,
                toolIndex,
                request.model,
                completionId,
              );
              await stream.writeSSE({ data: JSON.stringify(initChunk) });

              if (toolArgs) {
                const fragmentSize = 20;
                for (let i = 0; i < toolArgs.length; i += fragmentSize) {
                  const fragment = toolArgs.slice(i, i + fragmentSize);
                  const argChunk = baseMapper.mapToolCallArgumentsChunk(
                    fragment,
                    toolIndex,
                    request.model,
                    completionId,
                  );
                  await stream.writeSSE({ data: JSON.stringify(argChunk) });
                }
              }

              const finishChunk = baseMapper.mapToolCallsFinishChunk(
                request.model,
                completionId,
              );
              await stream.writeSSE({ data: JSON.stringify(finishChunk) });
              continue;
            }

            if (event.type === "tool_result") {
              // Internal — no SSE chunk emitted
              continue;
            }

            // budget_warning, stuck, adapter:* — skip in OpenAI compat mode
          }
        } catch (err: unknown) {
          if (!abortController.signal.aborted) {
            // ERR-C-01: sanitize before writing to the SSE error frame the client reads.
            const { safe } = logRouteError(
              c,
              "openai.completions.stream",
              err,
              500,
            );
            try {
              await stream.writeSSE({
                data: JSON.stringify(serverError(safe)),
              });
            } catch {
              // Stream already closed
            }
          }
        } finally {
          requestSignal.removeEventListener("abort", onAbort);
        }

        if (!abortController.signal.aborted) {
          try {
            await stream.writeSSE({ data: "[DONE]" });
          } catch {
            // Stream already closed
          }
        }
      });
    }

    // --- Non-streaming mode ---
    try {
      // CODE-H-02: forward OpenAI sampling options into generation.
      const result = await agent.generate([promptMessage], mapped.options);

      // GAP-3: Use mapResponseWithTools to include tool_calls in response
      const response = mapResponseWithTools(
        result.content,
        request.model,
        completionId,
        {
          totalInputTokens: result.usage.totalInputTokens,
          totalOutputTokens: result.usage.totalOutputTokens,
        },
        result.messages,
        result.hitIterationLimit,
      );

      return c.json(response);
    } catch (err: unknown) {
      // ERR-C-01: never forward raw err.message to the API client. logRouteError
      // emits the structured internal log and returns a client-safe message
      // (generic unless the error carries a SAFE_PREFIXES type/message).
      const { safe } = logRouteError(
        c,
        "openai.completions.generate",
        err,
        500,
      );
      return c.json(serverError(safe), 500);
    }
  });

  return app;
}
