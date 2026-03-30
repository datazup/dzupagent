import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'

import type {
  AgentSandboxResource,
  AgentSandboxSpec,
  AgentSandboxPhase,
} from '../sandbox/k8s/operator-types.js'
import { createAgentSandboxResource } from '../sandbox/k8s/operator-types.js'
import { K8sClient } from '../sandbox/k8s/k8s-client.js'
import { K8sPodSandbox } from '../sandbox/k8s/k8s-sandbox.js'

let buildPodSpec:
  | ((sandbox: AgentSandboxResource) => Record<string, unknown>)
  | undefined
let buildNetworkPolicy:
  | ((sandbox: AgentSandboxResource) => Record<string, unknown>)
  | undefined
let AgentSandboxReconciler:
  | (new (ctx?: Record<string, unknown>) => {
      reconcile: (sandbox: AgentSandboxResource) => Promise<{ requeue: boolean; requeueAfterMs?: number }>
    })
  | undefined

beforeAll(async () => {
  try {
    const podBuilder = await import('../../../../k8s/operator/src/pod-builder.js')
    const netpolBuilder = await import('../../../../k8s/operator/src/netpol-builder.js')
    const reconcilerModule = await import('../../../../k8s/operator/src/reconciler.js')

    buildPodSpec = podBuilder.buildPodSpec as typeof buildPodSpec
    buildNetworkPolicy = netpolBuilder.buildNetworkPolicy as typeof buildNetworkPolicy
    AgentSandboxReconciler = reconcilerModule.AgentSandboxReconciler as typeof AgentSandboxReconciler
  } catch {
    // Operator module is optional in this workspace; operator-specific suites are skipped.
  }
})

const describeOperator = (): typeof describe =>
  buildPodSpec && buildNetworkPolicy && AgentSandboxReconciler ? describe : describe.skip

// ===========================================================================
// Test helpers
// ===========================================================================

function makeSandbox(overrides?: Partial<AgentSandboxSpec>): AgentSandboxResource {
  return createAgentSandboxResource('test-sandbox', {
    image: 'node:20-slim',
    ...overrides,
  }, 'test-ns')
}

function makeReadySandbox(overrides?: Partial<AgentSandboxSpec>): AgentSandboxResource {
  const sb = makeSandbox(overrides)
  sb.status = {
    phase: 'Ready',
    podName: 'test-sandbox',
    startedAt: new Date().toISOString(),
  }
  return sb
}

/**
 * Create a mock fetch that returns pre-configured responses.
 * Each call pops the next response from the queue.
 */
function mockFetch(responses: Array<{ ok: boolean; status: number; body: unknown }>): typeof globalThis.fetch {
  const queue = [...responses]
  return vi.fn(async () => {
    const resp = queue.shift()
    if (!resp) {
      throw new Error('No more mock responses')
    }
    return {
      ok: resp.ok,
      status: resp.status,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    } as Response
  })
}

// ===========================================================================
// AgentSandboxResource types
// ===========================================================================

describe('AgentSandboxResource types', () => {
  it('createAgentSandboxResource produces valid resource', () => {
    const resource = createAgentSandboxResource('my-sandbox', {
      image: 'node:20-slim',
    })

    expect(resource.apiVersion).toBe('dzipagent.dev/v1alpha1')
    expect(resource.kind).toBe('AgentSandbox')
    expect(resource.metadata.name).toBe('my-sandbox')
    expect(resource.spec.image).toBe('node:20-slim')
    expect(resource.spec.securityLevel).toBe('default')
    expect(resource.spec.resources.limits.cpu).toBe('1')
    expect(resource.spec.resources.limits.memory).toBe('512Mi')
    expect(resource.spec.network.egressPolicy).toBe('deny-all')
  })

  it('createAgentSandboxResource applies namespace', () => {
    const resource = createAgentSandboxResource('sb', { image: 'alpine' }, 'custom-ns')
    expect(resource.metadata.namespace).toBe('custom-ns')
  })

  it('createAgentSandboxResource applies spec overrides', () => {
    const resource = createAgentSandboxResource('sb', {
      image: 'python:3.12',
      securityLevel: 'strict',
      ttlSeconds: 300,
      network: { egressPolicy: 'allow-all' },
      resources: { limits: { cpu: '2', memory: '1Gi' } },
    })

    expect(resource.spec.image).toBe('python:3.12')
    expect(resource.spec.securityLevel).toBe('strict')
    expect(resource.spec.ttlSeconds).toBe(300)
    expect(resource.spec.network.egressPolicy).toBe('allow-all')
    expect(resource.spec.resources.limits.memory).toBe('1Gi')
  })

  it('resource has correct managed-by label', () => {
    const resource = createAgentSandboxResource('sb', { image: 'alpine' })
    expect(resource.metadata.labels?.['app.kubernetes.io/managed-by']).toBe('dzipagent')
  })
})

