/**
 * `@dzupagent/hitl-kit/testing` — conformance suites for adapter authors.
 * Durable `QuorumVoteStore` adapters must pass
 * `runQuorumVoteStoreContract` (DZUPAGENT-TEST-M-25).
 */
export {
  QuorumVoteStoreContractViolation,
  runQuorumVoteStoreContract,
  type QuorumVoteStoreContractHarness,
} from "./testing/quorum-vote-store-contract.js";
