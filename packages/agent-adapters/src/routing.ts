/** Minimal deterministic-routing entrypoint for hosts that do not need adapters. */
export {
  classifyRouteTransition,
  createRouteSelectionReceipt,
  DeterministicRouteSelectionAdmissionError,
  IMPLEMENTED_DETERMINISTIC_ROUTE_STRATEGIES,
  planCandidateRecovery,
  replayRouteSelectionReceipt,
  ROUTE_SELECTION_RECEIPT_SCHEMA,
  RouteSelectionReceiptReplayError,
  selectExecutionRoute,
} from './registry/deterministic-candidate-selector.js'
export type {
  CandidateRecoveryAction,
  CandidateRecoveryInput,
  DeterministicRouteSelectionAdmissionCode,
  DeterministicRouteSelectionOptions,
  RouteSelectionCandidateWeight,
  RouteSelectionReceipt,
  RouteSelectionReceiptReplayCode,
} from './registry/deterministic-candidate-selector.js'
export {
  admitExecutionRoutePolicy,
  ROUTE_POLICY_ADMISSION_CODES,
  RoutePolicyAdmissionError,
} from './registry/route-policy-admission.js'
export type { RoutePolicyAdmissionCode } from './registry/route-policy-admission.js'
export { materializeRoutingCandidates } from './registry/candidate-materializer.js'
export type { CandidateMaterializationDescriptor } from './registry/candidate-materializer.js'