// ===========================================================================
// K8sClient
// ===========================================================================

describe('K8sClient', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('createResource sends POST and returns the created resource', async () => {
    const resource = makeSandbox()
    const createdResource = { ...resource, metadata: { ...resource.metadata, uid: 'abc-123' } }

    globalThis.fetch = mockFetch([
      { ok: true, status: 201, body: createdResource },
    ])

    const client = new K8sClient({ apiServerUrl: 'http://localhost:8080', token: 'test-token' })
    const result = await client.createResource(resource)

    expect(result.metadata.uid).toBe('abc-123')
    expect(globalThis.fetch).toHaveBeenCalledOnce()
    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0]!
    expect(callArgs[0]).toContain('/apis/dzipagent.dev/v1alpha1/namespaces/test-ns/agentsandboxes')
    expect(callArgs[1]?.method).toBe('POST')
  })

  it('getResource returns resource for 200', async () => {
    const resource = makeSandbox()
    globalThis.fetch = mockFetch([
      { ok: true, status: 200, body: resource },
    ])

    const client = new K8sClient({ apiServerUrl: 'http://localhost:8080', token: 'test-token' })
    const result = await client.getResource('test-sandbox', 'test-ns')

    expect(result).toBeDefined()
    expect(result?.metadata.name).toBe('test-sandbox')
  })

  it('getResource returns undefined for 404', async () => {
    globalThis.fetch = mockFetch([
      { ok: false, status: 404, body: { message: 'not found' } },
    ])

    const client = new K8sClient({ apiServerUrl: 'http://localhost:8080', token: 'test-token' })
    const result = await client.getResource('missing', 'test-ns')

    expect(result).toBeUndefined()
  })

  it('deleteResource sends DELETE', async () => {
    globalThis.fetch = mockFetch([
      { ok: true, status: 200, body: {} },
    ])

    const client = new K8sClient({ apiServerUrl: 'http://localhost:8080', token: 'test-token' })
    await client.deleteResource('test-sandbox', 'test-ns')

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0]!
    expect(callArgs[1]?.method).toBe('DELETE')
  })

  it('deleteResource does not throw for 404', async () => {
    globalThis.fetch = mockFetch([
      { ok: false, status: 404, body: { message: 'not found' } },
    ])

    const client = new K8sClient({ apiServerUrl: 'http://localhost:8080', token: 'test-token' })
    await expect(client.deleteResource('test-sandbox', 'test-ns')).resolves.toBeUndefined()
  })

  it('createResource throws on non-ok response', async () => {
    globalThis.fetch = mockFetch([
      { ok: false, status: 500, body: { message: 'internal error' } },
    ])

    const client = new K8sClient({ apiServerUrl: 'http://localhost:8080', token: 'test-token' })
    await expect(client.createResource(makeSandbox())).rejects.toThrow('K8s createResource failed (500)')
  })

  it('uses default namespace when none specified', async () => {
    globalThis.fetch = mockFetch([
      { ok: true, status: 200, body: makeSandbox() },
    ])

    const client = new K8sClient({ apiServerUrl: 'http://localhost:8080', token: 'test-token' })
    await client.getResource('test-sandbox')

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0]!
    expect(callArgs[0]).toContain('/namespaces/default/')
  })

  it('includes Authorization header when token is set', async () => {
    globalThis.fetch = mockFetch([
      { ok: true, status: 200, body: makeSandbox() },
    ])

    const client = new K8sClient({ apiServerUrl: 'http://localhost:8080', token: 'my-token' })
    await client.getResource('test-sandbox')

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0]!
    const headers = callArgs[1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer my-token')
  })
})

// ===========================================================================
// K8sPodSandbox
// ===========================================================================

