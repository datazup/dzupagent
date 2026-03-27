/**
 * Lightweight Kubernetes API client for AgentSandbox CRD operations.
 *
 * Uses the K8s REST API directly via fetch — no external SDK required.
 * Supports creating, getting, deleting, and watching AgentSandbox resources,
 * plus exec into pods.
 */

import type {
  AgentSandboxResource,
  AgentSandboxPhase,
} from './operator-types.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface K8sClientConfig {
  /** K8s API server URL (default: https://kubernetes.default.svc) */
  apiServerUrl?: string
  /** Namespace for CRD operations (default: 'default') */
  namespace?: string
  /** Bearer token for auth (defaults to in-cluster service account token) */
  token?: string
  /** Request timeout in ms (default: 30_000) */
  timeout?: number
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const DEFAULT_API_SERVER = 'https://kubernetes.default.svc'
const DEFAULT_NAMESPACE = 'default'
const DEFAULT_TIMEOUT = 30_000
const CRD_GROUP = 'dzipagent.dev'
const CRD_VERSION = 'v1alpha1'
const CRD_PLURAL = 'agentsandboxes'

export class K8sClient {
  private readonly apiServerUrl: string
  private readonly namespace: string
  private readonly token: string | undefined
  private readonly timeout: number

  constructor(config?: K8sClientConfig) {
    this.apiServerUrl = (config?.apiServerUrl ?? DEFAULT_API_SERVER).replace(/\/$/, '')
    this.namespace = config?.namespace ?? DEFAULT_NAMESPACE
    this.token = config?.token
    this.timeout = config?.timeout ?? DEFAULT_TIMEOUT
  }

  // -----------------------------------------------------------------------
  // CRD CRUD
  // -----------------------------------------------------------------------

  /** Create an AgentSandbox CRD resource */
  async createResource(resource: AgentSandboxResource): Promise<AgentSandboxResource> {
    const ns = resource.metadata.namespace ?? this.namespace
    const url = `${this.apiServerUrl}/apis/${CRD_GROUP}/${CRD_VERSION}/namespaces/${ns}/${CRD_PLURAL}`

    const res = await this.apiFetch(url, {
      method: 'POST',
      body: JSON.stringify(resource),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`K8s createResource failed (${res.status}): ${text}`)
    }

    return (await res.json()) as AgentSandboxResource
  }

  /** Get an AgentSandbox CRD resource by name */
  async getResource(name: string, namespace?: string): Promise<AgentSandboxResource | undefined> {
    const ns = namespace ?? this.namespace
    const url = `${this.apiServerUrl}/apis/${CRD_GROUP}/${CRD_VERSION}/namespaces/${ns}/${CRD_PLURAL}/${name}`

    const res = await this.apiFetch(url, { method: 'GET' })

    if (res.status === 404) {
      return undefined
    }

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`K8s getResource failed (${res.status}): ${text}`)
    }

    return (await res.json()) as AgentSandboxResource
  }

  /** Delete an AgentSandbox CRD resource by name */
  async deleteResource(name: string, namespace?: string): Promise<void> {
    const ns = namespace ?? this.namespace
    const url = `${this.apiServerUrl}/apis/${CRD_GROUP}/${CRD_VERSION}/namespaces/${ns}/${CRD_PLURAL}/${name}`

    const res = await this.apiFetch(url, { method: 'DELETE' })

    if (!res.ok && res.status !== 404) {
      const text = await res.text()
      throw new Error(`K8s deleteResource failed (${res.status}): ${text}`)
    }
  }

  /** Update the status sub-resource of an AgentSandbox */
  async updateStatus(
    name: string,
    resource: AgentSandboxResource,
    namespace?: string,
  ): Promise<AgentSandboxResource> {
    const ns = namespace ?? this.namespace
    const url = `${this.apiServerUrl}/apis/${CRD_GROUP}/${CRD_VERSION}/namespaces/${ns}/${CRD_PLURAL}/${name}/status`

    const res = await this.apiFetch(url, {
      method: 'PUT',
      body: JSON.stringify(resource),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`K8s updateStatus failed (${res.status}): ${text}`)
    }

    return (await res.json()) as AgentSandboxResource
  }

  // -----------------------------------------------------------------------
  // Wait / Poll
  // -----------------------------------------------------------------------

  /** Poll until the resource reaches the desired phase or timeout */
  async waitForPhase(
    name: string,
    phase: AgentSandboxPhase,
    timeoutMs?: number,
    namespace?: string,
  ): Promise<AgentSandboxResource> {
    const deadline = Date.now() + (timeoutMs ?? this.timeout)
    const pollInterval = 1000

    while (Date.now() < deadline) {
      const resource = await this.getResource(name, namespace)
      if (!resource) {
        throw new Error(`AgentSandbox '${name}' not found while waiting for phase '${phase}'`)
      }
      if (resource.status?.phase === phase) {
        return resource
      }
      if (resource.status?.phase === 'Failed') {
        throw new Error(
          `AgentSandbox '${name}' entered Failed phase: ${resource.status.message ?? 'unknown error'}`,
        )
      }
      await this.sleep(Math.min(pollInterval, deadline - Date.now()))
    }

    throw new Error(`Timed out waiting for AgentSandbox '${name}' to reach phase '${phase}'`)
  }

  // -----------------------------------------------------------------------
  // Pod exec
  // -----------------------------------------------------------------------

  /** Execute a command in a pod */
  async exec(
    podName: string,
    command: string[],
    namespace?: string,
  ): Promise<ExecResult> {
    const ns = namespace ?? this.namespace
    const params = new URLSearchParams({
      stdout: '1',
      stderr: '1',
      container: 'sandbox',
    })
    for (const cmd of command) {
      params.append('command', cmd)
    }

    const url = `${this.apiServerUrl}/api/v1/namespaces/${ns}/pods/${podName}/exec?${params.toString()}`

    const res = await this.apiFetch(url, { method: 'POST' })

    if (!res.ok) {
      const text = await res.text()
      return {
        stdout: '',
        stderr: `K8s exec failed (${res.status}): ${text}`,
        exitCode: 1,
      }
    }

    const data = (await res.json()) as { stdout?: string; stderr?: string; exitCode?: number }
    return {
      stdout: data.stdout ?? '',
      stderr: data.stderr ?? '',
      exitCode: data.exitCode ?? 0,
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async apiFetch(
    url: string,
    opts: { method: string; body?: string },
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }
      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`
      }
      return await fetch(url, {
        method: opts.method,
        headers,
        body: opts.body,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
  }
}
