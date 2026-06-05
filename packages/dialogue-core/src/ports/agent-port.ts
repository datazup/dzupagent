import type { AgentRunRequest } from "../types/agent-run-request.js";

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentResult {
  raw: string;
  usage?: AgentUsage;
}

export interface AgentPort {
  run(request: AgentRunRequest): Promise<AgentResult>;
}
