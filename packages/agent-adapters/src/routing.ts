/** Minimal deterministic-routing entrypoint for hosts that do not need adapters. */
export {
  classifyRouteTransition,
  DeterministicRouteSelectionAdmissionError,
  IMPLEMENTED_DETERMINISTIC_ROUTE_STRATEGIES,
  planCandidateRecovery,
  replayRouteSelectionReceipt,
  ROUTE_SELECTION_RECEIPT_SCHEMA,
  selectExecutionRoute,
  selectExecutionRouteWithReceipt,
} from "./registry/deterministic-candidate-selector.js";
export type {
  CandidateRecoveryAction,
  CandidateRecoveryInput,
  DeterministicRouteSelectionAdmissionCode,
  DeterministicRouteSelectionOptions,
  RouteSelectionReceipt,
} from "./registry/deterministic-candidate-selector.js";
export { ROUTE_WEIGHT_TAG_PREFIX } from "./registry/seeded-route-strategies.js";
export type {
  SeededRouteStrategy,
  SeededRouteStrategyFailureCode,
} from "./registry/seeded-route-strategies.js";
export type { RoundRobinRouteStrategyFailureCode } from "./registry/round-robin-route-strategy.js";
export { ROUTE_DEADLINE_FAILURE_CODES } from "./registry/route-deadline-strategy.js";
export type {
  RouteDeadlineFailureCode,
  RouteSelectionDeadlineOutcome,
} from "./registry/route-deadline-strategy.js";
export {
  admitExecutionRoutePolicy,
  RoutePolicyAdmissionError,
} from "./registry/route-policy-admission.js";
export type { RoutePolicyAdmissionCode } from "./registry/route-policy-admission.js";
export { materializeRoutingCandidates } from "./registry/candidate-materializer.js";
export type { CandidateMaterializationDescriptor } from "./registry/candidate-materializer.js";
