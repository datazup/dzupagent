import { describe, it, expect, beforeEach, vi } from 'vitest'

// --- Pool ---
import {
  SandboxPool,
  PoolExhaustedError,
} from '../sandbox/pool/sandbox-pool.js'
import type { PooledSandbox, SandboxPoolConfig } from '../sandbox/pool/sandbox-pool.js'
import { DockerResetStrategy, CloudResetStrategy } from '../sandbox/pool/sandbox-reset.js'

// --- Volumes ---
import { InMemoryVolumeManager } from '../sandbox/volumes/memory-volume-manager.js'
import type { VolumeDescriptor } from '../sandbox/volumes/volume-manager.js'

// --- Audit ---
import { InMemoryAuditStore } from '../sandbox/audit/memory-audit-store.js'
import { AuditedSandbox, redactSecrets } from '../sandbox/audit/audited-sandbox.js'
import { MockSandbox } from '../sandbox/mock-sandbox.js'

// --- Hardening ---
import {
  toDockerSecurityFlags,
  detectEscapeAttempt,
} from '../sandbox/sandbox-hardening.js'
import type { HardenedSandboxConfig } from '../sandbox/sandbox-hardening.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let nextId = 0
function makeSandbox(): PooledSandbox {
  return {
    id: `sb-${nextId++}`,
    createdAt: new Date(),
    lastUsedAt: new Date(),
  }
}

function poolConfig(overrides?: Partial<SandboxPoolConfig>): SandboxPoolConfig {
  return {
    createSandbox: async () => makeSandbox(),
    destroySandbox: async () => {},
    ...overrides,
  }
}

// ===========================================================================
// SandboxPool
// ===========================================================================

describe('SandboxPool', () => {
  beforeEach(() => {
    nextId = 0
  })

  it('start() pre-warms minIdle sandboxes', async () => {
    const created: PooledSandbox[] = []
    const pool = new SandboxPool(
      poolConfig({
        minIdle: 3,
        createSandbox: async () => {
          const sb = makeSandbox()
          created.push(sb)
          return sb
        },
      }),
    )
    await pool.start()

    expect(created).toHaveLength(3)
    const m = pool.metrics()
    expect(m.currentIdle).toBe(3)
    expect(m.totalCreated).toBe(3)

    await pool.drain()
  })

  it('acquire() returns an idle sandbox', async () => {
    const pool = new SandboxPool(poolConfig({ minIdle: 2 }))
    await pool.start()

    const sb = await pool.acquire()
    expect(sb.id).toBeDefined()
    expect(pool.metrics().currentActive).toBe(1)
    expect(pool.metrics().currentIdle).toBe(1)

    await pool.release(sb)
    await pool.drain()
  })

  it('acquire() creates new sandbox when idle is empty but under maxSize', async () => {
    const pool = new SandboxPool(poolConfig({ minIdle: 0, maxSize: 5 }))
    await pool.start()

    const sb = await pool.acquire()
    expect(sb).toBeDefined()
    expect(pool.metrics().totalCreated).toBe(1)
    expect(pool.metrics().currentActive).toBe(1)

    await pool.release(sb)
    await pool.drain()
  })

  it('acquire() blocks when pool is full and throws PoolExhaustedError on timeout', async () => {
    const pool = new SandboxPool(
      poolConfig({ minIdle: 0, maxSize: 1, maxWaitMs: 50 }),
    )
    await pool.start()

    const sb1 = await pool.acquire()
    expect(sb1).toBeDefined()

    // Pool is full, second acquire should timeout
    await expect(pool.acquire()).rejects.toThrow(PoolExhaustedError)

    await pool.release(sb1)
    await pool.drain()
  })

  it('PoolExhaustedError has correct name and message', () => {
    const err = new PoolExhaustedError(5000)
    expect(err.name).toBe('PoolExhaustedError')
    expect(err.message).toContain('5000ms')
    expect(err).toBeInstanceOf(Error)
  })

  it('release() returns sandbox to pool for reuse', async () => {
    const pool = new SandboxPool(poolConfig({ minIdle: 0, maxSize: 1 }))
    await pool.start()

    const sb1 = await pool.acquire()
    const id1 = sb1.id
    await pool.release(sb1)

    const sb2 = await pool.acquire()
    expect(sb2.id).toBe(id1) // same sandbox reused

    await pool.release(sb2)
    await pool.drain()
  })

  it('release() hands sandbox to waiting acquirer', async () => {
    const pool = new SandboxPool(
      poolConfig({ minIdle: 0, maxSize: 1, maxWaitMs: 2000 }),
    )
    await pool.start()

    const sb1 = await pool.acquire()

    // Start a second acquire that will wait
    const acquirePromise = pool.acquire()

    // Release the first sandbox after a short delay
    setTimeout(() => void pool.release(sb1), 20)

    const sb2 = await acquirePromise
    expect(sb2.id).toBe(sb1.id)

    await pool.release(sb2)
    await pool.drain()
  })

  it('drain() waits and destroys all idle sandboxes', async () => {
    const destroyed: string[] = []
    const pool = new SandboxPool(
      poolConfig({
        minIdle: 3,
        destroySandbox: async (sb) => {
          destroyed.push(sb.id)
        },
      }),
    )
    await pool.start()
    await pool.drain()

    expect(destroyed).toHaveLength(3)
    expect(pool.metrics().currentIdle).toBe(0)
  })

  it('drain() rejects pending waiters', async () => {
    const pool = new SandboxPool(
      poolConfig({ minIdle: 0, maxSize: 1, maxWaitMs: 10_000 }),
    )
    await pool.start()

    const sb1 = await pool.acquire()

    // Start acquire that will wait (pool is full)
    const acquirePromise = pool.acquire()

    // Give the event loop a tick so the waiter is registered
    await new Promise((r) => setTimeout(r, 10))

    // Drain while someone is waiting — should reject the waiter
    const drainPromise = pool.drain()

    await expect(acquirePromise).rejects.toThrow(PoolExhaustedError)
    await drainPromise

    // Release sb1 after drain (no crash, goes to destroy path)
    await pool.release(sb1)
  })

  it('metrics() tracks acquireWaitMs', async () => {
    const pool = new SandboxPool(poolConfig({ minIdle: 1 }))
    await pool.start()

    const sb = await pool.acquire()
    const m = pool.metrics()
    expect(m.acquireWaitMs.length).toBe(1)
    expect(m.acquireWaitMs[0]).toBeGreaterThanOrEqual(0)

    await pool.release(sb)
    await pool.drain()
  })

  it('healthCheck on acquire evicts unhealthy sandboxes', async () => {
    let callCount = 0
    const pool = new SandboxPool(
      poolConfig({
        minIdle: 2,
        healthCheckOnAcquire: true,
        healthCheck: async () => {
          callCount++
          // First sandbox is unhealthy, second is healthy
          return callCount > 1
        },
      }),
    )
    await pool.start()

    const sb = await pool.acquire()
    expect(sb).toBeDefined()
    // First sandbox was evicted, second was returned
    expect(pool.metrics().totalDestroyed).toBe(1)

    await pool.release(sb)
    await pool.drain()
  })
})