describe('K8sPodSandbox', () => {
  it('execute delegates to K8sClient.exec', async () => {
    const execMock = vi.fn().mockResolvedValue({
      stdout: 'hello',
      stderr: '',
      exitCode: 0,
    })

    const client = {
      createResource: vi.fn().mockResolvedValue(makeSandbox()),
      getResource: vi.fn().mockResolvedValue(undefined),
      deleteResource: vi.fn().mockResolvedValue(undefined),
      waitForPhase: vi.fn().mockResolvedValue(makeReadySandbox()),
      exec: execMock,
      updateStatus: vi.fn(),
    } as unknown as K8sClient

    const sandbox = new K8sPodSandbox({ k8sClient: client, namespace: 'test-ns' })
    const result = await sandbox.execute('echo hello')

    expect(result.stdout).toBe('hello')
    expect(result.exitCode).toBe(0)
    expect(execMock).toHaveBeenCalledWith(
      'test-sandbox',
      ['sh', '-c', 'echo hello'],
      'test-ns',
    )
  })

  it('cleanup deletes the CRD resource', async () => {
    const deleteResourceMock = vi.fn().mockResolvedValue(undefined)

    const client = {
      createResource: vi.fn().mockResolvedValue(makeSandbox()),
      getResource: vi.fn().mockResolvedValue(undefined),
      deleteResource: deleteResourceMock,
      waitForPhase: vi.fn().mockResolvedValue(makeReadySandbox()),
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      updateStatus: vi.fn(),
    } as unknown as K8sClient

    const sandbox = new K8sPodSandbox({ k8sClient: client, namespace: 'test-ns' })

    // Execute something first to create the pod
    await sandbox.execute('echo test')
    await sandbox.cleanup()

    expect(deleteResourceMock).toHaveBeenCalledOnce()
  })

  it('downloadFiles returns empty when no pod exists', async () => {
    const client = {
      createResource: vi.fn(),
      getResource: vi.fn(),
      deleteResource: vi.fn(),
      waitForPhase: vi.fn(),
      exec: vi.fn(),
      updateStatus: vi.fn(),
    } as unknown as K8sClient

    const sandbox = new K8sPodSandbox({ k8sClient: client })
    const files = await sandbox.downloadFiles(['/some/file.ts'])

    expect(files).toEqual({})
  })
})

// ===========================================================================
// buildPodSpec
// ===========================================================================

