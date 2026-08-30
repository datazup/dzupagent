export type { ExecutionRequest } from "./canonical-execution.js";
/**
 * Re-exported because `AiUsageTruth.cost` names this union in its own shape:
 * a consumer importing the receipt types from this subpath could not otherwise
 * name the reason it carries, and had to re-derive it via `Extract<...>`.
 * `ai-economics` remains the declaring module; there is no `./ai-economics`
 * export subpath, so this is the only path that reaches it.
 */
export type { AiCostUnknownReason } from "./ai-economics.js";

// The request/target/binding and usage/receipt contracts are declared in their
// own leaf modules so this subpath is not buried under 500 lines of type
// declarations. Re-exported wholesale: the public
// `@dzupagent/runtime-contracts/ai-execution` surface is unchanged.
export * from "./ai-execution-types.js";
export * from "./ai-execution-receipt-types.js";

// The validators are decomposed along their section boundaries (ARCH27-T-15);
// this facade is the `./ai-execution` subpath surface and re-exports them
// unchanged.
export {
  projectExecutionRequestToAi,
  validateAiExecutionRequest,
  validateAiExecutionTargetSelection,
  validateAiPublicTargetDescriptor,
} from "./ai-execution/request-validation.js";
export {
  validateAiExecutionEvent,
  validateAiExecutionEventSequence,
} from "./ai-execution/event-validation.js";
export {
  validateAiExecutionReceipt,
  validateAiExecutionTranscript,
} from "./ai-execution/receipt-validation.js";
export { validateAiExecutionBinding } from "./ai-execution/binding-validation.js";
export { validateAiUsageTruthV2 } from "./ai-execution/usage-validation.js";
