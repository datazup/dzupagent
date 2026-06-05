import { isDeepStrictEqual } from "node:util";

import type {
  AgentPort,
  AgentResult,
  AgentRunRequest,
} from "@dzupagent/dialogue-core";

import { ReplayExhaustedError } from "./errors.js";

export interface RecordedAgentCall {
  readonly request?: AgentRunRequest;
  readonly result: AgentResult;
}

export class RecordedAgentPort implements AgentPort {
  private callIndex = 0;

  constructor(private readonly calls: readonly RecordedAgentCall[]) {}

  get dialogueReplayRecordedPortCallCount(): number {
    return this.callIndex;
  }

  async run(request: AgentRunRequest): Promise<AgentResult> {
    const callIndex = this.callIndex;
    const call = this.calls[callIndex];
    if (call === undefined) {
      throw new ReplayExhaustedError("agent", "run", callIndex);
    }

    this.callIndex += 1;
    if (
      call.request !== undefined &&
      !isDeepStrictEqual(request, call.request)
    ) {
      throw new Error(
        `Recorded agent request mismatch at call index ${callIndex}.`,
      );
    }

    return cloneAgentResult(call.result);
  }
}

function cloneAgentResult(result: AgentResult): AgentResult {
  if (result.usage === undefined) {
    return { raw: result.raw };
  }

  return {
    raw: result.raw,
    usage: { ...result.usage },
  };
}
