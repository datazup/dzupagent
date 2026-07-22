export const RUNTIME_TOOL_PREFIX = "dzup.runtime.";
export const RUNTIME_TOOL_RESULT_MARKER = "__dzupRuntimeToolResult";

export const RUNTIME_TOOL_NAMES = {
  validate: "dzup.runtime.validate",
  prompt: "dzup.runtime.prompt",
  workerDispatch: "dzup.runtime.worker.dispatch",
  shellRun: "dzup.runtime.shell.run",
  validateSchema: "dzup.runtime.validate.schema",
  set: "dzup.runtime.set",
  adapterRun: "dzup.runtime.adapter.run",
  adapterRace: "dzup.runtime.adapter.race",
  adapterParallel: "dzup.runtime.adapter.parallel",
  adapterSupervisor: "dzup.runtime.adapter.supervisor",
} as const;