// ===========================================================================
// Reset Strategies
// ===========================================================================

describe('DockerResetStrategy', () => {
  it('returns true when no exec function is provided', async () => {
    const strategy = new DockerResetStrategy()
    const result = await strategy.reset(makeSandbox())
    expect(result).toBe(true)
  })

  it('returns true when exec succeeds', async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0 })
    const strategy = new DockerResetStrategy({ exec })
    const result = await strategy.reset(makeSandbox())
    expect(result).toBe(true)
    expect(exec).toHaveBeenCalledOnce()
  })

  it('returns false when exec fails', async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 1 })
    const strategy = new DockerResetStrategy({ exec })
    const result = await strategy.reset(makeSandbox())
    expect(result).toBe(false)
  })

  it('returns false when exec throws', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('connection lost'))
    const strategy = new DockerResetStrategy({ exec })
    const result = await strategy.reset(makeSandbox())
    expect(result).toBe(false)
  })
})

describe('CloudResetStrategy', () => {
  it('always returns false', async () => {
    const strategy = new CloudResetStrategy()
    const result = await strategy.reset(makeSandbox())
    expect(result).toBe(false)
  })
})

// ===========================================================================
// VolumeManager
// ===========================================================================

describe('InMemoryVolumeManager', () => {
  let vm: InMemoryVolumeManager

  const desc: VolumeDescriptor = {
    name: 'my-vol',
    type: 'workspace',
    scopeId: 'project-1',
    mountPath: '/work',
    readOnly: false,
  }

  beforeEach(() => {
    vm = new InMemoryVolumeManager()
  })

  it('provision() creates a new volume', async () => {
    const vol = await vm.provision(desc)
    expect(vol.name).toBe('my-vol')
    expect(vol.type).toBe('workspace')
    expect(vol.scopeId).toBe('project-1')
    expect(vol.mountPath).toBe('/work')
    expect(vol.createdAt).toBeInstanceOf(Date)
  })

  it('provision() returns existing volume on duplicate', async () => {
    const v1 = await vm.provision(desc)
    const v2 = await vm.provision(desc)
    expect(v1.name).toBe(v2.name)
    // lastUsedAt should be updated
    expect(v2.lastUsedAt.getTime()).toBeGreaterThanOrEqual(v1.lastUsedAt.getTime())
  })

  it('release() removes a volume', async () => {
    await vm.provision(desc)
    await vm.release('my-vol', 'project-1')
    const list = await vm.list('project-1')
    expect(list).toHaveLength(0)
  })

  it('list() filters by scopeId', async () => {
    await vm.provision(desc)
    await vm.provision({ ...desc, name: 'other-vol', scopeId: 'project-2' })

    const p1 = await vm.list('project-1')
    expect(p1).toHaveLength(1)

    const all = await vm.list()
    expect(all).toHaveLength(2)
  })

  it('sweep() with LRU removes least recently used volumes', async () => {
    // Create 3 volumes with different lastUsedAt
    await vm.provision({ ...desc, name: 'vol-a' })
    await new Promise((r) => setTimeout(r, 5))
    await vm.provision({ ...desc, name: 'vol-b' })
    await new Promise((r) => setTimeout(r, 5))
    await vm.provision({ ...desc, name: 'vol-c' })

    // Sweep to keep only 1
    const removed = await vm.sweep('lru', 1)
    expect(removed).toBe(2)

    const remaining = await vm.list()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.name).toBe('vol-c') // most recently used
  })

  it('sweep() with oldest-first removes oldest volumes', async () => {
    await vm.provision({ ...desc, name: 'vol-old' })
    await new Promise((r) => setTimeout(r, 5))
    await vm.provision({ ...desc, name: 'vol-new' })

    const removed = await vm.sweep('oldest-first', 1)
    expect(removed).toBe(1)

    const remaining = await vm.list()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.name).toBe('vol-new')
  })

  it('sweep() does nothing when under maxVolumes', async () => {
    await vm.provision(desc)
    const removed = await vm.sweep('lru', 10)
    expect(removed).toBe(0)
  })

  it('toMountArgs() produces correct Docker flags', () => {
    const volumes = [
      { name: 'my-vol', type: 'workspace' as const, scopeId: 's', mountPath: '/work', createdAt: new Date(), lastUsedAt: new Date() },
      { name: 'cache-vol', type: 'cache' as const, scopeId: 's', mountPath: '/cache', readOnly: true, createdAt: new Date(), lastUsedAt: new Date() },
    ]
    const args = vm.toMountArgs(volumes)
    expect(args).toEqual([
      '-v=my-vol:/work',
      '-v=cache-vol:/cache:ro',
    ])
  })
})

