# 07 -- Runtime & Deployment

> **Created:** 2026-03-24
> **Status:** Planning
> **Priority:** P1-P3
> **Packages affected:** `@dzipagent/codegen` (sandbox), `@dzipagent/server` (runtime management)
> **Parent:** [00-INDEX.md](./00-INDEX.md)
> **Gap plan reference:** [04-SERVER-RUNTIME.md](/docs/gap_plan/04-SERVER-RUNTIME.md), [06-CODEGEN-EXCELLENCE.md](/docs/gap_plan/06-CODEGEN-EXCELLENCE.md)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Feature Specifications](#2-feature-specifications)
   - [F1: Sandbox Pooling](#f1-sandbox-pooling-p1-8h)
   - [F2: Kubernetes CRD](#f2-kubernetes-crd-p2-16h)
   - [F3: Persistent Volumes](#f3-persistent-volumes-p1-4h)
   - [F4: Resource Quotas](#f4-resource-quotas-p1-6h)
   - [F5: WASM Sandbox](#f5-wasm-sandbox-p3-24h)
   - [F6: Agent Hot-Reload](#f6-agent-hot-reload-p2-8h)
   - [F7: Sandbox Audit Logging](#f7-sandbox-audit-logging-p1-4h)
   - [F8: Multi-Sandbox Orchestration](#f8-multi-sandbox-orchestration-p2-8h)
3. [Data Models](#3-data-models)
4. [Deployment Topologies](#4-deployment-topologies)
5. [File Structure](#5-file-structure)
6. [Testing Strategy](#6-testing-strategy)
7. [Implementation Roadmap](#7-implementation-roadmap)

---

## 1. Architecture Overview

### 1.1 Runtime Layer Architecture

The runtime layer sits between DzipAgent's pipeline execution and the underlying compute infrastructure. It manages sandbox lifecycle, resource allocation, and deployment concerns across heterogeneous environments.

```
 DzipAgent Pipeline Execution
 ────────────────────────────
          │
          ▼
 ┌─────────────────────────────────────────────────────────┐
 │                   Runtime Manager                        │
 │  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
 │  │ SandboxPool   │  │ ResourceQuota│  │ AuditLogger   │ │
 │  │ (pre-warm,    │  │ Manager      │  │ (command log, │ │
 │  │  acquire,     │  │ (per-tenant  │  │  file changes,│ │
 │  │  release)     │  │  enforcement)│  │  network)     │ │
 │  └──────┬───────┘  └──────┬───────┘  └───────────────┘ │
 │         │                  │                             │
 │  ┌──────▼──────────────────▼───────────────────────────┐│
 │  │           Sandbox Orchestrator                       ││
 │  │  (multi-sandbox coordination, dependency graph,      ││
 │  │   shared volumes, parallel execution)                ││
 │  └──────────────────────┬──────────────────────────────┘│
 └─────────────────────────┼───────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                 ▼
 ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
 │ Docker       │ │ E2B          │ │ Fly.io       │
 │ Sandbox      │ │ Sandbox      │ │ Sandbox      │
 │ (local)      │ │ (Firecracker)│ │ (Machines)   │
 └──────────────┘ └──────────────┘ └──────────────┘
 ┌──────────────┐ ┌──────────────┐
 │ K8s Pod      │ │ WASM         │
 │ Sandbox      │ │ Sandbox      │
 │ (gVisor/Kata)│ │ (portable)   │
 └──────────────┘ └──────────────┘
```

### 1.2 Sandbox Lifecycle State Machine

Every sandbox instance, regardless of provider, follows a uniform lifecycle:

```
                     ┌──────────┐
            ┌───────►│ creating │
            │        └────┬─────┘
            │             │ init success
            │             ▼
 ┌──────┐   │       ┌──────────┐
 │ idle │◄──┼───────│  ready   │◄──────────────┐
 └──┬───┘   │       └────┬─────┘               │
    │       │            │ acquire()            │
    │       │            ▼                      │
    │       │       ┌──────────┐    release()   │
    │       │       │  active  │────────────────┘
    │       │       └────┬─────┘
    │       │            │ health check fail / evict
    │       │            ▼
    │       │       ┌──────────┐
    │       └───────│ draining │
    │               └────┬─────┘
    │                    │ cleanup complete
    │                    ▼
    │               ┌──────────┐
    └──────────────►│destroyed │
                    └──────────┘
```

**State definitions:**

| State | Description |
|-------|-------------|
| `creating` | Sandbox infrastructure is being provisioned (container pull, VM boot) |
| `ready` | Sandbox is fully initialized and passes health check |
| `idle` | Sandbox is in the pool, warm but unused |
| `active` | Sandbox has been acquired by a pipeline run and is executing commands |
| `draining` | Sandbox is finishing its current work before teardown |
| `destroyed` | Sandbox resources have been fully released |

### 1.3 Resource Quota Enforcement Model

Resource quotas are enforced at three levels:

```
  Tenant Quota (ceiling)
  ├── Per-Run Budget (from pipeline config)
  │   ├── Per-Sandbox Allocation (from SecurityProfile.resources)
  │   │   ├── CPU (cores)
  │   │   ├── Memory (MB)
  │   │   ├── Disk (MB)
  │   │   └── Time (ms)
  │   └── Aggregate sandbox count limit
  └── Concurrent sandbox limit
```

Quota checks happen:
1. **Before sandbox creation** -- reject if tenant would exceed limits
2. **During execution** -- monitor via cgroup stats (Docker/K8s) or API polling (E2B/Fly)
3. **After completion** -- release reservations, update usage counters

### 1.4 Deployment Topology Options

| Topology | Sandbox Provider | When to Use |
|----------|-----------------|-------------|
| Single-node (Docker Compose) | DockerSandbox | Development, small teams, self-hosted |
| Kubernetes cluster | K8sPodSandbox | Production, multi-tenant, compliance |
| Serverless | E2B / Fly / WASM | SaaS platform, burst workloads, edge |
| Hybrid | Docker (local) + E2B (overflow) | Cost-optimized production |

---

## 2. Feature Specifications

### F1: Sandbox Pooling (P1, 8h)

#### Problem

Every pipeline run currently creates a new sandbox from scratch. Docker container startup is 1-3 seconds, E2B microVM boot is 0.5-1.5 seconds. For interactive coding sessions with multiple tool calls, this latency compounds. A pre-warmed pool eliminates cold-start costs for sequential runs.

#### Design

The `SandboxPool` wraps `SandboxProtocol` with connection-pooling semantics. It pre-warms a configurable number of sandboxes, health-checks them before handing them out, and evicts stale or unhealthy instances on a background timer.

#### Interface Specification

```typescript
// @dzipagent/codegen/src/sandbox/pool/sandbox-pool.ts

import type { SandboxProtocol } from '../sandbox-protocol.js'

/**
 * Configuration for the sandbox connection pool.
 *
 * @example
 * ```ts
 * const pool = new SandboxPool({
 *   factory: () => new DockerSandbox({ image: 'node:20-slim' }),
 *   minIdle: 2,
 *   maxActive: 10,
 *   maxWaitMs: 5_000,
 *   evictionIntervalMs: 30_000,
 *   maxIdleTimeMs: 120_000,
 *   healthCheckOnAcquire: true,
 * })
 * ```
 */
export interface SandboxPoolConfig {
  /**
   * Factory function to create new sandbox instances.
   * Called during pre-warm and when the pool needs to grow.
   */
  factory: () => SandboxProtocol | Promise<SandboxProtocol>

  /**
   * Minimum number of idle sandboxes to keep warm.
   * The pool will eagerly create sandboxes until this floor is met.
   * @default 1
   */
  minIdle: number

  /**
   * Maximum number of active (in-use) sandboxes at any time.
   * acquire() blocks or rejects when this ceiling is hit.
   * @default 10
   */
  maxActive: number

  /**
   * Maximum time in milliseconds to wait for an available sandbox
   * when the pool is exhausted. Rejects with PoolExhaustedError after this.
   * @default 5_000
   */
  maxWaitMs: number

  /**
   * Interval in milliseconds between eviction sweeps.
   * Each sweep removes sandboxes that have been idle longer than maxIdleTimeMs.
   * @default 30_000
   */
  evictionIntervalMs: number

  /**
   * Maximum time in milliseconds a sandbox may sit idle before eviction.
   * @default 120_000
   */
  maxIdleTimeMs: number

  /**
   * Whether to run a health check (isAvailable + test command) before
   * returning a sandbox from acquire(). Adds ~200ms but catches stale containers.
   * @default true
   */
  healthCheckOnAcquire: boolean
}

/** Current state of a pooled sandbox. */
export type PooledSandboxState =
  | 'creating'
  | 'idle'
  | 'active'
  | 'draining'
  | 'destroyed'

/** Metadata attached to each sandbox in the pool. */
export interface PooledSandbox {
  readonly id: string
  readonly sandbox: SandboxProtocol
  readonly state: PooledSandboxState
  readonly createdAt: Date
  readonly lastUsedAt: Date
  readonly useCount: number
}

/** Aggregate metrics for the pool. */
export interface SandboxPoolMetrics {
  /** Number of sandboxes currently in use. */
  active: number
  /** Number of warm sandboxes waiting to be acquired. */
  idle: number
  /** Total sandboxes created since pool start. */
  totalCreated: number
  /** Total sandboxes destroyed since pool start. */
  totalDestroyed: number
  /** Total acquire() calls that had to wait for a sandbox. */
  totalWaits: number
  /** Average wait time in ms for blocked acquire() calls. */
  avgWaitMs: number
  /** Number of sandboxes that failed health check on acquire. */
  healthCheckFailures: number
}

/**
 * Error thrown when acquire() times out because maxActive sandboxes
 * are all in use and none become available within maxWaitMs.
 */
export class PoolExhaustedError extends Error {
  readonly name = 'PoolExhaustedError' as const
  constructor(
    public readonly poolMetrics: SandboxPoolMetrics,
    public readonly maxWaitMs: number,
  ) {
    super(
      `Sandbox pool exhausted: ${poolMetrics.active} active, ` +
      `${poolMetrics.idle} idle, waited ${maxWaitMs}ms`
    )
  }
}

/**
 * Connection pool for SandboxProtocol instances.
 *
 * Manages a fleet of pre-warmed sandboxes, handles health checks,
 * and enforces concurrency limits. Thread-safe for concurrent acquire/release.
 *
 * @example
 * ```ts
 * const pool = new SandboxPool({
 *   factory: () => new DockerSandbox({ image: 'node:20-slim' }),
 *   minIdle: 2,
 *   maxActive: 10,
 * })
 *
 * await pool.start()
 *
 * // In pipeline execution:
 * const sandbox = await pool.acquire()
 * try {
 *   await sandbox.execute('npm test')
 * } finally {
 *   await pool.release(sandbox)
 * }
 *
 * // At shutdown:
 * await pool.drain()
 * ```
 */
export class SandboxPool {
  constructor(config: Partial<SandboxPoolConfig> & Pick<SandboxPoolConfig, 'factory'>) {}

  /**
   * Initialize the pool: create minIdle sandboxes and start the eviction timer.
   * Must be called before acquire().
   */
  async start(): Promise<void> {}

  /**
   * Acquire a sandbox from the pool.
   *
   * Returns immediately if an idle sandbox is available.
   * Blocks up to maxWaitMs if the pool is at capacity.
   * Throws PoolExhaustedError if no sandbox becomes available.
   *
   * If healthCheckOnAcquire is true, the sandbox is validated before return.
   * Failed health checks cause the sandbox to be destroyed and a new one
   * is tried (up to 3 retries).
   */
  async acquire(): Promise<SandboxProtocol> { throw new Error('stub') }

  /**
   * Return a sandbox to the pool for reuse.
   *
   * The sandbox is reset (cleanup + re-init) before being marked idle.
   * If reset fails, the sandbox is destroyed and a replacement is created
   * if the pool is below minIdle.
   */
  async release(sandbox: SandboxProtocol): Promise<void> {}

  /**
   * Forcefully remove a sandbox from the pool and destroy it.
   * Use when a sandbox is known to be in a bad state.
   */
  async evict(sandbox: SandboxProtocol): Promise<void> {}

  /**
   * Gracefully shut down the pool:
   * 1. Stop accepting new acquire() calls
   * 2. Wait for all active sandboxes to be released (up to drainTimeoutMs)
   * 3. Destroy all remaining sandboxes
   * 4. Cancel the eviction timer
   */
  async drain(drainTimeoutMs?: number): Promise<void> {}

  /** Get current pool metrics. */
  metrics(): SandboxPoolMetrics { throw new Error('stub') }
}
```

#### Integration with SandboxFactory

The existing `createSandbox()` factory in `sandbox-factory.ts` remains the low-level way to create individual sandboxes. The pool wraps the factory:

```typescript
// Usage in pipeline execution:
import { createSandbox } from './sandbox-factory.js'
import { SandboxPool } from './pool/sandbox-pool.js'

const pool = new SandboxPool({
  factory: () => createSandbox({ provider: 'docker', docker: { image: 'node:20-slim' } }),
  minIdle: 2,
  maxActive: 8,
})
```

#### Reset Protocol

Between uses, a pooled sandbox must be cleaned to prevent data leakage between runs:

```typescript
// @dzipagent/codegen/src/sandbox/pool/sandbox-reset.ts

/**
 * Strategy for resetting a sandbox between pool uses.
 * Implementations vary by provider.
 */
export interface SandboxResetStrategy {
  /**
   * Reset the sandbox to a clean state.
   * Returns true if the sandbox is reusable, false if it should be destroyed.
   */
  reset(sandbox: SandboxProtocol): Promise<boolean>
}

/**
 * Docker reset: remove all files from /work, clear /tmp, verify responsiveness.
 */
export class DockerResetStrategy implements SandboxResetStrategy {
  async reset(sandbox: SandboxProtocol): Promise<boolean> {
    const result = await sandbox.execute(
      'rm -rf /work/* /work/.* /tmp/* 2>/dev/null; echo __RESET_OK__',
      { timeoutMs: 5_000 },
    )
    return result.exitCode === 0 && result.stdout.includes('__RESET_OK__')
  }
}

/**
 * E2B/Fly reset: destroy the sandbox entirely and create a fresh one.
 * Cloud sandboxes are cheap to recreate; resetting in-place risks state leaks.
 */
export class CloudResetStrategy implements SandboxResetStrategy {
  async reset(_sandbox: SandboxProtocol): Promise<boolean> {
    // Always destroy and recreate for cloud providers
    return false
  }
}
```

---

### F2: Kubernetes CRD (P2, 16h)

#### Problem

Organizations running DzipAgent in Kubernetes need declarative sandbox management that integrates with their existing infrastructure: RBAC, network policies, resource quotas, pod security, and observability. The current Docker-based sandbox bypasses K8s entirely, losing these benefits.

#### Design

An `AgentSandbox` Custom Resource Definition lets K8s manage sandbox lifecycle. A lightweight operator (reconciler) watches these CRDs and creates/monitors/cleans up pods. Pods can be configured with gVisor or Kata Containers runtime classes for defense-in-depth.

#### CRD Specification

```yaml
# k8s/crd/agent-sandbox.yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: agentsandboxes.forgeagent.dev
spec:
  group: forgeagent.dev
  versions:
    - name: v1alpha1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          required: [spec]
          properties:
            spec:
              type: object
              required: [image, securityLevel]
              properties:
                image:
                  type: string
                  description: "Container image for the sandbox pod"
                  default: "node:20-slim"
                securityLevel:
                  type: string
                  description: "Maps to SecurityLevel from security-profile.ts"
                  enum: [minimal, standard, strict, paranoid]
                  default: standard
                runtimeClass:
                  type: string
                  description: "K8s RuntimeClass name (e.g., gvisor, kata)"
                  enum: [runc, gvisor, kata]
                  default: gvisor
                resources:
                  type: object
                  properties:
                    cpu:
                      type: string
                      description: "CPU limit (e.g., '500m', '1')"
                      default: "500m"
                    memory:
                      type: string
                      description: "Memory limit (e.g., '256Mi', '1Gi')"
                      default: "512Mi"
                    ephemeralStorage:
                      type: string
                      description: "Ephemeral storage limit"
                      default: "1Gi"
                network:
                  type: object
                  properties:
                    allowEgress:
                      type: boolean
                      default: false
                    allowedDomains:
                      type: array
                      items:
                        type: string
                    dnsPolicy:
                      type: string
                      default: "None"
                volumes:
                  type: array
                  items:
                    type: object
                    required: [name, mountPath]
                    properties:
                      name:
                        type: string
                      mountPath:
                        type: string
                      readOnly:
                        type: boolean
                        default: true
                      claimName:
                        type: string
                        description: "PVC name for persistent volume"
                      emptyDir:
                        type: boolean
                        default: false
                      sizeLimit:
                        type: string
                runRef:
                  type: object
                  description: "Reference to the DzipAgent run that owns this sandbox"
                  properties:
                    runId:
                      type: string
                    agentId:
                      type: string
                    tenantId:
                      type: string
                ttlSeconds:
                  type: integer
                  description: "Auto-destroy after this many seconds (safety net)"
                  default: 600
                  minimum: 30
                  maximum: 3600
            status:
              type: object
              properties:
                phase:
                  type: string
                  enum: [Pending, Creating, Ready, Active, Draining, Completed, Failed]
                podName:
                  type: string
                podIP:
                  type: string
                startedAt:
                  type: string
                  format: date-time
                completedAt:
                  type: string
                  format: date-time
                message:
                  type: string
                conditions:
                  type: array
                  items:
                    type: object
                    properties:
                      type:
                        type: string
                      status:
                        type: string
                      lastTransitionTime:
                        type: string
                        format: date-time
                      reason:
                        type: string
                      message:
                        type: string
      subresources:
        status: {}
      additionalPrinterColumns:
        - name: Phase
          type: string
          jsonPath: .status.phase
        - name: Pod
          type: string
          jsonPath: .status.podName
        - name: Security
          type: string
          jsonPath: .spec.securityLevel
        - name: Runtime
          type: string
          jsonPath: .spec.runtimeClass
        - name: Age
          type: date
          jsonPath: .metadata.creationTimestamp
  scope: Namespaced
  names:
    plural: agentsandboxes
    singular: agentsandbox
    kind: AgentSandbox
    shortNames:
      - asb
```

#### Example CRD Instance

```yaml
# Example: strict sandbox for a code generation run
apiVersion: forgeagent.dev/v1alpha1
kind: AgentSandbox
metadata:
  name: run-a1b2c3d4-sandbox
  namespace: forgeagent
  labels:
    forgeagent.dev/run-id: a1b2c3d4
    forgeagent.dev/agent-id: codegen-agent
    forgeagent.dev/tenant-id: tenant-xyz
spec:
  image: node:20-slim
  securityLevel: strict
  runtimeClass: gvisor
  resources:
    cpu: "500m"
    memory: "512Mi"
    ephemeralStorage: "1Gi"
  network:
    allowEgress: false
    dnsPolicy: "None"
  volumes:
    - name: workspace
      mountPath: /work
      emptyDir: true
      sizeLimit: "500Mi"
    - name: project-cache
      mountPath: /cache
      readOnly: true
      claimName: project-cache-tenant-xyz
  runRef:
    runId: a1b2c3d4
    agentId: codegen-agent
    tenantId: tenant-xyz
  ttlSeconds: 300
```

#### Network Policy (auto-generated per sandbox)

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: asb-run-a1b2c3d4-netpol
  namespace: forgeagent
spec:
  podSelector:
    matchLabels:
      forgeagent.dev/run-id: a1b2c3d4
  policyTypes:
    - Ingress
    - Egress
  ingress: []  # Block all inbound
  egress: []   # Block all outbound (overridden if spec.network.allowEgress=true)
```

#### Operator Reconciler Design

```typescript
// @dzipagent/codegen/src/sandbox/k8s/operator-types.ts

/**
 * Type-safe representation of the AgentSandbox CRD for the operator.
 * NOT a runtime dependency -- the operator is a separate deployment.
 * These types are shared for building the K8sPodSandbox client.
 */

export interface AgentSandboxSpec {
  image: string
  securityLevel: 'minimal' | 'standard' | 'strict' | 'paranoid'
  runtimeClass: 'runc' | 'gvisor' | 'kata'
  resources: {
    cpu: string
    memory: string
    ephemeralStorage: string
  }
  network: {
    allowEgress: boolean
    allowedDomains?: string[]
    dnsPolicy: string
  }
  volumes: Array<{
    name: string
    mountPath: string
    readOnly: boolean
    claimName?: string
    emptyDir?: boolean
    sizeLimit?: string
  }>
  runRef?: {
    runId: string
    agentId: string
    tenantId: string
  }
  ttlSeconds: number
}

export type AgentSandboxPhase =
  | 'Pending'
  | 'Creating'
  | 'Ready'
  | 'Active'
  | 'Draining'
  | 'Completed'
  | 'Failed'

export interface AgentSandboxStatus {
  phase: AgentSandboxPhase
  podName?: string
  podIP?: string
  startedAt?: string
  completedAt?: string
  message?: string
  conditions: Array<{
    type: string
    status: 'True' | 'False' | 'Unknown'
    lastTransitionTime: string
    reason: string
    message: string
  }>
}

export interface AgentSandboxResource {
  apiVersion: 'forgeagent.dev/v1alpha1'
  kind: 'AgentSandbox'
  metadata: {
    name: string
    namespace: string
    labels: Record<string, string>
  }
  spec: AgentSandboxSpec
  status?: AgentSandboxStatus
}
```

#### Operator Reconcile Loop (pseudo-code)

```
WATCH AgentSandbox resources

ON create/update:
  1. If status.phase == "" or "Pending":
     a. Build Pod spec from AgentSandbox.spec
     b. Apply SecurityProfile (seccomp, apparmor, runtimeClass)
     c. Create NetworkPolicy if spec.network rules defined
     d. Create Pod
     e. Set status.phase = "Creating"

  2. If status.phase == "Creating":
     a. Check Pod status
     b. If Pod Running && ready: set status.phase = "Ready"
     c. If Pod Failed: set status.phase = "Failed", record error

  3. If status.phase in ["Ready", "Active"]:
     a. Check TTL: if now - startedAt > ttlSeconds, begin draining
     b. Check Pod health: if unresponsive, set "Failed"

  4. If status.phase == "Draining":
     a. Wait for active commands to finish (grace period: 30s)
     b. Delete Pod
     c. Delete NetworkPolicy
     d. Set status.phase = "Completed"

ON delete:
  1. Delete associated Pod (if exists)
  2. Delete associated NetworkPolicy (if exists)
  3. Release any PVC claims (if sandbox-scoped)
```

#### K8sPodSandbox Client

```typescript
// @dzipagent/codegen/src/sandbox/k8s/k8s-sandbox.ts

import type { SandboxProtocol, ExecResult, ExecOptions } from '../sandbox-protocol.js'
import type { AgentSandboxSpec, AgentSandboxPhase } from './operator-types.js'

export interface K8sSandboxConfig {
  /** Kubernetes API server URL (default: in-cluster) */
  apiServer?: string
  /** Namespace for sandbox resources (default: 'forgeagent') */
  namespace: string
  /** Service account token path or explicit token */
  token?: string
  /** Kubeconfig path for out-of-cluster usage */
  kubeconfig?: string
  /** Default sandbox spec (merged with per-call overrides) */
  defaults: Partial<AgentSandboxSpec>
  /** Timeout for sandbox creation in ms (default: 30_000) */
  createTimeoutMs?: number
  /** Timeout per command in ms (default: 60_000) */
  execTimeoutMs?: number
}

/**
 * SandboxProtocol implementation backed by Kubernetes pods.
 *
 * Creates an AgentSandbox CRD, waits for the operator to provision
 * a pod, then executes commands via `kubectl exec` or the K8s
 * exec API (WebSocket subprotocol).
 *
 * @example
 * ```ts
 * const sandbox = new K8sPodSandbox({
 *   namespace: 'forgeagent',
 *   defaults: {
 *     image: 'node:20-slim',
 *     securityLevel: 'strict',
 *     runtimeClass: 'gvisor',
 *     resources: { cpu: '500m', memory: '512Mi', ephemeralStorage: '1Gi' },
 *   },
 * })
 *
 * await sandbox.execute('npm test')
 * await sandbox.cleanup()
 * ```
 */
export class K8sPodSandbox implements SandboxProtocol {
  private resourceName: string | null = null
  private podName: string | null = null

  constructor(private readonly config: K8sSandboxConfig) {}

  async isAvailable(): Promise<boolean> {
    // Check: can we reach the K8s API and does the CRD exist?
    throw new Error('stub')
  }

  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    // 1. Create AgentSandbox CRD if not yet created
    // 2. Wait for status.phase == "Ready" (poll with backoff)
    // 3. Execute via K8s exec API (WebSocket to pod)
    // 4. Return ExecResult
    throw new Error('stub')
  }

  async uploadFiles(files: Record<string, string>): Promise<void> {
    // Use `kubectl cp` equivalent (tar stream to pod stdin)
    throw new Error('stub')
  }

  async downloadFiles(paths: string[]): Promise<Record<string, string>> {
    // Use `kubectl cp` equivalent (tar stream from pod stdout)
    throw new Error('stub')
  }

  async cleanup(): Promise<void> {
    // Delete the AgentSandbox CRD (operator handles pod + netpol cleanup)
    throw new Error('stub')
  }
}
```

---

### F3: Persistent Volumes (P1, 4h)

#### Problem

Sandboxes are ephemeral by default. When a pipeline needs to continue across sandbox restarts (e.g., fix-escalation after a sandbox crash) or share build caches across runs for the same tenant, there is no mechanism to persist data.

#### Design

Three volume types, each with a different lifecycle:

| Volume Type | Scope | Lifecycle | Use Case |
|-------------|-------|-----------|----------|
| `workspace` | Per-run | Created at run start, deleted at run end | Working directory for generated code |
| `cache` | Per-tenant | Created on first use, evicted by LRU | npm cache, build artifacts, node_modules |
| `temp` | Per-sandbox | Created at sandbox init, deleted at cleanup | Scratch space for intermediate files |

#### Interface Specification

```typescript
// @dzipagent/codegen/src/sandbox/volumes/volume-manager.ts

/**
 * Volume type determines lifecycle and sharing semantics.
 */
export type VolumeType = 'workspace' | 'cache' | 'temp'

/**
 * Descriptor for a volume to attach to a sandbox.
 */
export interface VolumeDescriptor {
  /** Unique name within the sandbox (e.g., 'project-workspace') */
  name: string

  /** Volume type determines lifecycle */
  type: VolumeType

  /** Mount path inside the sandbox container */
  mountPath: string

  /** Whether the mount is read-only inside the sandbox */
  readOnly: boolean

  /**
   * Maximum size of the volume.
   * Format: Docker-style (e.g., '500m', '2g') or K8s-style (e.g., '500Mi', '2Gi').
   */
  sizeLimit: string

  /**
   * Scope identifier for volume reuse.
   * - workspace: runId (unique per run)
   * - cache: tenantId (shared across runs for same tenant)
   * - temp: sandboxId (destroyed with sandbox)
   */
  scopeId: string
}

/**
 * Metadata about a provisioned volume.
 */
export interface VolumeInfo {
  /** Volume descriptor that created this volume */
  descriptor: VolumeDescriptor

  /** Actual host path or PVC name */
  hostRef: string

  /** Current usage in bytes (-1 if unknown) */
  usageBytes: number

  /** When the volume was created */
  createdAt: Date

  /** When the volume was last accessed */
  lastAccessedAt: Date
}

/**
 * Volume cleanup policy determines when volumes are destroyed.
 */
export interface VolumeCleanupPolicy {
  /** Maximum age before automatic cleanup (ms). Null = no age limit. */
  maxAgeMs: number | null

  /** Maximum total size across all volumes of this type (bytes). Null = no limit. */
  maxTotalBytes: number | null

  /** Maximum number of volumes of this type. Null = no limit. */
  maxCount: number | null

  /** Eviction strategy when limits are reached */
  evictionStrategy: 'lru' | 'lfu' | 'oldest-first'
}

/** Default cleanup policies per volume type. */
export const DEFAULT_CLEANUP_POLICIES: Record<VolumeType, VolumeCleanupPolicy> = {
  workspace: {
    maxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
    maxTotalBytes: null,
    maxCount: null,
    evictionStrategy: 'oldest-first',
  },
  cache: {
    maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    maxTotalBytes: 10 * 1024 * 1024 * 1024, // 10 GB total
    maxCount: 100,
    evictionStrategy: 'lru',
  },
  temp: {
    maxAgeMs: null, // destroyed with sandbox
    maxTotalBytes: null,
    maxCount: null,
    evictionStrategy: 'oldest-first',
  },
}

/**
 * Manages persistent volume lifecycle across sandbox executions.
 *
 * Implementations:
 * - DockerVolumeManager: uses Docker named volumes
 * - K8sVolumeManager: uses PersistentVolumeClaims
 * - InMemoryVolumeManager: uses temp directories (dev/test)
 *
 * @example
 * ```ts
 * const vm = new DockerVolumeManager()
 *
 * const workspace = await vm.provision({
 *   name: 'project-ws',
 *   type: 'workspace',
 *   mountPath: '/work',
 *   readOnly: false,
 *   sizeLimit: '500m',
 *   scopeId: 'run-abc123',
 * })
 *
 * // Attach to sandbox creation...
 *
 * // After run completes:
 * await vm.release('project-ws', 'run-abc123')
 * ```
 */
export interface VolumeManager {
  /**
   * Provision a volume. If a volume with the same (name, scopeId)
   * already exists (e.g., cache reuse), returns the existing one.
   */
  provision(descriptor: VolumeDescriptor): Promise<VolumeInfo>

  /**
   * Release a volume. For 'workspace' and 'temp', this triggers cleanup.
   * For 'cache', the volume persists until eviction.
   */
  release(name: string, scopeId: string): Promise<void>

  /** Destroy a volume immediately, regardless of type. */
  destroy(name: string, scopeId: string): Promise<void>

  /** List all managed volumes, optionally filtered by type. */
  list(filter?: { type?: VolumeType; scopeId?: string }): Promise<VolumeInfo[]>

  /**
   * Run cleanup sweep: evict volumes that exceed their cleanup policy.
   * Called periodically by the runtime manager.
   */
  sweep(policies?: Partial<Record<VolumeType, VolumeCleanupPolicy>>): Promise<number>

  /**
   * Convert volume descriptors into provider-specific mount arguments.
   * For Docker: returns `-v name:/path:ro` flags.
   * For K8s: returns volume/volumeMount YAML fragments.
   */
  toMountArgs(descriptors: VolumeDescriptor[]): Promise<string[]>
}
```

---

### F4: Resource Quotas (P1, 6h)

#### Problem

Multi-tenant deployments need per-tenant resource limits. Without quotas, a single tenant could monopolize all sandbox capacity, starving other tenants. The existing `SecurityProfile.resources` controls per-sandbox limits but has no aggregate enforcement.

#### Design

The `ResourceQuotaManager` operates as a reservation system. Before creating a sandbox, the runtime checks if the tenant has enough remaining quota. Reservations are held for the duration of sandbox use and released on completion.

#### Interface Specification

```typescript
// @dzipagent/server/src/runtime/resource-quota.ts

/**
 * Resource dimensions that can be quota-limited.
 */
export interface ResourceDimensions {
  /** CPU cores (fractional, e.g., 0.5 = half a core) */
  cpuCores: number
  /** Memory in megabytes */
  memoryMb: number
  /** Disk storage in megabytes */
  storageMb: number
  /** Number of concurrent sandboxes */
  sandboxCount: number
  /** Execution time budget in seconds per billing period */
  executionTimeSec: number
}

/**
 * Quota definition for a tenant or plan.
 */
export interface ResourceQuota {
  /** Unique quota identifier */
  id: string

  /** Tenant or plan this quota applies to */
  tenantId: string

  /** Maximum allowed resource usage (ceiling) */
  limits: ResourceDimensions

  /** Current usage (updated in real-time) */
  usage: ResourceDimensions

  /** Billing period start (for time-based quotas) */
  periodStart: Date

  /** Billing period end */
  periodEnd: Date
}

/**
 * A reservation holds resources for an in-progress operation.
 * Created by reserve(), released by release().
 */
export interface ResourceReservation {
  /** Unique reservation ID */
  id: string

  /** Tenant that owns this reservation */
  tenantId: string

  /** Run that triggered this reservation */
  runId: string

  /** Resources reserved */
  reserved: Partial<ResourceDimensions>

  /** When the reservation was created */
  createdAt: Date

  /** Auto-expire after this time (safety net for leaked reservations) */
  expiresAt: Date
}

/**
 * Result of a quota check.
 */
export type QuotaCheckResult =
  | { allowed: true }
  | {
      allowed: false
      reason: string
      dimensions: Array<{
        dimension: keyof ResourceDimensions
        requested: number
        available: number
        limit: number
      }>
    }

/**
 * What to do when a quota would be exceeded.
 */
export type QuotaOveragePolicy = 'reject' | 'queue' | 'alert-and-allow'

/**
 * Manages per-tenant resource quotas with a reservation-based model.
 *
 * The quota manager is injected into the sandbox pool and runtime manager
 * as a gating check before sandbox creation.
 *
 * Implementations:
 * - InMemoryQuotaManager: for dev/test (state lost on restart)
 * - PostgresQuotaManager: for production (Drizzle-backed, transactional)
 *
 * @example
 * ```ts
 * const qm = new InMemoryQuotaManager()
 *
 * // Set quota for a tenant
 * await qm.setQuota('tenant-xyz', {
 *   cpuCores: 4,
 *   memoryMb: 4096,
 *   storageMb: 10240,
 *   sandboxCount: 5,
 *   executionTimeSec: 3600,
 * })
 *
 * // Before creating a sandbox:
 * const check = await qm.check('tenant-xyz', {
 *   cpuCores: 0.5,
 *   memoryMb: 512,
 *   sandboxCount: 1,
 * })
 *
 * if (!check.allowed) {
 *   throw new QuotaExceededError(check)
 * }
 *
 * const reservation = await qm.reserve('tenant-xyz', 'run-abc', {
 *   cpuCores: 0.5,
 *   memoryMb: 512,
 *   sandboxCount: 1,
 * })
 *
 * // ... sandbox runs ...
 *
 * await qm.release(reservation.id)
 * ```
 */
export interface ResourceQuotaManager {
  /**
   * Set the resource quota for a tenant.
   * Creates or updates the quota record.
   */
  setQuota(tenantId: string, limits: ResourceDimensions): Promise<ResourceQuota>

  /**
   * Get the current quota and usage for a tenant.
   * Returns null if no quota is configured (unlimited).
   */
  getQuota(tenantId: string): Promise<ResourceQuota | null>

  /**
   * Check whether a requested allocation would fit within the tenant's quota.
   * Does NOT modify any state -- read-only check.
   */
  check(tenantId: string, requested: Partial<ResourceDimensions>): Promise<QuotaCheckResult>

  /**
   * Reserve resources for a run. Atomically increments usage counters.
   * Throws QuotaExceededError if the reservation would exceed limits.
   *
   * Reservations auto-expire after expiryMs (default: 1 hour) to prevent
   * leaked reservations from permanently consuming quota.
   */
  reserve(
    tenantId: string,
    runId: string,
    requested: Partial<ResourceDimensions>,
    expiryMs?: number,
  ): Promise<ResourceReservation>

  /**
   * Release a reservation, decrementing usage counters.
   * Safe to call multiple times (idempotent).
   */
  release(reservationId: string): Promise<void>

  /**
   * Get current usage summary for a tenant.
   */
  getUsage(tenantId: string): Promise<{
    quota: ResourceDimensions
    used: ResourceDimensions
    available: ResourceDimensions
    activeReservations: number
  }>

  /**
   * List all active reservations for a tenant.
   */
  listReservations(tenantId: string): Promise<ResourceReservation[]>

  /**
   * Sweep expired reservations. Called periodically by the runtime.
   * Returns the number of reservations released.
   */
  sweepExpired(): Promise<number>
}

/**
 * Error thrown when a quota check or reservation fails.
 */
export class QuotaExceededError extends Error {
  readonly name = 'QuotaExceededError' as const
  constructor(public readonly result: QuotaCheckResult & { allowed: false }) {
    super(`Quota exceeded: ${result.reason}`)
  }
}
```

#### Quota Drizzle Schema

```typescript
// Addition to @dzipagent/server/src/persistence/drizzle-schema.ts

export const forgeResourceQuotas = pgTable('forge_resource_quotas', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: varchar('tenant_id', { length: 255 }).notNull().unique(),
  limitCpuCores: real('limit_cpu_cores').notNull().default(4),
  limitMemoryMb: integer('limit_memory_mb').notNull().default(4096),
  limitStorageMb: integer('limit_storage_mb').notNull().default(10240),
  limitSandboxCount: integer('limit_sandbox_count').notNull().default(5),
  limitExecutionTimeSec: integer('limit_execution_time_sec').notNull().default(3600),
  usageCpuCores: real('usage_cpu_cores').notNull().default(0),
  usageMemoryMb: integer('usage_memory_mb').notNull().default(0),
  usageStorageMb: integer('usage_storage_mb').notNull().default(0),
  usageSandboxCount: integer('usage_sandbox_count').notNull().default(0),
  usageExecutionTimeSec: integer('usage_execution_time_sec').notNull().default(0),
  periodStart: timestamp('period_start').defaultNow().notNull(),
  periodEnd: timestamp('period_end').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const forgeResourceReservations = pgTable('forge_resource_reservations', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: varchar('tenant_id', { length: 255 }).notNull(),
  runId: uuid('run_id').references(() => forgeRuns.id),
  reservedCpuCores: real('reserved_cpu_cores').default(0),
  reservedMemoryMb: integer('reserved_memory_mb').default(0),
  reservedStorageMb: integer('reserved_storage_mb').default(0),
  reservedSandboxCount: integer('reserved_sandbox_count').default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  releasedAt: timestamp('released_at'),
})
```

---

### F5: WASM Sandbox (P3, 24h)

#### Problem

Docker and cloud VMs are heavyweight. For lightweight code validation tasks (type-checking, linting, running unit tests on small modules), startup overhead dominates actual execution time. WebAssembly sandboxes offer sub-millisecond startup, true portability (browser, edge, serverless), and capability-based security with no kernel dependency.

#### Design

The WASM sandbox targets a focused use case: running JavaScript/TypeScript tools (linters, formatters, simple test runners) in a WASI-compatible runtime. It does NOT attempt to replace Docker for full builds or heavy compilation. The sandbox uses a capability-based security model where each capability (file read, file write, env vars, clock) must be explicitly granted.

#### Interface Specification

```typescript
// @dzipagent/codegen/src/sandbox/wasm/wasm-sandbox.ts

import type { SandboxProtocol, ExecResult, ExecOptions } from '../sandbox-protocol.js'

/**
 * WASI capabilities that can be granted to the WASM sandbox.
 * Each capability is opt-in; ungrated capabilities throw errors at runtime.
 */
export type WasiCapability =
  | 'fs-read'       // Read files from the virtual filesystem
  | 'fs-write'      // Write files to the virtual filesystem
  | 'env'           // Access environment variables
  | 'clock'         // Access monotonic and wall clocks
  | 'random'        // Access cryptographic random
  | 'stdout'        // Write to stdout
  | 'stderr'        // Write to stderr
  | 'stdin'         // Read from stdin

/**
 * Configuration for the WASM sandbox.
 */
export interface WasmSandboxConfig {
  /**
   * Path to the WASM module to execute.
   * Typically a pre-compiled QuickJS or wasm-node binary.
   */
  wasmModulePath: string

  /**
   * Granted WASI capabilities.
   * Default: ['fs-read', 'fs-write', 'stdout', 'stderr', 'clock', 'random']
   */
  capabilities: WasiCapability[]

  /**
   * Maximum memory pages (64KB each) for the WASM instance.
   * Default: 256 (= 16MB)
   */
  maxMemoryPages: number

  /**
   * Maximum execution time in milliseconds.
   * Enforced via fuel metering (instruction count limit).
   * Default: 10_000
   */
  timeoutMs: number

  /**
   * Pre-loaded files available in the virtual filesystem.
   * Keys are paths, values are file contents.
   */
  preloadFiles?: Record<string, string>

  /**
   * Environment variables available to the WASM module.
   */
  env?: Record<string, string>
}

/**
 * Lightweight WebAssembly-based sandbox for fast code analysis tasks.
 *
 * Uses WASI (WebAssembly System Interface) for filesystem and I/O access.
 * Security is enforced through capability-based permissions -- the WASM module
 * can only access resources that were explicitly granted at construction time.
 *
 * Best for:
 * - Type checking (via bundled tsc as WASM)
 * - Linting (ESLint compiled to WASM or QuickJS-based)
 * - Formatting (Prettier compiled to WASM)
 * - Simple test execution (QuickJS runtime)
 *
 * NOT suitable for:
 * - npm install / package management
 * - Docker builds
 * - Network-dependent operations
 * - Native module compilation
 *
 * @example
 * ```ts
 * const sandbox = new WasmSandbox({
 *   wasmModulePath: '/path/to/quickjs.wasm',
 *   capabilities: ['fs-read', 'fs-write', 'stdout', 'stderr'],
 *   maxMemoryPages: 512,
 *   timeoutMs: 5_000,
 * })
 *
 * await sandbox.uploadFiles({ 'index.ts': 'const x: number = "oops"' })
 * const result = await sandbox.execute('tsc --noEmit index.ts')
 * // result.exitCode === 1, result.stderr contains type error
 * ```
 */
export class WasmSandbox implements SandboxProtocol {
  constructor(config: Partial<WasmSandboxConfig>) {}

  async isAvailable(): Promise<boolean> {
    // Check: is the WASM runtime (e.g., wasmtime, wasmer, or Node WASI) available?
    throw new Error('stub')
  }

  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    // 1. Instantiate WASM module with capabilities
    // 2. Set up virtual filesystem from uploaded files
    // 3. Execute command string via the JS runtime inside WASM
    // 4. Enforce timeout via fuel metering
    // 5. Collect stdout/stderr
    // 6. Return ExecResult
    throw new Error('stub')
  }

  async uploadFiles(files: Record<string, string>): Promise<void> {
    // Add files to the in-memory virtual filesystem
    throw new Error('stub')
  }

  async downloadFiles(paths: string[]): Promise<Record<string, string>> {
    // Read files from the in-memory virtual filesystem
    throw new Error('stub')
  }

  async cleanup(): Promise<void> {
    // Drop the WASM instance and release memory
    throw new Error('stub')
  }
}
```

#### WASM Module Selection

| Runtime | Startup | Memory | JS Support | Maturity |
|---------|---------|--------|------------|----------|
| QuickJS (compiled to WASM) | <1ms | ~2MB | ES2023 | High |
| wasm-node (experimental) | ~5ms | ~8MB | Full Node APIs | Low |
| Javy (Shopify) | <1ms | ~1MB | ES2020 | Medium |

**Recommendation:** Start with QuickJS compiled to WASM via javy or quickjs-emscripten. It provides ES2023 support in <1ms startup with ~2MB memory. TypeScript support comes via a bundled esbuild-wasm or swc-wasm for transpilation before execution.

---

### F6: Agent Hot-Reload (P2, 8h)

#### Problem

During development, changing agent instructions, prompts, or tool configurations requires a full server restart. In production, deploying updated agent definitions should not cause downtime or interrupt running executions.

#### Design

Hot-reload operates at two levels:
1. **Development mode:** File watcher detects changes to agent definition files and re-registers them
2. **Production mode:** API endpoint accepts updated agent definitions; active runs continue with the old version while new runs use the updated definition

#### Interface Specification

```typescript
// @dzipagent/server/src/runtime/hot-reload.ts

/**
 * Version metadata for a loaded agent definition.
 */
export interface LoadedAgentVersion {
  /** Agent identifier */
  agentId: string
  /** Monotonically increasing version number */
  version: number
  /** Hash of the agent definition for change detection */
  contentHash: string
  /** When this version was loaded */
  loadedAt: Date
  /** Source of the definition (file path, API, database) */
  source: string
}

/**
 * Configuration for the hot-reload system.
 */
export interface HotReloadConfig {
  /**
   * Enable file watching for development mode.
   * Watches the specified directories for .ts/.json agent definitions.
   * @default false
   */
  watchEnabled: boolean

  /**
   * Directories to watch for agent definition changes.
   * Only used when watchEnabled is true.
   */
  watchPaths?: string[]

  /**
   * Debounce interval in ms for file change events.
   * Prevents rapid reloads during multi-file saves.
   * @default 500
   */
  debounceMs: number

  /**
   * Maximum number of previous versions to keep in memory.
   * Active runs reference their version; old versions are kept until
   * all runs using them complete.
   * @default 5
   */
  maxRetainedVersions: number

  /**
   * Callback invoked after a successful reload.
   */
  onReload?: (version: LoadedAgentVersion) => void

  /**
   * Callback invoked when a reload fails.
   */
  onReloadError?: (agentId: string, error: Error) => void
}

/**
 * Result of a reload operation.
 */
export type ReloadResult =
  | { status: 'updated'; version: LoadedAgentVersion }
  | { status: 'unchanged'; reason: string }
  | { status: 'failed'; error: string }

/**
 * Manages agent definition hot-reload for zero-downtime updates.
 *
 * Version safety: running executions pin to the version they started with.
 * New runs always use the latest version. Old versions are garbage-collected
 * when no active runs reference them.
 *
 * @example
 * ```ts
 * // Development: watch files
 * const reloader = new AgentHotReloader({
 *   watchEnabled: true,
 *   watchPaths: ['./agents/'],
 *   onReload: (v) => console.log(`Reloaded ${v.agentId} v${v.version}`),
 * })
 * await reloader.start()
 *
 * // Production: API-driven reload
 * const result = await reloader.reload('codegen-agent', newDefinition)
 *
 * // Rollback to previous version
 * await reloader.rollback('codegen-agent')
 * ```
 */
export class AgentHotReloader {
  constructor(
    private readonly config: HotReloadConfig,
    private readonly agentStore: AgentStore,
    private readonly eventBus: DzipEventBus,
  ) {}

  /**
   * Start the hot-reload system.
   * If watchEnabled, begins watching files for changes.
   */
  async start(): Promise<void> {}

  /**
   * Stop the hot-reload system.
   * Closes file watchers and cancels pending debounce timers.
   */
  async stop(): Promise<void> {}

  /**
   * Manually trigger a reload for a specific agent.
   * Used by the production API endpoint.
   *
   * The definition is validated, versioned, and stored.
   * If validation fails, the reload is rejected and the previous version remains active.
   */
  async reload(agentId: string, definition: AgentDefinition): Promise<ReloadResult> {
    throw new Error('stub')
  }

  /**
   * Roll back an agent to its previous version.
   * Returns the version that was restored.
   */
  async rollback(agentId: string): Promise<ReloadResult> {
    throw new Error('stub')
  }

  /**
   * Get the currently active version for an agent.
   */
  getActiveVersion(agentId: string): LoadedAgentVersion | undefined {
    throw new Error('stub')
  }

  /**
   * Get all retained versions for an agent (newest first).
   */
  getVersionHistory(agentId: string): LoadedAgentVersion[] {
    throw new Error('stub')
  }
}
```

#### API Endpoint

```typescript
// Addition to @dzipagent/server/src/routes/agents.ts

// POST /api/agents/:id/reload
// Triggers a hot-reload of the agent definition.
// Body: { instructions?: string, tools?: string[], guardrails?: GuardrailConfig }
// Response: ReloadResult

// POST /api/agents/:id/rollback
// Rolls back to the previous version.
// Response: ReloadResult

// GET /api/agents/:id/versions
// Lists all retained versions with metadata.
// Response: LoadedAgentVersion[]
```

---

### F7: Sandbox Audit Logging (P1, 4h)

#### Problem

For compliance, debugging, and security review, organizations need a tamper-resistant record of everything that happened inside a sandbox: every command executed, every file modified, every network request attempted. The current sandbox implementations log nothing.

#### Design

The audit logger wraps any `SandboxProtocol` as a decorator (proxy pattern). It intercepts all method calls, records them with timestamps and results, and writes entries to a pluggable store. The decorator approach means zero changes to existing sandbox implementations.

#### Interface Specification

```typescript
// @dzipagent/codegen/src/sandbox/audit/audit-types.ts

/**
 * Categories of auditable sandbox actions.
 */
export type AuditAction =
  | 'execute'
  | 'upload_files'
  | 'download_files'
  | 'cleanup'
  | 'health_check'

/**
 * Single audit log entry for a sandbox operation.
 */
export interface AuditEntry {
  /** Unique entry ID */
  id: string

  /** Timestamp of the operation */
  timestamp: Date

  /** Sandbox instance identifier */
  sandboxId: string

  /** DzipAgent run that owns this sandbox */
  runId: string

  /** Tenant that owns the run */
  tenantId: string

  /** The type of operation */
  action: AuditAction

  /**
   * Operation-specific details.
   * Structured differently per action type.
   */
  details: AuditExecuteDetails | AuditFileDetails | AuditCleanupDetails

  /**
   * Result of the operation.
   * Null if the operation is still in progress.
   */
  result: AuditResult | null

  /** Duration of the operation in milliseconds */
  durationMs: number

  /**
   * SHA-256 hash of the previous entry (chain integrity).
   * Null for the first entry in a sandbox's audit trail.
   */
  previousHash: string | null

  /** SHA-256 hash of this entry's content (for tamper detection) */
  entryHash: string
}

export interface AuditExecuteDetails {
  type: 'execute'
  command: string
  /** Command with secrets redacted */
  redactedCommand: string
  cwd?: string
  timeoutMs?: number
}

export interface AuditFileDetails {
  type: 'upload' | 'download'
  /** File paths (not contents, to limit log size) */
  paths: string[]
  /** Total bytes transferred */
  totalBytes: number
}

export interface AuditCleanupDetails {
  type: 'cleanup'
}

export type AuditResult =
  | { status: 'success'; exitCode?: number; outputBytes: number }
  | { status: 'error'; error: string }
  | { status: 'timeout' }

/**
 * Filter criteria for searching audit logs.
 */
export interface AuditFilter {
  sandboxId?: string
  runId?: string
  tenantId?: string
  action?: AuditAction
  startTime?: Date
  endTime?: Date
  /** Limit results (default: 100) */
  limit?: number
  /** Offset for pagination */
  offset?: number
}

/**
 * Storage backend for audit entries.
 *
 * Implementations:
 * - InMemoryAuditStore: for testing
 * - PostgresAuditStore: for production (append-only table)
 * - FileAuditStore: for single-node deployments (JSONL files)
 */
export interface AuditStore {
  /** Append an entry to the audit log. Must be idempotent on entry.id. */
  append(entry: AuditEntry): Promise<void>

  /** Query audit entries with filters. Returns newest first. */
  query(filter: AuditFilter): Promise<AuditEntry[]>

  /**
   * Verify the integrity of the hash chain for a sandbox's audit trail.
   * Returns the first broken link, or null if the chain is intact.
   */
  verifyChain(sandboxId: string): Promise<{
    valid: boolean
    brokenAt?: string  // entry ID where chain broke
  }>
}
```

#### Audited Sandbox Decorator

```typescript
// @dzipagent/codegen/src/sandbox/audit/audited-sandbox.ts

import type { SandboxProtocol, ExecResult, ExecOptions } from '../sandbox-protocol.js'
import type { AuditStore, AuditEntry } from './audit-types.js'

/**
 * Configuration for the audited sandbox wrapper.
 */
export interface AuditedSandboxConfig {
  /** The underlying sandbox to wrap */
  sandbox: SandboxProtocol

  /** Audit log storage backend */
  store: AuditStore

  /** Sandbox instance ID (for correlating entries) */
  sandboxId: string

  /** Run ID that owns this sandbox */
  runId: string

  /** Tenant ID for the run */
  tenantId: string

  /**
   * Patterns to redact from command strings before logging.
   * Matches are replaced with '***REDACTED***'.
   * @default [/(?:api[_-]?key|token|secret|password|auth)\s*[:=]\s*\S+/gi]
   */
  redactPatterns?: RegExp[]

  /**
   * Whether to log file contents in upload/download operations.
   * When false (default), only file paths and sizes are recorded.
   * @default false
   */
  logFileContents?: boolean
}

/**
 * Decorator that wraps a SandboxProtocol with audit logging.
 *
 * Every method call on the underlying sandbox is intercepted, timed,
 * and recorded in the audit store. Entries form a hash chain for
 * tamper detection.
 *
 * The decorator is transparent: it implements SandboxProtocol identically
 * and passes all calls through to the wrapped sandbox.
 *
 * @example
 * ```ts
 * const rawSandbox = new DockerSandbox({ image: 'node:20-slim' })
 * const auditedSandbox = new AuditedSandbox({
 *   sandbox: rawSandbox,
 *   store: new PostgresAuditStore(db),
 *   sandboxId: 'sbx-abc123',
 *   runId: 'run-xyz',
 *   tenantId: 'tenant-001',
 * })
 *
 * // Use auditedSandbox exactly like a regular sandbox
 * await auditedSandbox.execute('npm test')
 *
 * // Later: query the audit trail
 * const entries = await store.query({ runId: 'run-xyz' })
 * ```
 */
export class AuditedSandbox implements SandboxProtocol {
  constructor(private readonly config: AuditedSandboxConfig) {}

  async isAvailable(): Promise<boolean> {
    throw new Error('stub')
  }

  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    // 1. Record start time
    // 2. Redact command for logging
    // 3. Call inner sandbox.execute()
    // 4. Build AuditEntry with duration, result, hash chain
    // 5. Append to store (non-blocking, fire-and-forget with error logging)
    // 6. Return original result
    throw new Error('stub')
  }

  async uploadFiles(files: Record<string, string>): Promise<void> {
    throw new Error('stub')
  }

  async downloadFiles(paths: string[]): Promise<Record<string, string>> {
    throw new Error('stub')
  }

  async cleanup(): Promise<void> {
    throw new Error('stub')
  }
}
```

#### Audit Drizzle Schema

```typescript
// Addition to @dzipagent/server/src/persistence/drizzle-schema.ts

export const forgeSandboxAuditLog = pgTable('forge_sandbox_audit_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  sandboxId: varchar('sandbox_id', { length: 255 }).notNull(),
  runId: uuid('run_id').references(() => forgeRuns.id),
  tenantId: varchar('tenant_id', { length: 255 }).notNull(),
  action: varchar('action', { length: 30 }).notNull(),
  details: jsonb('details').notNull(),
  result: jsonb('result'),
  durationMs: integer('duration_ms').notNull(),
  previousHash: varchar('previous_hash', { length: 64 }),
  entryHash: varchar('entry_hash', { length: 64 }).notNull(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
})
```

#### REST API Endpoints

```
GET    /api/runs/:id/audit           List audit entries for a run
GET    /api/sandboxes/:id/audit      List audit entries for a sandbox
GET    /api/audit/verify/:sandboxId  Verify hash chain integrity
GET    /api/tenants/:id/audit        List audit entries for a tenant (admin)
```

---

### F8: Multi-Sandbox Orchestration (P2, 8h)

#### Problem

Complex pipelines may need different sandbox environments for different phases: a Node.js sandbox for building, a Python sandbox for ML model evaluation, a lightweight sandbox for linting. Currently, each pipeline step creates/destroys its own sandbox sequentially. There is no coordination, no shared state, and no parallel execution.

#### Design

The `SandboxOrchestrator` manages a directed acyclic graph (DAG) of sandbox tasks. Each task runs in its own sandbox and can depend on outputs from other tasks. Tasks without dependencies execute in parallel. Shared data flows through read-only volume mounts.

#### Interface Specification

```typescript
// @dzipagent/codegen/src/sandbox/orchestration/sandbox-orchestrator.ts

import type { SandboxProtocol, ExecResult } from '../sandbox-protocol.js'
import type { SandboxFactoryConfig } from '../sandbox-factory.js'
import type { VolumeDescriptor } from '../volumes/volume-manager.js'

/**
 * A single task in the sandbox orchestration DAG.
 */
export interface SandboxTask {
  /** Unique task identifier within the orchestration */
  id: string

  /** Human-readable label for logging */
  label: string

  /**
   * Sandbox configuration for this task.
   * Each task can use a different provider, image, and security level.
   */
  sandboxConfig: SandboxFactoryConfig

  /**
   * Commands to execute in the sandbox, in order.
   */
  commands: string[]

  /**
   * IDs of tasks that must complete before this task can start.
   * The outputs of dependency tasks are available as read-only mounts.
   */
  dependsOn: string[]

  /**
   * Files to extract from this sandbox's workspace after execution.
   * These become available to dependent tasks as read-only mounts.
   */
  outputPaths: string[]

  /**
   * Additional volumes to mount (beyond auto-injected dependency outputs).
   */
  volumes?: VolumeDescriptor[]

  /**
   * Maximum time for this task in milliseconds.
   * @default 120_000
   */
  timeoutMs?: number
}

/**
 * Result of a single task execution.
 */
export interface SandboxTaskResult {
  taskId: string
  status: 'success' | 'failed' | 'skipped' | 'timeout'
  /** Results from each command execution, in order */
  execResults: ExecResult[]
  /** Files extracted from the sandbox (per outputPaths) */
  outputs: Record<string, string>
  /** Wall-clock duration in ms */
  durationMs: number
  /** Error message if status is 'failed' */
  error?: string
}

/**
 * Aggregate result of the full orchestration.
 */
export interface OrchestrationResult {
  /** Overall status (failed if any required task failed) */
  status: 'success' | 'partial' | 'failed'
  /** Results per task, keyed by task ID */
  tasks: Record<string, SandboxTaskResult>
  /** Total wall-clock time including parallelism */
  totalDurationMs: number
  /** Execution order (topological sort of the DAG) */
  executionOrder: string[][]  // Array of parallel groups
}

/**
 * Configuration for the sandbox orchestrator.
 */
export interface OrchestratorConfig {
  /**
   * Maximum number of sandboxes running in parallel.
   * @default 4
   */
  maxParallel: number

  /**
   * What to do when a task fails.
   * - 'abort': Cancel all remaining tasks immediately
   * - 'skip-dependents': Skip tasks that depend on the failed task
   * - 'continue': Run all tasks that can run (ignore failures)
   * @default 'skip-dependents'
   */
  failurePolicy: 'abort' | 'skip-dependents' | 'continue'

  /**
   * Total orchestration timeout in ms.
   * @default 600_000
   */
  totalTimeoutMs: number
}

/**
 * Coordinates multiple sandbox tasks with dependency ordering
 * and parallel execution.
 *
 * @example
 * ```ts
 * const orchestrator = new SandboxOrchestrator({ maxParallel: 3 })
 *
 * const result = await orchestrator.execute([
 *   {
 *     id: 'install',
 *     label: 'Install dependencies',
 *     sandboxConfig: { provider: 'docker', docker: { image: 'node:20' } },
 *     commands: ['npm ci'],
 *     dependsOn: [],
 *     outputPaths: ['node_modules/'],
 *   },
 *   {
 *     id: 'lint',
 *     label: 'Run linter',
 *     sandboxConfig: { provider: 'docker', docker: { image: 'node:20-slim' } },
 *     commands: ['npx eslint src/'],
 *     dependsOn: ['install'],
 *     outputPaths: [],
 *   },
 *   {
 *     id: 'test',
 *     label: 'Run tests',
 *     sandboxConfig: { provider: 'docker', docker: { image: 'node:20' } },
 *     commands: ['npm test'],
 *     dependsOn: ['install'],
 *     outputPaths: ['coverage/'],
 *   },
 *   {
 *     id: 'build',
 *     label: 'Build project',
 *     sandboxConfig: { provider: 'docker', docker: { image: 'node:20' } },
 *     commands: ['npm run build'],
 *     dependsOn: ['lint', 'test'],
 *     outputPaths: ['dist/'],
 *   },
 * ])
 *
 * // 'install' runs first, then 'lint' and 'test' run in parallel,
 * // then 'build' runs after both complete.
 * ```
 */
export class SandboxOrchestrator {
  constructor(config?: Partial<OrchestratorConfig>) {}

  /**
   * Execute a set of sandbox tasks respecting dependency ordering.
   *
   * 1. Validate the task graph (check for cycles, missing dependencies)
   * 2. Compute topological sort with parallelism groups
   * 3. For each group, launch tasks in parallel (up to maxParallel)
   * 4. Pass outputs from completed tasks as read-only mounts to dependents
   * 5. Handle failures per the configured failurePolicy
   */
  async execute(tasks: SandboxTask[]): Promise<OrchestrationResult> {
    throw new Error('stub')
  }

  /**
   * Validate a task graph without executing it.
   * Returns errors if cycles, missing dependencies, or invalid configs are found.
   */
  validate(tasks: SandboxTask[]): {
    valid: boolean
    errors: string[]
    executionPlan: string[][] // parallel groups
  } {
    throw new Error('stub')
  }

  /**
   * Cancel all running tasks. Active sandboxes are cleaned up.
   */
  async cancel(): Promise<void> {}
}
```

---

## 3. Data Models

### 3.1 Pool State Machine (F1)

```
State transitions for a pooled sandbox:

  [start] --factory()-->  creating
  creating --init ok-->   idle       (added to idle queue)
  creating --init fail--> destroyed  (discarded)
  idle     --acquire()--> active     (removed from idle queue)
  idle     --evict()-->   draining   (idle too long)
  active   --release()--> idle       (after reset, back to idle queue)
  active   --release()--> destroyed  (reset failed)
  active   --evict()-->   draining   (forced eviction)
  draining --cleanup()--> destroyed  (final state)
```

### 3.2 K8s CRD Status Conditions (F2)

| Condition Type | Status | Meaning |
|---------------|--------|---------|
| `PodCreated` | True/False | Whether the sandbox pod has been created |
| `PodReady` | True/False | Whether the pod has passed readiness checks |
| `NetworkPolicyApplied` | True/False | Whether the network policy is active |
| `TTLExpired` | True/False | Whether the sandbox exceeded its TTL |
| `Cleaned` | True/False | Whether resources have been cleaned up |

### 3.3 Quota Tracking Schema (F4)

See the Drizzle schema in [F4](#quota-drizzle-schema). The key invariant is:

```
usage[dimension] = SUM(active_reservations[dimension])
```

This is maintained transactionally: `reserve()` increments usage and inserts a reservation row in a single transaction. `release()` decrements usage and sets `releasedAt` in a single transaction.

### 3.4 Audit Log Schema (F7)

See the Drizzle schema in [F7](#audit-drizzle-schema). The key integrity property is the hash chain:

```
entry[n].entryHash = SHA-256(
  entry[n].sandboxId +
  entry[n].timestamp.toISOString() +
  entry[n].action +
  JSON.stringify(entry[n].details) +
  JSON.stringify(entry[n].result) +
  entry[n].previousHash
)

entry[n].previousHash = entry[n-1].entryHash
entry[0].previousHash = null
```

Verifying the chain: iterate from oldest to newest, recompute each hash, and compare. A mismatch indicates tampering.

---

## 4. Deployment Topologies

### 4.1 Single-Node (Docker Compose)

The simplest deployment: one host running the DzipAgent server with Docker sandboxes.

```yaml
# docker-compose.yml
version: '3.8'
services:
  forgeagent:
    build: .
    ports:
      - "3001:3001"
    environment:
      - DATABASE_URL=postgres://forge:forge@db:5432/forgeagent
      - SANDBOX_PROVIDER=docker
      - SANDBOX_POOL_MIN_IDLE=2
      - SANDBOX_POOL_MAX_ACTIVE=5
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # Docker-in-Docker
      - sandbox-cache:/var/forge/cache
    depends_on:
      - db

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: forgeagent
      POSTGRES_USER: forge
      POSTGRES_PASSWORD: forge
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
  sandbox-cache:
```

**Sandbox provider:** DockerSandbox via Docker socket mount.

**Limitations:**
- Single point of failure
- No horizontal scaling
- Docker socket mount is a security concern (mitigate with Docker-in-Docker or sysbox)

### 4.2 Kubernetes Cluster

Full production deployment with the K8s CRD operator.

```
┌─────────────────────────────────────────────────┐
│                K8s Cluster                       │
│                                                  │
│  ┌──────────────┐  ┌──────────────┐             │
│  │ DzipAgent   │  │ DzipAgent   │  (replicas) │
│  │ Server Pod   │  │ Server Pod   │             │
│  └──────┬───────┘  └──────┬───────┘             │
│         │                  │                     │
│         └──────┬───────────┘                     │
│                │ K8s API                         │
│                ▼                                 │
│  ┌──────────────────────┐                        │
│  │ AgentSandbox         │                        │
│  │ Operator             │                        │
│  │ (watches CRDs,       │                        │
│  │  manages pods)       │                        │
│  └──────────┬───────────┘                        │
│             │ creates                            │
│             ▼                                    │
│  ┌─────────────┐ ┌─────────────┐                │
│  │ Sandbox Pod │ │ Sandbox Pod │  (gVisor/Kata) │
│  │ (node:20)   │ │ (python:3)  │                │
│  └─────────────┘ └─────────────┘                │
│                                                  │
│  ┌──────────────┐  ┌──────────────┐             │
│  │ PostgreSQL   │  │ Redis        │             │
│  │ (runs, quota,│  │ (run queue,  │             │
│  │  audit logs) │  │  sessions)   │             │
│  └──────────────┘  └──────────────┘             │
└─────────────────────────────────────────────────┘
```

**Sandbox provider:** K8sPodSandbox via AgentSandbox CRDs.

**Advantages:**
- Native resource quotas via K8s ResourceQuota + DzipAgent's quota manager
- Network policies enforced at the CNI level
- gVisor/Kata for VM-level isolation
- Horizontal scaling of server pods
- Persistent volumes via K8s PVCs

### 4.3 Serverless (Lambda/Vercel/Cloudflare)

The DzipAgent server runs as a serverless function. Sandboxes run in E2B or Fly.io.

```
┌──────────────┐     ┌──────────────┐
│ API Gateway  │────►│ Lambda/      │
│ (HTTP)       │     │ Vercel/CF    │
└──────────────┘     │ Function     │
                     │ (DzipAgent  │
                     │  server)     │
                     └──────┬───────┘
                            │ REST API
                     ┌──────┴───────┐
                     ▼              ▼
              ┌────────────┐ ┌────────────┐
              │ E2B Cloud  │ │ Fly.io     │
              │ Sandbox    │ │ Machine    │
              │ (microVM)  │ │ (VM)       │
              └────────────┘ └────────────┘
```

**Sandbox providers:** E2BSandbox or FlySandbox.

**Limitations:**
- No sandbox pooling (serverless functions are stateless)
- Higher per-request latency (cold starts on both function and sandbox)
- External database required for persistence

**Adaptation:** Use the existing `toLambdaHandler()`, `toVercelHandler()`, and `toCloudflareHandler()` platform adapters. The sandbox pool is disabled (pool size = 0); sandboxes are created per-request.

### 4.4 Hybrid (Server + Cloud Overflow)

Local Docker sandboxes handle baseline load; overflow spills to E2B or Fly.io.

```typescript
// Example hybrid pool configuration
import { SandboxPool } from '@dzipagent/codegen'

const localPool = new SandboxPool({
  factory: () => createSandbox({ provider: 'docker' }),
  minIdle: 3,
  maxActive: 5,
  maxWaitMs: 0, // Don't wait, overflow immediately
})

const cloudPool = new SandboxPool({
  factory: () => createSandbox({ provider: 'e2b', e2b: { apiKey: '...' } }),
  minIdle: 0,  // No pre-warming for cloud (pay per use)
  maxActive: 20,
  maxWaitMs: 10_000,
})

// Acquire with fallback:
async function acquireSandbox(): Promise<SandboxProtocol> {
  try {
    return await localPool.acquire()
  } catch {
    // Local pool exhausted, fall back to cloud
    return await cloudPool.acquire()
  }
}
```

---

## 5. File Structure

### 5.1 Changes to `@dzipagent/codegen`

```
packages/forgeagent-codegen/src/sandbox/
├── sandbox-protocol.ts          # (existing) No changes
├── docker-sandbox.ts            # (existing) No changes
├── e2b-sandbox.ts               # (existing) No changes
├── fly-sandbox.ts               # (existing) No changes
├── mock-sandbox.ts              # (existing) No changes
├── permission-tiers.ts          # (existing) No changes
├── security-profile.ts          # (existing) No changes
├── sandbox-factory.ts           # (existing) Add 'k8s' and 'wasm' providers
│
├── pool/                        # NEW (F1)
│   ├── sandbox-pool.ts          # SandboxPool class
│   ├── sandbox-reset.ts         # Reset strategies per provider
│   └── pool-metrics.ts          # Metrics collection helpers
│
├── k8s/                         # NEW (F2)
│   ├── operator-types.ts        # AgentSandbox CRD types
│   ├── k8s-sandbox.ts           # K8sPodSandbox implements SandboxProtocol
│   └── k8s-client.ts            # Minimal K8s API client (no kubectl dep)
│
├── wasm/                        # NEW (F5)
│   ├── wasm-sandbox.ts          # WasmSandbox implements SandboxProtocol
│   ├── wasi-fs.ts               # In-memory WASI filesystem
│   └── capability-guard.ts      # Capability enforcement
│
├── volumes/                     # NEW (F3)
│   ├── volume-manager.ts        # VolumeManager interface + types
│   ├── docker-volume-manager.ts # Docker named volumes
│   ├── k8s-volume-manager.ts    # K8s PVC management
│   └── memory-volume-manager.ts # Temp dir based (dev/test)
│
├── audit/                       # NEW (F7)
│   ├── audit-types.ts           # AuditEntry, AuditStore, AuditFilter
│   ├── audited-sandbox.ts       # Decorator wrapping SandboxProtocol
│   ├── memory-audit-store.ts    # In-memory store (testing)
│   └── file-audit-store.ts      # JSONL file store (single-node)
│
└── orchestration/               # NEW (F8)
    ├── sandbox-orchestrator.ts  # SandboxOrchestrator class
    ├── task-graph.ts            # DAG validation + topological sort
    └── output-bridge.ts         # File transfer between sandboxes
```

### 5.2 Changes to `@dzipagent/server`

```
packages/forgeagent-server/src/
├── runtime/                     # NEW
│   ├── resource-quota.ts        # ResourceQuotaManager interface (F4)
│   ├── memory-quota-manager.ts  # InMemoryQuotaManager (F4)
│   ├── postgres-quota-manager.ts# PostgresQuotaManager (F4)
│   ├── hot-reload.ts            # AgentHotReloader (F6)
│   └── runtime-manager.ts       # Ties pool + quota + audit together
│
├── persistence/
│   └── drizzle-schema.ts        # (existing) Add quota + audit tables
│
├── routes/
│   ├── agents.ts                # (existing) Add reload/rollback endpoints
│   └── audit.ts                 # NEW: audit log query endpoints
│
└── ...
```

### 5.3 K8s Operator (Separate Deployment)

The K8s operator is a standalone deployment, NOT bundled in `@dzipagent/codegen`. It is published as a separate Docker image and Helm chart.

```
k8s/
├── crd/
│   └── agent-sandbox.yaml       # CRD definition
├── operator/
│   ├── src/
│   │   ├── reconciler.ts        # Main reconcile loop
│   │   ├── pod-builder.ts       # Build pod spec from AgentSandboxSpec
│   │   ├── netpol-builder.ts    # Build NetworkPolicy from spec
│   │   └── index.ts             # Operator entrypoint
│   ├── Dockerfile
│   └── package.json
├── helm/
│   └── forgeagent-operator/
│       ├── Chart.yaml
│       ├── values.yaml
│       └── templates/
│           ├── deployment.yaml
│           ├── rbac.yaml
│           └── crd.yaml
└── examples/
    ├── sandbox-strict.yaml
    └── sandbox-minimal.yaml
```

---

## 6. Testing Strategy

### 6.1 Sandbox Pool Tests (F1)

| Test Case | Type | Assertion |
|-----------|------|-----------|
| Pre-warm creates minIdle sandboxes on start | Unit | Pool metrics show `idle === minIdle` after `start()` |
| acquire() returns sandbox immediately when idle exists | Unit | Resolves in <10ms |
| acquire() blocks when pool exhausted, unblocks on release | Unit | Promise resolves after `release()` |
| acquire() rejects with PoolExhaustedError after maxWaitMs | Unit | Error thrown with correct metrics |
| Health check failure causes sandbox replacement | Unit | Failed sandbox destroyed, new one created |
| Eviction sweep destroys idle-too-long sandboxes | Unit | Sandbox destroyed after maxIdleTimeMs |
| drain() waits for active sandboxes then destroys all | Unit | All sandboxes destroyed, pool reports 0 active/idle |
| Concurrent acquire/release stress test (50 ops) | Integration | No deadlocks, all sandboxes eventually released |
| Pool respects maxActive ceiling under concurrency | Integration | Active count never exceeds maxActive |

### 6.2 Resource Quota Tests (F4)

| Test Case | Type | Assertion |
|-----------|------|-----------|
| check() allows when usage < limit | Unit | Returns `{ allowed: true }` |
| check() rejects when usage >= limit | Unit | Returns `{ allowed: false }` with dimension details |
| reserve() atomically increments usage | Unit | Usage matches sum of active reservations |
| release() atomically decrements usage | Unit | Usage drops by exact reservation amount |
| Double release() is idempotent | Unit | Second call is a no-op |
| Expired reservations are swept | Unit | sweepExpired() releases stale reservations |
| Concurrent reserve() respects limits | Integration | Total usage never exceeds limit under race conditions |
| No quota set means unlimited | Unit | check() returns allowed for any amount |

### 6.3 Audit Log Tests (F7)

| Test Case | Type | Assertion |
|-----------|------|-----------|
| AuditedSandbox records execute() calls | Unit | Audit store contains entry with command and result |
| AuditedSandbox records uploadFiles() calls | Unit | Entry contains file paths and byte count |
| Secret redaction removes sensitive data | Unit | API keys and tokens are replaced with `***REDACTED***` |
| Hash chain is valid after multiple entries | Unit | verifyChain() returns `{ valid: true }` |
| Tampered entry breaks hash chain | Unit | verifyChain() returns `{ valid: false, brokenAt: id }` |
| Audit logging failure does NOT break sandbox execution | Unit | execute() succeeds even if store.append() throws |
| Query filters work correctly | Unit | Filtered results match expected entries |

### 6.4 Hot-Reload Tests (F6)

| Test Case | Type | Assertion |
|-----------|------|-----------|
| reload() increments version number | Unit | New version = old version + 1 |
| reload() with identical content returns 'unchanged' | Unit | No new version created |
| rollback() restores previous version | Unit | Active version matches previous |
| Active runs keep their pinned version | Integration | Run uses v1 definition even after v2 reload |
| New runs use latest version | Integration | Run started after reload uses v2 |
| File watcher triggers reload on .ts change | Integration | onReload callback fired |
| maxRetainedVersions evicts old versions | Unit | Version count never exceeds config |

### 6.5 Multi-Sandbox Orchestration Tests (F8)

| Test Case | Type | Assertion |
|-----------|------|-----------|
| Sequential tasks execute in order | Unit | Task B runs after Task A |
| Parallel tasks execute concurrently | Unit | Tasks B and C start at same time |
| Cycle detection rejects invalid graph | Unit | validate() returns error |
| Missing dependency rejects graph | Unit | validate() returns error |
| Dependency outputs are mounted in dependent task | Integration | Files from task A visible in task B |
| 'abort' policy cancels all on failure | Unit | Remaining tasks have status 'skipped' |
| 'skip-dependents' only skips downstream tasks | Unit | Independent tasks still run |
| maxParallel limits concurrent sandboxes | Unit | Active sandbox count <= maxParallel |
| cancel() cleans up all active sandboxes | Unit | All sandboxes destroyed |

---

## 7. Implementation Roadmap

### Summary Table

| Feature | Priority | Est. Hours | Dependencies | Package |
|---------|----------|-----------|--------------|---------|
| F1: Sandbox Pooling | P1 | 8h | None | `@dzipagent/codegen` |
| F3: Persistent Volumes | P1 | 4h | None | `@dzipagent/codegen` |
| F4: Resource Quotas | P1 | 6h | Drizzle schema | `@dzipagent/server` |
| F7: Sandbox Audit Logging | P1 | 4h | None | `@dzipagent/codegen` + `@dzipagent/server` |
| F6: Agent Hot-Reload | P2 | 8h | Agent store | `@dzipagent/server` |
| F8: Multi-Sandbox Orchestration | P2 | 8h | F1, F3 | `@dzipagent/codegen` |
| F2: Kubernetes CRD | P2 | 16h | F1, F3, F4 | `@dzipagent/codegen` + separate operator |
| F5: WASM Sandbox | P3 | 24h | None (isolated) | `@dzipagent/codegen` |
| **Total** | | **78h** | | |

### Phase Sequence

**Phase 5A (Weeks 9-10): P1 Features -- 22h**
1. F1: Sandbox Pooling (8h)
   - SandboxPool, reset strategies, metrics
   - Integration with existing SandboxFactory
2. F7: Sandbox Audit Logging (4h)
   - AuditedSandbox decorator, InMemoryAuditStore
   - Hash chain implementation
3. F3: Persistent Volumes (4h)
   - VolumeManager interface, DockerVolumeManager
   - InMemoryVolumeManager for testing
4. F4: Resource Quotas (6h)
   - ResourceQuotaManager interface
   - InMemoryQuotaManager + PostgresQuotaManager
   - Drizzle schema additions

**Phase 5B (Weeks 11-12): P2 Features -- 32h**
1. F6: Agent Hot-Reload (8h)
   - AgentHotReloader, file watcher, version tracking
   - API endpoints
2. F8: Multi-Sandbox Orchestration (8h)
   - SandboxOrchestrator, DAG validation, parallel execution
3. F2: Kubernetes CRD (16h)
   - CRD definition, operator reconciler
   - K8sPodSandbox client
   - Helm chart

**Phase 5C (Weeks 13-14): P3 Features -- 24h**
1. F5: WASM Sandbox (24h)
   - WASI filesystem, capability guard
   - QuickJS integration
   - WasmSandbox implementation

### New Dependencies

```json
// @dzipagent/codegen additions
{
  "devDependencies": {
    "@anthropic-ai/sdk": ">=0.20.0"
  },
  "peerDependencies": {
    // WASM runtime (optional, only needed for F5)
    "@aspect-build/aspect-wasm": ">=0.1.0"
  }
}

// @dzipagent/server additions
{
  "dependencies": {
    "chokidar": "^4.0.0"  // File watching for hot-reload (F6)
  }
}

// K8s operator (separate package)
{
  "dependencies": {
    "@kubernetes/client-node": "^1.0.0"
  }
}
```

### Architecture Validation Checklist

- [x] `@dzipagent/core` imports nothing from codegen/server/agent -- all new types live in codegen or server
- [x] No circular dependencies -- codegen does not import from server; server can import codegen types
- [x] All interfaces use TypeScript strict mode -- no `any`, discriminated unions for results
- [x] Works with InMemoryStore and PostgresStore -- both quota manager implementations provided
- [x] Public API is minimal -- pool, quota, audit, and orchestrator are opt-in imports
- [x] Breaking changes: none -- all features are additive; existing sandbox usage is unchanged
- [x] SandboxProtocol interface is unchanged -- new features compose via decoration and wrapping
- [x] Budget-aware -- resource quotas integrate with existing cost tracking middleware
- [x] Plugin-compatible -- audit logging and quota checking can be wired via DzipPlugin hooks
- [x] ESM throughout -- all new files use ESM imports
