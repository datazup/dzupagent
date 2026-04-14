import { describe, it, expect } from 'vitest'
import { MockSandbox } from '../sandbox/mock-sandbox.js'
import { createSandbox } from '../sandbox/sandbox-factory.js'
import {
  TIER_DEFAULTS,
  tierToDockerFlags,
  type PermissionTier,
} from '../sandbox/permission-tiers.js'
import {
  SECURITY_PROFILES,
  getSecurityProfile,
  customizeProfile,
  toDockerFlags,
  type SecurityLevel,
} from '../sandbox/security-profile.js'
import {
  toDockerSecurityFlags,
  detectEscapeAttempt,
  type HardenedSandboxConfig,
} from '../sandbox/sandbox-hardening.js'

// ---------------------------------------------------------------------------
// MockSandbox
// ---------------------------------------------------------------------------

describe('MockSandbox', () => {
  it('should report available by default', async () => {
    const sandbox = new MockSandbox()
    expect(await sandbox.isAvailable()).toBe(true)
  })

  it('should report unavailable when set', async () => {
    const sandbox = new MockSandbox()
    sandbox.setAvailable(false)
    expect(await sandbox.isAvailable()).toBe(false)
  })

  it('should upload and download files', async () => {
    const sandbox = new MockSandbox()
    await sandbox.uploadFiles({ 'a.ts': 'hello', 'b.ts': 'world' })

    const downloaded = await sandbox.downloadFiles(['a.ts', 'b.ts', 'missing.ts'])
    expect(downloaded).toEqual({ 'a.ts': 'hello', 'b.ts': 'world' })
    expect(downloaded['missing.ts']).toBeUndefined()
  })

  it('should record executed commands', async () => {
    const sandbox = new MockSandbox()
    await sandbox.execute('echo hello')
    await sandbox.execute('npm test')

    expect(sandbox.getExecutedCommands()).toEqual(['echo hello', 'npm test'])
  })

  it('should return default success result', async () => {
    const sandbox = new MockSandbox()
    const result = await sandbox.execute('some command')

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
  })

  it('should match configured results by exact string', async () => {
    const sandbox = new MockSandbox()
    sandbox.configure('npm test', {
      exitCode: 1,
      stdout: 'FAIL',
      stderr: 'error',
      timedOut: false,
    })

    const result = await sandbox.execute('npm test')
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('FAIL')
  })

  it('should match configured results by substring', async () => {
    const sandbox = new MockSandbox()
    sandbox.configure('test', {
      exitCode: 0,
      stdout: 'PASS',
      stderr: '',
      timedOut: false,
    })

    const result = await sandbox.execute('npm run test --verbose')
    expect(result.stdout).toBe('PASS')
  })

  it('should match configured results by regex', async () => {
    const sandbox = new MockSandbox()
    sandbox.configure(/vitest\s+run/, {
      exitCode: 0,
      stdout: 'All tests passed',
      stderr: '',
      timedOut: false,
    })

    const result = await sandbox.execute('npx vitest run --reporter=json')
    expect(result.stdout).toBe('All tests passed')
  })

  it('should return first matching configured result', async () => {
    const sandbox = new MockSandbox()
    sandbox.configure('test', {
      exitCode: 0,
      stdout: 'first',
      stderr: '',
      timedOut: false,
    })
    sandbox.configure('test', {
      exitCode: 1,
      stdout: 'second',
      stderr: '',
      timedOut: false,
    })

    const result = await sandbox.execute('test')
    expect(result.stdout).toBe('first')
  })

  it('should clear state on cleanup', async () => {
    const sandbox = new MockSandbox()
    await sandbox.uploadFiles({ 'f.ts': 'content' })
    await sandbox.execute('cmd')
    sandbox.configure('x', { exitCode: 0, stdout: '', stderr: '', timedOut: false })

    await sandbox.cleanup()

    expect(sandbox.getExecutedCommands()).toEqual([])
    expect(sandbox.getUploadedFiles()).toEqual({})
    // After cleanup, configured results are also cleared
    const result = await sandbox.execute('x')
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
  })

  it('should return a copy of files not a reference', async () => {
    const sandbox = new MockSandbox()
    await sandbox.uploadFiles({ 'a.ts': 'content' })

    const files = sandbox.getUploadedFiles()
    files['a.ts'] = 'modified'

    const filesAgain = sandbox.getUploadedFiles()
    expect(filesAgain['a.ts']).toBe('content')
  })

  it('should return a copy of commands not a reference', async () => {
    const sandbox = new MockSandbox()
    await sandbox.execute('cmd1')

    const commands = sandbox.getExecutedCommands()
    commands.push('cmd2')

    expect(sandbox.getExecutedCommands()).toEqual(['cmd1'])
  })
})