// ===========================================================================
// Audit
// ===========================================================================

describe('InMemoryAuditStore', () => {
  let store: InMemoryAuditStore

  beforeEach(() => {
    store = new InMemoryAuditStore()
  })

  it('append() assigns sequential seq numbers', async () => {
    const e1 = await store.append({
      id: 'e1', sandboxId: 'sb1', action: 'execute',
      details: { cmd: 'echo hello' }, timestamp: new Date(),
    })
    const e2 = await store.append({
      id: 'e2', sandboxId: 'sb1', action: 'upload',
      details: { files: ['a.ts'] }, timestamp: new Date(),
    })

    expect(e1.seq).toBe(0)
    expect(e2.seq).toBe(1)
  })

  it('append() chains hashes correctly', async () => {
    const e1 = await store.append({
      id: 'e1', sandboxId: 'sb1', action: 'create',
      details: {}, timestamp: new Date(),
    })
    expect(e1.previousHash).toBe('')
    expect(e1.hash).toBeTruthy()

    const e2 = await store.append({
      id: 'e2', sandboxId: 'sb1', action: 'execute',
      details: { cmd: 'ls' }, timestamp: new Date(),
    })
    expect(e2.previousHash).toBe(e1.hash)
    expect(e2.hash).not.toBe(e1.hash)
  })

  it('getBySandbox() returns entries for the right sandbox', async () => {
    await store.append({ id: 'e1', sandboxId: 'sb1', action: 'create', details: {}, timestamp: new Date() })
    await store.append({ id: 'e2', sandboxId: 'sb2', action: 'create', details: {}, timestamp: new Date() })
    await store.append({ id: 'e3', sandboxId: 'sb1', action: 'execute', details: {}, timestamp: new Date() })

    const entries = await store.getBySandbox('sb1')
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.id)).toEqual(['e1', 'e3'])
  })

  it('verifyChain() returns valid for intact chain', async () => {
    await store.append({ id: 'e1', sandboxId: 'sb1', action: 'create', details: {}, timestamp: new Date() })
    await store.append({ id: 'e2', sandboxId: 'sb1', action: 'execute', details: {}, timestamp: new Date() })

    const result = await store.verifyChain('sb1')
    expect(result.valid).toBe(true)
    expect(result.brokenAt).toBeUndefined()
  })

  it('verifyChain() returns valid for empty chain', async () => {
    const result = await store.verifyChain('nonexistent')
    expect(result.valid).toBe(true)
  })
})

