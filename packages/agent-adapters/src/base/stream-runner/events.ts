/**
 * Lifecycle AgentEvent construction for {@link AdapterStreamRunner}.
 *
 * Extracted from the former single-file stream-runner.ts (ARCH-M-06). These
 * are pure builders — they read only the passed config/context and produce the
 * `adapter:started` / synthetic `adapter:failed` (abort) events. No instance
 * state is involved.
 */

import type { AdapterProviderId, AgentEvent } from "../../types.js";
import type { AdapterStreamRunnerConfig, StreamContext } from "./types.js";

export function buildAbortFailedEvent(
  config: AdapterStreamRunnerConfig,
  providerId: AdapterProviderId,
  context: StreamContext
): AgentEvent {
  return {
    type: "adapter:failed",
    providerId,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    error: config.abortErrorMessage ?? "Aborted",
    code: config.abortErrorCode ?? "AGENT_ABORTED",
    timestamp: Date.now(),
    ...(context.input.correlationId
      ? { correlationId: context.input.correlationId }
      : {}),
  };
}

export function buildStartedEvent(
  providerId: AdapterProviderId,
  context: StreamContext,
  extra?: Record<string, unknown>
): AgentEvent {
  const { input, sessionId } = context;
  return {
    type: "adapter:started",
    providerId,
    sessionId,
    timestamp: Date.now(),
    prompt: input.prompt,
    ...(input.systemPrompt !== undefined
      ? { systemPrompt: input.systemPrompt }
      : {}),
    ...(input.workingDirectory !== undefined
      ? { workingDirectory: input.workingDirectory }
      : {}),
    isResume: !!input.resumeSessionId,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...extra,
  };
}