// ---------------------------------------------------------------------------
// createSandbox factory
// ---------------------------------------------------------------------------

describe('createSandbox', () => {
  it('should create a MockSandbox for "mock" provider', () => {
    const sandbox = createSandbox({ provider: 'mock' })
    expect(sandbox).toBeInstanceOf(MockSandbox)
  })

  it('should create a DockerSandbox for "docker" provider', () => {
    const sandbox = createSandbox({ provider: 'docker' })
    // We can't import DockerSandbox directly to check instanceof,
    // but we can verify it has the SandboxProtocol methods
    expect(sandbox.execute).toBeInstanceOf(Function)
    expect(sandbox.uploadFiles).toBeInstanceOf(Function)
    expect(sandbox.downloadFiles).toBeInstanceOf(Function)
    expect(sandbox.cleanup).toBeInstanceOf(Function)
    expect(sandbox.isAvailable).toBeInstanceOf(Function)
  })

  it('should create DockerSandbox with custom config', () => {
    const sandbox = createSandbox({
      provider: 'docker',
      docker: { image: 'node:22', memoryLimit: '1g', cpuLimit: '2.0' },
    })
    expect(sandbox).toBeDefined()
  })

  it('should throw for e2b provider without config', () => {
    expect(() => createSandbox({ provider: 'e2b' })).toThrow(
      'E2B sandbox requires "e2b" configuration',
    )
  })

  it('should throw for fly provider without config', () => {
    expect(() => createSandbox({ provider: 'fly' })).toThrow(
      'Fly sandbox requires "fly" configuration',
    )
  })
})

// ---------------------------------------------------------------------------
// Permission tiers
// ---------------------------------------------------------------------------

describe('TIER_DEFAULTS', () => {
  it('should define all three tiers', () => {
    expect(TIER_DEFAULTS).toHaveProperty('read-only')
    expect(TIER_DEFAULTS).toHaveProperty('workspace-write')
    expect(TIER_DEFAULTS).toHaveProperty('full-access')
  })

  it('read-only tier should have most restrictive settings', () => {
    const tier = TIER_DEFAULTS['read-only']
    expect(tier.network).toBe(false)
    expect(tier.filesystem).toBe('read-only')
    expect(tier.processes).toBe(false)
    expect(tier.maxMemoryMb).toBeLessThanOrEqual(256)
  })

  it('workspace-write tier should allow processes but no network', () => {
    const tier = TIER_DEFAULTS['workspace-write']
    expect(tier.network).toBe(false)
    expect(tier.filesystem).toBe('workspace-only')
    expect(tier.processes).toBe(true)
  })

  it('full-access tier should have least restrictive settings', () => {
    const tier = TIER_DEFAULTS['full-access']
    expect(tier.network).toBe(true)
    expect(tier.filesystem).toBe('full')
    expect(tier.processes).toBe(true)
  })

  it('tiers should have increasing memory limits', () => {
    expect(TIER_DEFAULTS['read-only'].maxMemoryMb)
      .toBeLessThanOrEqual(TIER_DEFAULTS['workspace-write'].maxMemoryMb)
    expect(TIER_DEFAULTS['workspace-write'].maxMemoryMb)
      .toBeLessThanOrEqual(TIER_DEFAULTS['full-access'].maxMemoryMb)
  })

  it('tiers should have increasing timeout values', () => {
    expect(TIER_DEFAULTS['read-only'].timeoutMs)
      .toBeLessThanOrEqual(TIER_DEFAULTS['workspace-write'].timeoutMs)
    expect(TIER_DEFAULTS['workspace-write'].timeoutMs)
      .toBeLessThanOrEqual(TIER_DEFAULTS['full-access'].timeoutMs)
  })
})