// ===========================================================================
// AuditedSandbox
// ===========================================================================

describe('AuditedSandbox', () => {
  let mock: MockSandbox
  let store: InMemoryAuditStore
  let audited: AuditedSandbox

  beforeEach(() => {
    mock = new MockSandbox()
    store = new InMemoryAuditStore()
    audited = new AuditedSandbox({
      sandbox: mock,
      store,
      sandboxId: 'test-sb',
      runId: 'run-1',
    })
  })

  it('records execute operations', async () => {
    await audited.execute('echo hello')

    const trail = await audited.getAuditTrail()
    expect(trail).toHaveLength(1)
    expect(trail[0]!.action).toBe('execute')
    expect(trail[0]!.details).toMatchObject({ command: 'echo hello', exitCode: 0 })
  })

  it('records upload operations', async () => {
    await audited.uploadFiles({ 'a.ts': 'code', 'b.ts': 'more' })

    const trail = await audited.getAuditTrail()
    expect(trail).toHaveLength(1)
    expect(trail[0]!.action).toBe('upload')
    expect(trail[0]!.details).toMatchObject({
      files: ['a.ts', 'b.ts'],
      totalBytes: 8,
    })
  })

  it('records download operations', async () => {
    mock.configure('echo', { exitCode: 0, stdout: '', stderr: '', timedOut: false })
    await audited.uploadFiles({ 'test.ts': 'hello' })
    await audited.downloadFiles(['test.ts', 'missing.ts'])

    const trail = await audited.getAuditTrail()
    const downloadEntry = trail.find((e) => e.action === 'download')
    expect(downloadEntry).toBeDefined()
    expect(downloadEntry!.details).toMatchObject({
      requestedPaths: ['test.ts', 'missing.ts'],
      returnedPaths: ['test.ts'],
    })
  })

  it('records cleanup operations', async () => {
    await audited.cleanup()

    const trail = await audited.getAuditTrail()
    expect(trail).toHaveLength(1)
    expect(trail[0]!.action).toBe('cleanup')
  })

  it('maintains valid hash chain across operations', async () => {
    await audited.execute('cmd1')
    await audited.execute('cmd2')
    await audited.uploadFiles({ 'f.ts': 'x' })

    const result = await audited.verifyAuditChain()
    expect(result.valid).toBe(true)
  })

  it('redacts secrets from commands', async () => {
    await audited.execute('curl -H "Authorization: Bearer sk-secret123456" https://api.example.com')

    const trail = await audited.getAuditTrail()
    const cmd = trail[0]!.details['command'] as string
    expect(cmd).not.toContain('sk-secret123456')
    expect(cmd).toContain('[REDACTED]')
  })

  it('delegates isAvailable to inner sandbox', async () => {
    expect(await audited.isAvailable()).toBe(true)
    mock.setAvailable(false)
    expect(await audited.isAvailable()).toBe(false)
  })
})

// ===========================================================================
// Secret Redaction
// ===========================================================================