describeOperator()('buildPodSpec', () => {
  it('maps default security level correctly', () => {
    const sandbox = makeSandbox({ securityLevel: 'default' })
    const pod = buildPodSpec!(sandbox) as Record<string, Record<string, unknown>>

    const podSpec = pod['spec'] as Record<string, unknown>
    const secCtx = podSpec['securityContext'] as Record<string, unknown>

    expect(secCtx['runAsNonRoot']).toBe(true)
    expect(secCtx['runAsUser']).toBe(1000)
  })

  it('maps strict security level with read-only root and seccomp', () => {
    const sandbox = makeSandbox({ securityLevel: 'strict' })
    const pod = buildPodSpec!(sandbox) as Record<string, Record<string, unknown>>

    const podSpec = pod['spec'] as Record<string, unknown>
    const containers = podSpec['containers'] as Array<Record<string, unknown>>
    const containerSecCtx = containers[0]!['securityContext'] as Record<string, unknown>

    expect(containerSecCtx['readOnlyRootFilesystem']).toBe(true)
    expect(containerSecCtx['allowPrivilegeEscalation']).toBe(false)
    expect(containerSecCtx['seccompProfile']).toEqual({ type: 'RuntimeDefault' })
  })

  it('includes resource limits from spec', () => {
    const sandbox = makeSandbox({
      resources: {
        limits: { cpu: '2', memory: '1Gi' },
        requests: { cpu: '500m', memory: '256Mi' },
      },
    })
    const pod = buildPodSpec!(sandbox) as Record<string, Record<string, unknown>>

    const podSpec = pod['spec'] as Record<string, unknown>
    const containers = podSpec['containers'] as Array<Record<string, unknown>>
    const resources = containers[0]!['resources'] as Record<string, Record<string, string>>

    expect(resources['limits']!['cpu']).toBe('2')
    expect(resources['limits']!['memory']).toBe('1Gi')
    expect(resources['requests']!['cpu']).toBe('500m')
    expect(resources['requests']!['memory']).toBe('256Mi')
  })

  it('includes workspace and tmp volumes by default', () => {
    const sandbox = makeSandbox()
    const pod = buildPodSpec!(sandbox) as Record<string, Record<string, unknown>>

    const podSpec = pod['spec'] as Record<string, unknown>
    const volumes = podSpec['volumes'] as Array<Record<string, unknown>>

    const volumeNames = volumes.map((v) => v['name'])
    expect(volumeNames).toContain('workspace')
    expect(volumeNames).toContain('tmp')
  })

  it('includes custom volumes from spec', () => {
    const sandbox = makeSandbox({
      volumes: [
        { name: 'data-vol', mountPath: '/data', type: 'emptyDir' },
        { name: 'config-vol', mountPath: '/config', type: 'configMap' },
      ],
    })
    const pod = buildPodSpec!(sandbox) as Record<string, Record<string, unknown>>

    const podSpec = pod['spec'] as Record<string, unknown>
    const volumes = podSpec['volumes'] as Array<Record<string, unknown>>
    const volumeNames = volumes.map((v) => v['name'])

    expect(volumeNames).toContain('data-vol')
    expect(volumeNames).toContain('config-vol')
  })

  it('sets runtimeClassName when runtimeClass is specified', () => {
    const sandbox = makeSandbox({ runtimeClass: 'gvisor' })
    const pod = buildPodSpec!(sandbox) as Record<string, Record<string, unknown>>

    const podSpec = pod['spec'] as Record<string, unknown>
    expect(podSpec['runtimeClassName']).toBe('gvisor')
  })

  it('includes env vars when specified', () => {
    const sandbox = makeSandbox({
      env: [
        { name: 'NODE_ENV', value: 'production' },
        { name: 'DEBUG', value: 'false' },
      ],
    })
    const pod = buildPodSpec!(sandbox) as Record<string, Record<string, unknown>>

    const podSpec = pod['spec'] as Record<string, unknown>
    const containers = podSpec['containers'] as Array<Record<string, unknown>>
    const env = containers[0]!['env'] as Array<Record<string, string>>

    expect(env).toHaveLength(2)
    expect(env[0]!['name']).toBe('NODE_ENV')
    expect(env[0]!['value']).toBe('production')
  })

  it('sets restartPolicy to Never', () => {
    const sandbox = makeSandbox()
    const pod = buildPodSpec!(sandbox) as Record<string, Record<string, unknown>>

    const podSpec = pod['spec'] as Record<string, unknown>
    expect(podSpec['restartPolicy']).toBe('Never')
  })

  it('sets automountServiceAccountToken to false', () => {
    const sandbox = makeSandbox()
    const pod = buildPodSpec!(sandbox) as Record<string, Record<string, unknown>>

    const podSpec = pod['spec'] as Record<string, unknown>
    expect(podSpec['automountServiceAccountToken']).toBe(false)
  })

  it('sets owner reference for garbage collection', () => {
    const sandbox = makeSandbox()
    sandbox.metadata.uid = 'uid-123'
    const pod = buildPodSpec!(sandbox) as Record<string, Record<string, unknown>>

    const metadata = pod['metadata'] as Record<string, unknown>
    const ownerRefs = metadata['ownerReferences'] as Array<Record<string, unknown>>

    expect(ownerRefs).toHaveLength(1)
    expect(ownerRefs[0]!['kind']).toBe('AgentSandbox')
    expect(ownerRefs[0]!['uid']).toBe('uid-123')
    expect(ownerRefs[0]!['controller']).toBe(true)
  })
})

// ===========================================================================
// buildNetworkPolicy
// ===========================================================================

