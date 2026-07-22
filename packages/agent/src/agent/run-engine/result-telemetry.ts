import type { DzupAgentConfig } from "../agent-types.js";
import { type StopReason, type ToolStat } from "../tool-loop.js";
import type { ToolStatTracker } from "../streaming-tool-types.js";

export async function applyOutputFilter(
  config: DzupAgentConfig,
  content: string
): Promise<string> {
  if (!config.guardrails?.outputFilter || !content) {
    return content;
  }

  const filtered = await config.guardrails.outputFilter(content);
  return filtered === null ? content : filtered;
}

export function emitStopReasonTelemetry(
  config: Pick<DzupAgentConfig, "eventBus">,
  agentId: string,
  payload: {
    stopReason: StopReason;
    llmCalls: number;
    toolStats: ToolStat[];
  }
): void {
  config.eventBus?.emit({
    type: "agent:stop_reason",
    agentId,
    reason: payload.stopReason,
    iterations: payload.llmCalls,
    toolStats: payload.toolStats,
  });
}

export function createToolStatTracker(): ToolStatTracker {
  const statMap = new Map<
    string,
    { calls: number; errors: number; totalMs: number }
  >();

  return {
    record(name, durationMs, error) {
      const current = statMap.get(name) ?? { calls: 0, errors: 0, totalMs: 0 };
      current.calls += 1;
      current.totalMs += durationMs;
      if (error !== undefined) {
        current.errors += 1;
      }
      statMap.set(name, current);
    },
    toArray() {
      return [...statMap.entries()].map(([name, stat]) => ({
        name,
        calls: stat.calls,
        errors: stat.errors,
        totalMs: stat.totalMs,
        avgMs: stat.calls > 0 ? Math.round(stat.totalMs / stat.calls) : 0,
      }));
    },
  };
}