describe('tierToDockerFlags', () => {
  it('should generate flags for read-only tier', () => {
    const flags = tierToDockerFlags('read-only')
    expect(flags).toContain('--network=none')
    expect(flags).toContain('--read-only')
    expect(flags).toContain('--pids-limit=5')
    expect(flags.some((f) => f.startsWith('--memory='))).toBe(true)
    expect(flags.some((f) => f.startsWith('--cpus='))).toBe(true)
  })

  it('should generate flags for workspace-write tier', () => {
    const flags = tierToDockerFlags('workspace-write')
    expect(flags).toContain('--network=none')
    expect(flags).not.toContain('--read-only')
    expect(flags).not.toContain('--pids-limit=5')
  })

  it('should generate flags for full-access tier', () => {
    const flags = tierToDockerFlags('full-access')
    expect(flags).not.toContain('--network=none')
    expect(flags).not.toContain('--read-only')
  })

  it('should always include --no-new-privileges', () => {
    const tiers: PermissionTier[] = ['read-only', 'workspace-write', 'full-access']
    for (const tier of tiers) {
      const flags = tierToDockerFlags(tier)
      expect(flags).toContain('--no-new-privileges')
    }
  })
})

// ---------------------------------------------------------------------------
// Security profiles
// ---------------------------------------------------------------------------

describe('SECURITY_PROFILES', () => {
  it('should define all four levels', () => {
    const levels: SecurityLevel[] = ['minimal', 'standard', 'strict', 'paranoid']
    for (const level of levels) {
      expect(SECURITY_PROFILES[level]).toBeDefined()
      expect(SECURITY_PROFILES[level].level).toBe(level)
    }
  })

  it('minimal should allow outbound network', () => {
    expect(SECURITY_PROFILES.minimal.network.allowOutbound).toBe(true)
  })

  it('standard, strict, and paranoid should block outbound', () => {
    expect(SECURITY_PROFILES.standard.network.allowOutbound).toBe(false)
    expect(SECURITY_PROFILES.strict.network.allowOutbound).toBe(false)
    expect(SECURITY_PROFILES.paranoid.network.allowOutbound).toBe(false)
  })

  it('all profiles should block inbound', () => {
    const levels: SecurityLevel[] = ['minimal', 'standard', 'strict', 'paranoid']
    for (const level of levels) {
      expect(SECURITY_PROFILES[level].network.blockInbound).toBe(true)
    }
  })

  it('stricter profiles should have more blocked syscalls', () => {
    const standardCount = SECURITY_PROFILES.standard.process.blockedSyscalls.length
    const strictCount = SECURITY_PROFILES.strict.process.blockedSyscalls.length
    const paranoidCount = SECURITY_PROFILES.paranoid.process.blockedSyscalls.length
    expect(strictCount).toBeGreaterThanOrEqual(standardCount)
    expect(paranoidCount).toBeGreaterThanOrEqual(strictCount)
  })
})

describe('getSecurityProfile', () => {
  it('should return a deep copy', () => {
    const profile = getSecurityProfile('standard')
    profile.network.allowOutbound = true

    const fresh = getSecurityProfile('standard')
    expect(fresh.network.allowOutbound).toBe(false)
  })
})