describe('redactSecrets', () => {
  it('redacts API key patterns', () => {
    expect(redactSecrets('api_key=abc123')).toContain('[REDACTED]')
    expect(redactSecrets('API_KEY: xyz789')).toContain('[REDACTED]')
  })

  it('redacts Bearer tokens', () => {
    const result = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9')
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts AWS keys', () => {
    const result = redactSecrets('key is AKIAIOSFODNN7EXAMPLE')
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('leaves non-secret content unchanged', () => {
    const plain = 'echo "hello world" && ls -la'
    expect(redactSecrets(plain)).toBe(plain)
  })
})

// ===========================================================================
// Sandbox Hardening
// ===========================================================================

describe('toDockerSecurityFlags', () => {
  it('produces cap-drop ALL and no-new-privileges by default', () => {
    const flags = toDockerSecurityFlags({})
    expect(flags).toContain('--cap-drop=ALL')
    expect(flags).toContain('--security-opt=no-new-privileges')
  })

  it('adds memory and CPU limits', () => {
    const flags = toDockerSecurityFlags({
      memoryLimitMb: 256,
      cpuLimit: 0.5,
    })
    expect(flags).toContain('--memory=256m')
    expect(flags).toContain('--cpus=0.5')
  })

  it('adds pid limit', () => {
    const flags = toDockerSecurityFlags({ pidLimit: 30 })
    expect(flags).toContain('--pids-limit=30')
  })

  it('adds --network=none when no egress rules', () => {
    const flags = toDockerSecurityFlags({})
    expect(flags).toContain('--network=none')
  })

  it('does NOT add --network=none when egress rules present', () => {
    const flags = toDockerSecurityFlags({
      egressRules: [{ host: 'registry.npmjs.org', port: 443 }],
    })
    expect(flags).not.toContain('--network=none')
  })

  it('adds seccomp syscall denies for strict profile', () => {
    const flags = toDockerSecurityFlags({ seccompProfile: 'strict' })
    expect(flags).toContain('--security-opt=seccomp-syscall-deny=ptrace')
    expect(flags).toContain('--security-opt=seccomp-syscall-deny=mount')
    expect(flags).toContain('--security-opt=seccomp-syscall-deny=chroot')
  })

  it('adds no extra seccomp flags for default profile', () => {
    const flags = toDockerSecurityFlags({ seccompProfile: 'default' })
    const seccompFlags = flags.filter((f) => f.includes('seccomp-syscall-deny'))
    expect(seccompFlags).toHaveLength(0)
  })

  it('handles nodejs seccomp profile', () => {
    const flags = toDockerSecurityFlags({ seccompProfile: 'nodejs' })
    expect(flags).toContain('--security-opt=seccomp-syscall-deny=ptrace')
    expect(flags).toContain('--security-opt=seccomp-syscall-deny=mount')
    // nodejs profile should NOT block clone3 (needed for Node.js)
    expect(flags).not.toContain('--security-opt=seccomp-syscall-deny=clone3')
  })

  it('adds capabilities when specified', () => {
    const flags = toDockerSecurityFlags({
      dropAllCapabilities: true,
      addCapabilities: ['NET_BIND_SERVICE', 'SYS_PTRACE'],
    })
    expect(flags).toContain('--cap-drop=ALL')
    expect(flags).toContain('--cap-add=NET_BIND_SERVICE')
    expect(flags).toContain('--cap-add=SYS_PTRACE')
  })

  it('does not drop capabilities when dropAllCapabilities is false', () => {
    const flags = toDockerSecurityFlags({ dropAllCapabilities: false })
    expect(flags).not.toContain('--cap-drop=ALL')
  })

  it('adds stop-timeout from hardTimeoutMs', () => {
    const flags = toDockerSecurityFlags({ hardTimeoutMs: 60_000 })
    expect(flags).toContain('--stop-timeout=60')
  })

  it('handles filesystem ACLs', () => {
    const config: HardenedSandboxConfig = {
      filesystemACLs: [
        { path: '/work', access: 'write' },
        { path: '/secrets', access: 'none' },
      ],
    }
    const flags = toDockerSecurityFlags(config)
    expect(flags.some((f) => f.includes('--tmpfs=/work:rw'))).toBe(true)
    expect(flags.some((f) => f.includes('--tmpfs=/secrets:ro'))).toBe(true)
  })
})

describe('detectEscapeAttempt', () => {
  it('detects nsenter', () => {
    expect(detectEscapeAttempt('nsenter -t 1 -m -u -i -n bash')).toBe(true)
  })

  it('detects docker.sock access', () => {
    expect(detectEscapeAttempt('curl --unix-socket /var/run/docker.sock http://localhost/containers/json')).toBe(true)
  })

  it('detects /proc/1/root access', () => {
    expect(detectEscapeAttempt('cat /proc/1/root/etc/shadow')).toBe(true)
  })

  it('detects chroot attempts', () => {
    expect(detectEscapeAttempt('chroot /host /bin/bash')).toBe(true)
  })

  it('returns false for normal commands', () => {
    expect(detectEscapeAttempt('npm test')).toBe(false)
    expect(detectEscapeAttempt('echo hello world')).toBe(false)
    expect(detectEscapeAttempt('node index.js')).toBe(false)
  })
})