describeOperator()('buildNetworkPolicy', () => {
  it('deny-all produces a NetworkPolicy with empty egress', () => {
    const sandbox = makeSandbox({ network: { egressPolicy: 'deny-all' } })
    const netpol = buildNetworkPolicy!(sandbox)

    expect(netpol['apiVersion']).toBe('networking.k8s.io/v1')
    expect(netpol['kind']).toBe('NetworkPolicy')

    const spec = netpol['spec'] as Record<string, unknown>
    expect(spec['policyTypes']).toEqual(['Egress'])
    expect(spec['egress']).toEqual([])
  })

  it('allow-all returns empty object (no policy needed)', () => {
    const sandbox = makeSandbox({ network: { egressPolicy: 'allow-all' } })
    const netpol = buildNetworkPolicy!(sandbox)

    expect(Object.keys(netpol)).toHaveLength(0)
  })

  it('custom policy includes DNS egress and allowed hosts', () => {
    const sandbox = makeSandbox({
      network: {
        egressPolicy: 'custom',
        allowedHosts: ['registry.npmjs.org', 'api.github.com'],
      },
    })
    const netpol = buildNetworkPolicy!(sandbox)

    const spec = netpol['spec'] as Record<string, unknown>
    const egress = spec['egress'] as Array<Record<string, unknown>>

    // Should have DNS egress + host rules
    expect(egress.length).toBeGreaterThan(0)

    // First rule should be DNS (port 53)
    const dnsRule = egress[0]!
    const dnsPorts = dnsRule['ports'] as Array<Record<string, unknown>>
    expect(dnsPorts.some((p) => p['port'] === 53)).toBe(true)
  })

  it('deny-all sets correct pod selector', () => {
    const sandbox = makeSandbox({ network: { egressPolicy: 'deny-all' } })
    const netpol = buildNetworkPolicy!(sandbox)

    const spec = netpol['spec'] as Record<string, unknown>
    const selector = spec['podSelector'] as Record<string, Record<string, string>>
    expect(selector['matchLabels']!['dzipagent.dev/sandbox']).toBe('test-sandbox')
  })

  it('custom policy stores allowed hosts in annotation', () => {
    const sandbox = makeSandbox({
      network: {
        egressPolicy: 'custom',
        allowedHosts: ['example.com'],
      },
    })
    const netpol = buildNetworkPolicy!(sandbox)

    const metadata = netpol['metadata'] as Record<string, Record<string, string>>
    expect(metadata['annotations']!['dzipagent.dev/allowed-hosts']).toBe('example.com')
  })
})

// ===========================================================================
// AgentSandboxReconciler
// ===========================================================================