describe('customizeProfile', () => {
  it('should override network settings', () => {
    const profile = customizeProfile('standard', {
      network: { allowOutbound: true, blockInbound: false },
    })
    expect(profile.network.allowOutbound).toBe(true)
    expect(profile.network.blockInbound).toBe(false)
  })

  it('should override resource limits', () => {
    const profile = customizeProfile('strict', {
      resources: { cpuCores: 4, memoryMb: 2048, diskMb: 4096, timeoutMs: 600_000 },
    })
    expect(profile.resources.cpuCores).toBe(4)
    expect(profile.resources.memoryMb).toBe(2048)
  })

  it('should override filesystem settings', () => {
    const profile = customizeProfile('paranoid', {
      filesystem: {
        readOnlyMounts: ['/etc'],
        writablePaths: ['/work', '/tmp', '/var'],
        useTmpfs: false,
      },
    })
    expect(profile.filesystem.readOnlyMounts).toContain('/etc')
    expect(profile.filesystem.useTmpfs).toBe(false)
  })

  it('should preserve base settings when partial override', () => {
    const profile = customizeProfile('standard', {
      resources: { cpuCores: 2, memoryMb: 1024, diskMb: 2048, timeoutMs: 600_000 },
    })
    // Network should still be from standard base
    expect(profile.network.allowOutbound).toBe(false)
  })
})

