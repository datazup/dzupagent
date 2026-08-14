/** Minimal deterministic-routing entrypoint for hosts that do not need adapters. */
export {
  classifyRouteTransition,
  DeterministicRouteSelectionAdmissionError,
  IMPLEMENTED_DETERMINISTIC_ROUTE_STRATEGIES,
  planCandidateRecovery,
  selectExecutionRoute,
} from './registry/deterministic-candidate-selector.js'
export type {
  CandidateRecoveryAction,
  CandidateRecoveryInput,
  DeterministicRouteSelectionAdmissionCode,
  DeterministicRouteSelectionOptions,
} from './registry/deterministic-candidate-selector.js'
export { materializeRoutingCandidates } from './registry/candidate-materializer.js'
export type { CandidateMaterializationDescriptor } from './registry/candidate-materializer.js'
