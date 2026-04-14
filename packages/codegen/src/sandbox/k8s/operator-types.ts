/**
 * Kubernetes CRD types for AgentSandbox custom resource.
 *
 * These types mirror the CRD schema at k8s/crd/agent-sandbox.yaml.
 * The operator reconciler uses these to manage sandbox pod lifecycle.
 */

// ---------------------------------------------------------------------------
// Enums / Unions
// ---------------------------------------------------------------------------

export type AgentSandboxPhase =
  | 'Pending'
  | 'Creating'
  | 'Ready'
  | 'Running'
  | 'Succeeded'
  | 'Failed'
  | 'Terminating'

export type SecurityLevel = 'default' | 'strict' | 'custom'

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export interface AgentSandboxResourceRequests {
  cpu: string
  memory: string
}

export interface AgentSandboxResourceLimits {
  cpu: string
  memory: string
}

export interface AgentSandboxResources {
  limits: AgentSandboxResourceLimits
  requests?: AgentSandboxResourceRequests
}

export interface AgentSandboxVolume {
  name: string
  mountPath: string
  type: 'emptyDir' | 'pvc' | 'configMap'
}

export interface AgentSandboxNetwork {
  egressPolicy: 'deny-all' | 'allow-all' | 'custom'
  allowedHosts?: string[]
}

export interface AgentSandboxEnvVar {
  name: string
  value: string
}

export interface AgentSandboxSpec {
  /** Container image to use for the sandbox pod */
  image: string
  /** Security level: default, strict, or custom */
  securityLevel: SecurityLevel
  /** Optional Kubernetes RuntimeClass name */
  runtimeClass?: string
  /** Resource requests and limits */
  resources: AgentSandboxResources
  /** Network egress policy */
  network: AgentSandboxNetwork
  /** Optional volume mounts */
  volumes?: AgentSandboxVolume[]
  /** Reference to the agent run that owns this sandbox */
  runRef?: string
  /** TTL in seconds after completion (auto-cleanup) */
  ttlSeconds?: number
  /** Environment variables to inject into the pod */
  env?: AgentSandboxEnvVar[]
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface AgentSandboxStatus {
  phase: AgentSandboxPhase
  podName?: string
  podIP?: string
  startedAt?: string
  completedAt?: string
  message?: string
}

// ---------------------------------------------------------------------------
// Full CRD resource
// ---------------------------------------------------------------------------

export interface AgentSandboxMetadata {
  name: string
  namespace?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  uid?: string
  resourceVersion?: string
  creationTimestamp?: string
}

export interface AgentSandboxResource {
  apiVersion: 'dzupagent.dev/v1alpha1'
  kind: 'AgentSandbox'
  metadata: AgentSandboxMetadata
  spec: AgentSandboxSpec
  status?: AgentSandboxStatus
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal AgentSandboxResource with defaults */
export function createAgentSandboxResource(
  name: string,
  spec: Partial<AgentSandboxSpec> & Pick<AgentSandboxSpec, 'image'>,
  namespace?: string,
): AgentSandboxResource {
  return {
    apiVersion: 'dzupagent.dev/v1alpha1',
    kind: 'AgentSandbox',
    metadata: {
      name,
      ...(namespace ? { namespace } : {}),
      labels: {
        'app.kubernetes.io/managed-by': 'dzupagent',
      },
    },
    spec: {
      securityLevel: 'default',
      resources: {
        limits: { cpu: '1', memory: '512Mi' },
        requests: { cpu: '250m', memory: '128Mi' },
      },
      network: { egressPolicy: 'deny-all' },
      ...spec,
    },
  }
}