describe('toDockerFlags (security-profile)', () => {
  it('should include --network=none for non-outbound profiles', () => {
    const flags = toDockerFlags(getSecurityProfile('standard'))
    expect(flags).toContain('--network=none')
  })

  it('should not include --network=none for minimal (outbound allowed)', () => {
    const flags = toDockerFlags(getSecurityProfile('minimal'))
    expect(flags).not.toContain('--network=none')
  })

  it('should always drop all caps', () => {
    const levels: SecurityLevel[] = ['minimal', 'standard', 'strict', 'paranoid']
    for (const level of levels) {
      const flags = toDockerFlags(getSecurityProfile(level))
      expect(flags).toContain('--cap-drop=ALL')
    }
  })

  it('should include seccomp deny flags for blocked syscalls', () => {
    const flags = toDockerFlags(getSecurityProfile('standard'))
    expect(flags.some((f) => f.includes('seccomp-syscall-deny=ptrace'))).toBe(true)
  })

  it('should include --read-only for paranoid (limited writable paths + tmpfs)', () => {
    const flags = toDockerFlags(getSecurityProfile('paranoid'))
    expect(flags).toContain('--read-only')
  })

  it('should include pids-limit', () => {
    const flags = toDockerFlags(getSecurityProfile('standard'))
    expect(flags.some((f) => f.startsWith('--pids-limit='))).toBe(true)
  })

  it('should include tmpfs for profiles that use it', () => {
    const flags = toDockerFlags(getSecurityProfile('strict'))
    expect(flags.some((f) => f.startsWith('--tmpfs='))).toBe(true)
  })

  it('should include read-only volume mounts', () => {
    const profile = customizeProfile('standard', {
      filesystem: {
        readOnlyMounts: ['/host/data'],
        writablePaths: ['/work', '/tmp'],
        useTmpfs: false,
      },
    })
    const flags = toDockerFlags(profile)
    expect(flags.some((f) => f.includes('/host/data') && f.includes(':ro'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Sandbox hardening
// ---------------------------------------------------------------------------

describe('toDockerSecurityFlags', () => {
  it('should drop all capabilities by default', () => {
    const flags = toDockerSecurityFlags({})
    expect(flags).toContain('--cap-drop=ALL')
    expect(flags).toContain('--security-opt=no-new-privileges')
  })

  it('should not drop capabilities when dropAllCapabilities is false', () => {
    const flags = toDockerSecurityFlags({ dropAllCapabilities: false })
    expect(flags).not.toContain('--cap-drop=ALL')
  })

  it('should add back specified capabilities', () => {
    const flags = toDockerSecurityFlags({
      addCapabilities: ['NET_BIND_SERVICE', 'CHOWN'],
    })
    expect(flags).toContain('--cap-add=NET_BIND_SERVICE')
    expect(flags).toContain('--cap-add=CHOWN')
  })

  it('should include resource limits', () => {
    const flags = toDockerSecurityFlags({
      memoryLimitMb: 256,
      cpuLimit: 0.5,
      pidLimit: 30,
    })
    expect(flags).toContain('--memory=256m')
    expect(flags).toContain('--cpus=0.5')
    expect(flags).toContain('--pids-limit=30')
  })

  it('should include --network=none when no egress rules', () => {
    const flags = toDockerSecurityFlags({})
    expect(flags).toContain('--network=none')
  })

  it('should include --network=none for empty egress rules', () => {
    const flags = toDockerSecurityFlags({ egressRules: [] })
    expect(flags).toContain('--network=none')
  })

  it('should not include --network=none when egress rules exist', () => {
    const flags = toDockerSecurityFlags({
      egressRules: [{ host: 'npmjs.org', port: 443 }],
    })
    expect(flags).not.toContain('--network=none')
  })

  it('should add seccomp deny flags for strict profile', () => {
    const flags = toDockerSecurityFlags({ seccompProfile: 'strict' })
    expect(flags.some((f) => f.includes('seccomp-syscall-deny=ptrace'))).toBe(true)
    expect(flags.some((f) => f.includes('seccomp-syscall-deny=mount'))).toBe(true)
    expect(flags.some((f) => f.includes('seccomp-syscall-deny=chroot'))).toBe(true)
  })

  it('should not add seccomp deny flags for default profile', () => {
    const flags = toDockerSecurityFlags({ seccompProfile: 'default' })
    expect(flags.filter((f) => f.includes('seccomp-syscall-deny'))).toEqual([])
  })

  it('should add seccomp deny flags for nodejs profile', () => {
    const flags = toDockerSecurityFlags({ seccompProfile: 'nodejs' })
    expect(flags.some((f) => f.includes('seccomp-syscall-deny=ptrace'))).toBe(true)
    // nodejs does not block clone3
    expect(flags.some((f) => f.includes('seccomp-syscall-deny=clone3'))).toBe(false)
  })

  it('should add stop-timeout for hardTimeoutMs', () => {
    const flags = toDockerSecurityFlags({ hardTimeoutMs: 5000 })
    expect(flags).toContain('--stop-timeout=5')
  })

  it('should handle filesystem ACLs - read-only root when no write paths', () => {
    const flags = toDockerSecurityFlags({
      filesystemACLs: [
        { path: '/data', access: 'read' },
        { path: '/secrets', access: 'none' },
      ],
    })
    expect(flags).toContain('--read-only')
  })

  it('should handle filesystem ACLs - write paths', () => {
    const flags = toDockerSecurityFlags({
      filesystemACLs: [
        { path: '/work', access: 'write' },
        { path: '/data', access: 'read' },
      ],
    })
    expect(flags).not.toContain('--read-only')
    expect(flags.some((f) => f.includes('/work') && f.includes('rw'))).toBe(true)
    expect(flags.some((f) => f.includes('/data') && f.includes('ro'))).toBe(true)
  })
})

describe('detectEscapeAttempt', () => {
  it('should detect nsenter commands', () => {
    expect(detectEscapeAttempt('nsenter --target 1 --mount')).toBe(true)
  })

  it('should detect docker.sock access', () => {
    expect(detectEscapeAttempt('cat /var/run/docker.sock')).toBe(true)
  })

  it('should detect /proc/1/root access', () => {
    expect(detectEscapeAttempt('ls /proc/1/root')).toBe(true)
  })

  it('should detect cgroup mount', () => {
    expect(detectEscapeAttempt('mount -t cgroup cgroup /mnt')).toBe(true)
  })

  it('should detect chroot', () => {
    expect(detectEscapeAttempt('chroot /newroot /bin/bash')).toBe(true)
  })

  it('should detect pivot_root', () => {
    expect(detectEscapeAttempt('pivot_root /new /old')).toBe(true)
  })

  it('should detect unshare --mount', () => {
    expect(detectEscapeAttempt('unshare --mount /bin/bash')).toBe(true)
  })

  it('should not flag normal commands', () => {
    expect(detectEscapeAttempt('npm test')).toBe(false)
    expect(detectEscapeAttempt('node index.js')).toBe(false)
    expect(detectEscapeAttempt('cat /etc/passwd')).toBe(false)
    expect(detectEscapeAttempt('echo hello world')).toBe(false)
  })
})
