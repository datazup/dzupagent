import type { DzupEvent } from "@dzupagent/core/events";

import type { CompilerOptions } from "../types.js";

/** Compiler lifecycle events admitted to the orchestration event sink. */
export type FlowCompileEvent = Extract<
  DzupEvent,
  {
    type:
      | "flow:compile_started"
      | "flow:compile_parsed"
      | "flow:compile_shape_validated"
      | "flow:compile_semantic_resolved"
      | "flow:compile_lowered"
      | "flow:compile_completed"
      | "flow:compile_failed";
  }
>;

/** Dependencies injected by the public createFlowCompiler facade. */
export interface CompileOrchestratorDeps {
  readonly opts: CompilerOptions;
  readonly emit: (event: FlowCompileEvent) => void;
}
