/**
 * Kubernetes sandbox infrastructure — CRD types, API client, and pod sandbox.
 */

// --- Operator types (CRD) ---
export type {
  AgentSandboxPhase,
  SecurityLevel as K8sSecurityLevel,
  AgentSandboxResourceRequests,
  AgentSandboxResourceLimits,
  AgentSandboxResources,
  AgentSandboxVolume,
  AgentSandboxNetwork,
  AgentSandboxEnvVar,
  AgentSandboxSpec,
  AgentSandboxStatus,
  AgentSandboxMetadata,
  AgentSandboxResource,
} from './operator-types.js'
export { createAgentSandboxResource } from './operator-types.js'

// --- K8s client ---
export { K8sClient } from './k8s-client.js'
export type { K8sClientConfig } from './k8s-client.js'

// --- K8s pod sandbox ---
export { K8sPodSandbox } from './k8s-sandbox.js'
export type { K8sSandboxConfig } from './k8s-sandbox.js'