describeOperator()('AgentSandboxReconciler', () => {
  it('creates pod for Pending phase', async () => {
    const createPod = vi.fn().mockResolvedValue(undefined)
    const createNetworkPolicy = vi.fn().mockResolvedValue(undefined)
    const updateStatus = vi.fn().mockResolvedValue(undefined)

    const ctx = { createPod, createNetworkPolicy, updateStatus }
    const reconciler = new AgentSandboxReconciler!(ctx)

    const sandbox = makeSandbox()
    sandbox.status = { phase: 'Pending' }

    const result = await reconciler.reconcile(sandbox)

    expect(createPod).toHaveBeenCalledOnce()
    expect(createNetworkPolicy).toHaveBeenCalledOnce()
    expect(result.requeue).toBe(true)
    expect(result.requeueAfterMs).toBeGreaterThan(0)
    expect(sandbox.status?.phase).toBe('Creating')
  })

  it('transitions to Ready when pod is Running', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined)
    const getPodPhase = vi.fn().mockResolvedValue('Running')

    const ctx = { getPodPhase, updateStatus }
    const reconciler = new AgentSandboxReconciler!(ctx)

    const sandbox = makeSandbox()
    sandbox.status = { phase: 'Creating' }

    const result = await reconciler.reconcile(sandbox)

    expect(sandbox.status?.phase).toBe('Ready')
    expect(sandbox.status?.podName).toBe('test-sandbox')
    expect(sandbox.status?.startedAt).toBeDefined()
    expect(result.requeue).toBe(false)
  })

  it('transitions to Failed when pod fails', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined)
    const getPodPhase = vi.fn().mockResolvedValue('Failed')

    const ctx = { getPodPhase, updateStatus }
    const reconciler = new AgentSandboxReconciler!(ctx)

    const sandbox = makeSandbox()
    sandbox.status = { phase: 'Creating' }

    const result = await reconciler.reconcile(sandbox)

    expect(sandbox.status?.phase).toBe('Failed')
    expect(result.requeue).toBe(false)
  })

  it('requeues Creating when pod is still Pending', async () => {
    const getPodPhase = vi.fn().mockResolvedValue('Pending')

    const ctx = { getPodPhase }
    const reconciler = new AgentSandboxReconciler!(ctx)

    const sandbox = makeSandbox()
    sandbox.status = { phase: 'Creating' }

    const result = await reconciler.reconcile(sandbox)

    expect(result.requeue).toBe(true)
    expect(result.requeueAfterMs).toBeGreaterThan(0)
  })

  it('does not requeue Ready phase', async () => {
    const reconciler = new AgentSandboxReconciler!()

    const sandbox = makeSandbox()
    sandbox.status = { phase: 'Ready', podName: 'test-sandbox' }

    const result = await reconciler.reconcile(sandbox)

    expect(result.requeue).toBe(false)
  })

  it('does not requeue Running phase', async () => {
    const reconciler = new AgentSandboxReconciler!()

    const sandbox = makeSandbox()
    sandbox.status = { phase: 'Running', podName: 'test-sandbox' }

    const result = await reconciler.reconcile(sandbox)

    expect(result.requeue).toBe(false)
  })

  it('enforces TTL and transitions Succeeded to Terminating', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined)

    const ctx = { updateStatus }
    const reconciler = new AgentSandboxReconciler!(ctx)

    const sandbox = makeSandbox({ ttlSeconds: 1 })
    sandbox.status = {
      phase: 'Succeeded',
      completedAt: new Date(Date.now() - 2000).toISOString(),
    }

    const result = await reconciler.reconcile(sandbox)

    expect(sandbox.status?.phase).toBe('Terminating')
    expect(result.requeue).toBe(true)
  })

  it('requeues Succeeded with remaining TTL when not expired', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined)

    const ctx = { updateStatus }
    const reconciler = new AgentSandboxReconciler!(ctx)

    const sandbox = makeSandbox({ ttlSeconds: 3600 })
    sandbox.status = {
      phase: 'Succeeded',
      completedAt: new Date().toISOString(),
    }

    const result = await reconciler.reconcile(sandbox)

    expect(result.requeue).toBe(true)
    expect(result.requeueAfterMs).toBeGreaterThan(0)
    expect(result.requeueAfterMs).toBeLessThanOrEqual(3600 * 1000)
  })

  it('Terminating phase deletes pod and network policy', async () => {
    const deletePod = vi.fn().mockResolvedValue(undefined)
    const deleteNetworkPolicy = vi.fn().mockResolvedValue(undefined)

    const ctx = { deletePod, deleteNetworkPolicy }
    const reconciler = new AgentSandboxReconciler!(ctx)

    const sandbox = makeSandbox()
    sandbox.status = { phase: 'Terminating' }

    const result = await reconciler.reconcile(sandbox)

    expect(deletePod).toHaveBeenCalledWith('test-sandbox', 'test-ns')
    expect(deleteNetworkPolicy).toHaveBeenCalledWith('test-sandbox-netpol', 'test-ns')
    expect(result.requeue).toBe(false)
  })

  it('Pending without network policy (allow-all) skips netpol creation', async () => {
    const createPod = vi.fn().mockResolvedValue(undefined)
    const createNetworkPolicy = vi.fn().mockResolvedValue(undefined)
    const updateStatus = vi.fn().mockResolvedValue(undefined)

    const ctx = { createPod, createNetworkPolicy, updateStatus }
    const reconciler = new AgentSandboxReconciler!(ctx)

    const sandbox = makeSandbox({ network: { egressPolicy: 'allow-all' } })
    sandbox.status = { phase: 'Pending' }

    await reconciler.reconcile(sandbox)

    expect(createPod).toHaveBeenCalledOnce()
    expect(createNetworkPolicy).not.toHaveBeenCalled()
  })

  it('reconcile with no status defaults to Pending', async () => {
    const createPod = vi.fn().mockResolvedValue(undefined)
    const updateStatus = vi.fn().mockResolvedValue(undefined)

    const ctx = { createPod, updateStatus }
    const reconciler = new AgentSandboxReconciler!(ctx)

    const sandbox = makeSandbox()
    // No status set at all

    const result = await reconciler.reconcile(sandbox)

    expect(createPod).toHaveBeenCalledOnce()
    expect(result.requeue).toBe(true)
  })

  it('Succeeded without TTL does not requeue', async () => {
    const reconciler = new AgentSandboxReconciler!()

    const sandbox = makeSandbox()
    // No ttlSeconds
    sandbox.status = { phase: 'Succeeded' }

    const result = await reconciler.reconcile(sandbox)

    expect(result.requeue).toBe(false)
  })
})

// ===========================================================================
// Import/export check: verify barrel re-exports compile
// ===========================================================================

describe('K8s barrel exports', () => {
  it('exports all expected symbols from index', async () => {
    const k8sModule = await import('../sandbox/k8s/index.js')

    expect(k8sModule.K8sClient).toBeDefined()
    expect(k8sModule.K8sPodSandbox).toBeDefined()
    expect(k8sModule.createAgentSandboxResource).toBeDefined()
  })
})
