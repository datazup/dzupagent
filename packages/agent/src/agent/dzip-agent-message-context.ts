/**
 * DzupAgent message/summary context binders — extracted from `dzip-agent.ts`
 * to keep the composition-root class under the file-line budget
 * (DZUPAGENT-ARCH-M-06).
 *
 * These are pure delegation helpers over the `message-preparation`
 * coordinators. They take an explicit dependency bundle sourced from the
 * owning {@link DzupAgent} instance, so behaviour is identical to the previous
 * private-method implementations.
 */
import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Tokenizer } from "@dzupagent/core/llm";
import type { DzupAgentConfig } from "./agent-types.js";
import type { AgentInstructionResolver } from "./instruction-resolution.js";
import type { AgentMemoryContextLoader } from "./memory-context-loader.js";
import {
  prepareMessages as prepareMessagesCoord,
  maybeUpdateSummary as maybeUpdateSummaryCoord,
  type ConversationSummaryAccessor,
} from "./message-preparation.js";

/**
 * Dependency bundle for {@link prepareMessages}, sourced from the owning
 * {@link DzupAgent} instance.
 */
export interface PrepareMessagesDeps {
  agentId: string;
  config: DzupAgentConfig;
  tokenizer: Tokenizer;
  instructionResolver: AgentInstructionResolver;
  memoryContextLoader: AgentMemoryContextLoader;
  summary: ConversationSummaryAccessor;
}

/**
 * Prepare the message window (instructions, memory context, compression).
 *
 * Extracted verbatim from `DzupAgent#prepareMessages`.
 */
export async function prepareMessages(
  deps: PrepareMessagesDeps,
  messages: BaseMessage[],
  memoryReadContext?: { runId: string }
): Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }> {
  return prepareMessagesCoord(
    {
      agentId: deps.agentId,
      config: deps.config,
      tokenizer: deps.tokenizer,
      instructionResolver: deps.instructionResolver,
      memoryContextLoader: deps.memoryContextLoader,
      summary: deps.summary,
    },
    messages,
    memoryReadContext
  );
}

/**
 * Dependency bundle for {@link maybeUpdateSummary}, sourced from the owning
 * {@link DzupAgent} instance.
 */
export interface MaybeUpdateSummaryDeps {
  agentId: string;
  config: DzupAgentConfig;
  resolvedModel: BaseChatModel;
  tokenizer: Tokenizer;
  summary: ConversationSummaryAccessor;
}

/**
 * Roll the conversation summary forward when the window grows too large.
 *
 * Extracted verbatim from `DzupAgent#maybeUpdateSummary`.
 */
export async function maybeUpdateSummary(
  deps: MaybeUpdateSummaryDeps,
  messages: BaseMessage[],
  memoryFrame?: unknown
): Promise<void> {
  return maybeUpdateSummaryCoord(
    {
      agentId: deps.agentId,
      config: deps.config,
      resolvedModel: deps.resolvedModel,
      tokenizer: deps.tokenizer,
      summary: deps.summary,
    },
    messages,
    memoryFrame
  );
}
