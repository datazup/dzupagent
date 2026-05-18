/**
 * Cross-agent security — authentication, signing, and replay prevention.
 *
 * @module security
 */
export { AgentAuth } from './agent-auth.js'
export {
  InMemoryAgentReplayStore,
  InMemoryAgentPublicKeyStore,
} from './agent-auth.js'
export type {
  AgentCredential,
  SignedAgentMessage,
  AgentAuthConfig,
  AgentCapabilityClaims,
  AgentAuthFailureCode,
  AgentAuthVerificationStage,
  AgentAuthFailure,
  AgentAuthResult,
  AgentReplayResult,
  AgentReplayStore,
  AgentPublicKeyStore,
} from './agent-auth.js'
