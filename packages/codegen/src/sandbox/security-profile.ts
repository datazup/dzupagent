/**
 * Sandbox security profiles for container escape prevention.
 *
 * Four levels: minimal, standard, strict, paranoid.
 * Each profile configures network, resources, filesystem, and process restrictions.
 * Use `toDockerFlags()` to convert a profile into Docker CLI arguments.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SecurityLevel = 'minimal' | 'standard' | 'strict' | 'paranoid'

export interface NetworkPolicy {
  /** Allow outbound network access (default: false for strict+) */
  allowOutbound: boolean
  /** Allowed outbound domains (only when allowOutbound is true) */
  allowedDomains?: string[]
  /** Block all inbound connections */
  blockInbound: boolean
}

export interface ResourceLimits {
  /** CPU cores (default: 1) */
  cpuCores: number
  /** Memory in MB (default: 512) */
  memoryMb: number
  /** Disk space in MB (default: 1024) */
  diskMb: number
  /** Execution timeout in ms (default: 300_000) */
  timeoutMs: number
}

export interface FilesystemPolicy {
  /** Read-only host mounts */
  readOnlyMounts: string[]
  /** Writable paths (within container) */
  writablePaths: string[]
  /** Use tmpfs for scratch space */
  useTmpfs: boolean
}

export interface ProcessLimits {
  /** Max number of processes (default: 50) */
  maxProcesses: number
  /** Drop all Linux capabilities except these */
  allowedCapabilities: string[]
  /** Blocked syscalls (seccomp profile entries) */
  blockedSyscalls: string[]
}

export interface SecurityProfile {
  level: SecurityLevel
  /** Network access policy */
  network: NetworkPolicy
  /** Resource limits */
  resources: ResourceLimits
  /** Filesystem restrictions */
  filesystem: FilesystemPolicy
  /** Process restrictions */
  process: ProcessLimits
}

// ---------------------------------------------------------------------------
// Pre-built profiles
// ---------------------------------------------------------------------------

export const SECURITY_PROFILES: Record<SecurityLevel, SecurityProfile> = {
  minimal: {
    level: 'minimal',
    network: { allowOutbound: true, blockInbound: true },
    resources: { cpuCores: 2, memoryMb: 2048, diskMb: 2048, timeoutMs: 600_000 },
    filesystem: { readOnlyMounts: [], writablePaths: ['/work', '/tmp'], useTmpfs: false },
    process: { maxProcesses: 200, allowedCapabilities: [], blockedSyscalls: [] },
  },
  standard: {
    level: 'standard',
    network: { allowOutbound: false, blockInbound: true },
    resources: { cpuCores: 1, memoryMb: 512, diskMb: 1024, timeoutMs: 300_000 },
    filesystem: { readOnlyMounts: [], writablePaths: ['/work', '/tmp'], useTmpfs: false },
    process: {
      maxProcesses: 50,
      allowedCapabilities: [],
      blockedSyscalls: ['ptrace', 'mount', 'umount2'],
    },
  },
  strict: {
    level: 'strict',
    network: { allowOutbound: false, blockInbound: true },
    resources: { cpuCores: 0.5, memoryMb: 256, diskMb: 512, timeoutMs: 120_000 },
    filesystem: { readOnlyMounts: [], writablePaths: ['/work', '/tmp'], useTmpfs: true },
    process: {
      maxProcesses: 30,
      allowedCapabilities: [],
      blockedSyscalls: ['ptrace', 'mount', 'umount2', 'keyctl', 'add_key', 'request_key'],
    },
  },
  paranoid: {
    level: 'paranoid',
    network: { allowOutbound: false, blockInbound: true },
    resources: { cpuCores: 0.5, memoryMb: 256, diskMb: 256, timeoutMs: 60_000 },
    filesystem: { readOnlyMounts: [], writablePaths: ['/tmp'], useTmpfs: true },
    process: {
      maxProcesses: 20,
      allowedCapabilities: [],
      blockedSyscalls: [
        'ptrace', 'mount', 'umount2', 'keyctl', 'add_key', 'request_key',
        'unshare', 'clone3', 'pivot_root', 'chroot',
      ],
    },
  },
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Get a security profile by level */
export function getSecurityProfile(level: SecurityLevel): SecurityProfile {
  return structuredClone(SECURITY_PROFILES[level])
}

/** Merge a custom partial profile on top of a base level */
export function customizeProfile(
  base: SecurityLevel,
  overrides: Partial<SecurityProfile>,
): SecurityProfile {
  const profile = getSecurityProfile(base)
  if (overrides.network) {
    Object.assign(profile.network, overrides.network)
  }
  if (overrides.resources) {
    Object.assign(profile.resources, overrides.resources)
  }
  if (overrides.filesystem) {
    Object.assign(profile.filesystem, overrides.filesystem)
  }
  if (overrides.process) {
    Object.assign(profile.process, overrides.process)
  }
  if (overrides.level) {
    profile.level = overrides.level
  }
  return profile
}

/** Convert a security profile to Docker run flags */
export function toDockerFlags(profile: SecurityProfile): string[] {
  const flags: string[] = []

  // --- Resources ---
  flags.push(`--cpus=${profile.resources.cpuCores}`)
  flags.push(`--memory=${profile.resources.memoryMb}m`)

  // --- Network ---
  if (!profile.network.allowOutbound) {
    flags.push('--network=none')
  }

  // --- Capabilities ---
  flags.push('--cap-drop=ALL')
  for (const cap of profile.process.allowedCapabilities) {
    flags.push(`--cap-add=${cap}`)
  }

  // --- Security options ---
  flags.push('--security-opt=no-new-privileges')
  if (profile.process.blockedSyscalls.length > 0) {
    // Use a seccomp profile that blocks the listed syscalls.
    // Docker's default seccomp already blocks many; we add explicit blocks.
    for (const syscall of profile.process.blockedSyscalls) {
      flags.push(`--security-opt=seccomp-syscall-deny=${syscall}`)
    }
  }

  // --- Process limits ---
  flags.push(`--pids-limit=${profile.process.maxProcesses}`)

  // --- Filesystem ---
  const isParanoid = profile.filesystem.writablePaths.length <= 1
    && profile.filesystem.useTmpfs
  if (isParanoid) {
    flags.push('--read-only')
  }

  if (profile.filesystem.useTmpfs) {
    const tmpSize = Math.min(profile.resources.diskMb, 512)
    flags.push(`--tmpfs=/tmp:size=${tmpSize}m,noexec,nosuid`)
  }

  for (const mount of profile.filesystem.readOnlyMounts) {
    flags.push(`-v=${mount}:${mount}:ro`)
  }

  return flags
}
