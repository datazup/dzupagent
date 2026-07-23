/**
 * Neutral flow-orchestration contracts.
 *
 * This governed subpath keeps new orchestration APIs out of the
 * growth-frozen package root while allowing compilers and hosts to share
 * primitive, durable-task, and continuation semantics.
 */
export { EXECUTION_LEAF_KINDS } from "./canonical-execution.js";
export type { ExecutionLeafKind } from "./canonical-execution.js";
export { validatePrimitiveInvocation } from "./primitive-invocation.js";
export type {
  PrimitiveInvocation,
  PrimitiveInvocationDiagnostic,
  PrimitiveInvocationDiagnosticCode,
  PrimitiveInvocationValidation,
} from "./primitive-invocation.js";
export {
  RUNTIME_TASK_KINDS,
  RUNTIME_TASK_STATES,
  isRuntimeTaskTerminalState,
  validateRuntimeTaskTransition,
} from "./runtime-task.js";
export type {
  RuntimeTaskDelivery,
  RuntimeTaskError,
  RuntimeTaskKind,
  RuntimeTaskRef,
  RuntimeTaskRequest,
  RuntimeTaskResult,
  RuntimeTaskState,
  RuntimeTaskTerminalState,
  RuntimeTaskTransitionDiagnostic,
  RuntimeTaskTransitionDiagnosticCode,
  RuntimeTaskTransitionValidation,
} from "./runtime-task.js";
export {
  CONTINUATION_KINDS,
  validateContinuationResult,
} from "./continuation.js";
export type {
  ContinuationKind,
  ContinuationRequest,
  ContinuationResult,
  ContinuationResultDiagnostic,
  ContinuationResultDiagnosticCode,
  ContinuationResultStatus,
  ContinuationResultValidation,
} from "./continuation.js";
