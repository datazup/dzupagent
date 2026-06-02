import type {
  SubagentResult,
  SubagentSpec,
  TaskId,
} from "./background-task.js";
import type { CheckpointerPort } from "./checkpointer-port.js";

/** Context handed to the executor for a single subagent run. */
export interface SubagentExecutionContext {
  taskId: TaskId;
  signal: AbortSignal;
  /** Progress callback — surfaced by the runtime as a `subagent:progress` event. */
  onProgress?: (note: string) => void;
  /** Available when a checkpointer is configured, for resumable execution. */
  checkpointer?: CheckpointerPort;
}

/**
 * The seam that actually runs a subagent. Keeping this as an injected port means
 * `@dzupagent/subagents` never imports the agent runtime (which lives in higher
 * layers), preserving the DAG. `@dzupagent/agent-adapters` provides the real
 * implementation; tests provide a fake.
 */
export interface SubagentExecutorPort {
  run(
    spec: SubagentSpec,
    ctx: SubagentExecutionContext
  ): Promise<SubagentResult>;
}
