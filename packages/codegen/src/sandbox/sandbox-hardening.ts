/**
 * Sandbox hardening — security configuration for containerized execution.
 *
 * Provides seccomp profiles, filesystem ACLs, network egress rules,
 * resource limits, and conversion to Docker CLI security flags.
 *
 * Complements the existing SecurityProfile in security-profile.ts
 * with finer-grained controls (ACLs, egress rules, escape detection).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SeccompProfile = 'default' | 'strict' | 'nodejs' | 'custom'

export interface FilesystemACL {
  /** Path inside the container */
  path: string
  /** Access level for this path */
  access: 'read' | 'write' | 'none'
}

export interface EgressRule {
  /** Target host (domain or IP) */
  host: string
  /** Target port (omit for any port) */
  port?: number
  /** Protocol (default: 'tcp') */
  protocol?: 'tcp' | 'udp'
}

export interface HardenedSandboxConfig {
  /** Seccomp profile to apply (default: 'default') */
  seccompProfile?: SeccompProfile
  /** Fine-grained filesystem ACLs */
  filesystemACLs?: FilesystemACL[]
  /** Allowed outbound network rules (empty = no egress) */
  egressRules?: EgressRule[]
  /** Memory limit in MB */
  memoryLimitMb?: number
  /** CPU core limit (fractional, e.g. 0.5) */
  cpuLimit?: number
  /** Max number of processes/threads */
  pidLimit?: number
  /** Soft timeout — SIGTERM after this many ms */
  softTimeoutMs?: number
  /** Hard timeout — SIGKILL after this many ms */
  hardTimeoutMs?: number
  /** Drop ALL Linux capabilities (default: true) */
  dropAllCapabilities?: boolean
  /** Capabilities to add back (only meaningful if dropAllCapabilities is true) */
  addCapabilities?: string[]
}

export interface HardenedExecResult {
  exitCode: number
  stdout: string
  stderr: string
  /** Whether the process was killed due to OOM */
  oomKilled: boolean
  /** Peak memory usage in bytes */
  peakMemoryBytes: number
  /** Whether a container escape attempt was detected */
  escapeAttemptDetected: boolean
  /** Whether the hard timeout was reached and SIGKILL was sent */
  hardKilled: boolean
  /** Total wall-clock duration in ms */
  durationMs: number
}

// ---------------------------------------------------------------------------
// Seccomp profiles
// ---------------------------------------------------------------------------

/**
 * Blocked syscalls per seccomp profile.
 * 'default' uses Docker's built-in profile (no extra flags).
 * 'strict' blocks common escape vectors.
 * 'nodejs' blocks escape vectors but allows Node.js runtime syscalls.
 * 'custom' is user-defined — returns empty list (caller provides their own).
 */
const SECCOMP_BLOCKED_SYSCALLS: Record<SeccompProfile, string[]> = {
  default: [],
  strict: [
    'ptrace', 'mount', 'umount2', 'unshare', 'clone3',
    'pivot_root', 'chroot', 'keyctl', 'add_key', 'request_key',
    'kexec_load', 'reboot', 'swapon', 'swapoff',
  ],
  nodejs: [
    'ptrace', 'mount', 'umount2', 'unshare',
    'pivot_root', 'chroot', 'keyctl', 'add_key', 'request_key',
    'kexec_load', 'reboot',
  ],
  custom: [],
}

// ---------------------------------------------------------------------------
// Docker flag conversion
// ---------------------------------------------------------------------------

/**
 * Convert a HardenedSandboxConfig into Docker CLI security flags.
 *
 * These flags can be appended to a `docker run` command.
 */
export function toDockerSecurityFlags(config: HardenedSandboxConfig): string[] {
  const flags: string[] = []

  // --- Capabilities ---
  const dropAll = config.dropAllCapabilities ?? true
  if (dropAll) {
    flags.push('--cap-drop=ALL')
  }
  if (config.addCapabilities) {
    for (const cap of config.addCapabilities) {
      flags.push(`--cap-add=${cap}`)
    }
  }

  // --- Security options ---
  flags.push('--security-opt=no-new-privileges')

  // --- Seccomp ---
  const profile = config.seccompProfile ?? 'default'
  const blocked = SECCOMP_BLOCKED_SYSCALLS[profile]
  for (const syscall of blocked) {
    flags.push(`--security-opt=seccomp-syscall-deny=${syscall}`)
  }

  // --- Resource limits ---
  if (config.memoryLimitMb !== undefined) {
    flags.push(`--memory=${config.memoryLimitMb}m`)
  }
  if (config.cpuLimit !== undefined) {
    flags.push(`--cpus=${config.cpuLimit}`)
  }
  if (config.pidLimit !== undefined) {
    flags.push(`--pids-limit=${config.pidLimit}`)
  }

  // --- Timeouts ---
  if (config.hardTimeoutMs !== undefined) {
    // Docker --stop-timeout is in seconds
    const stopTimeoutSec = Math.ceil(config.hardTimeoutMs / 1000)
    flags.push(`--stop-timeout=${stopTimeoutSec}`)
  }

  // --- Network ---
  if (!config.egressRules || config.egressRules.length === 0) {
    flags.push('--network=none')
  }

  // --- Filesystem ACLs ---
  if (config.filesystemACLs) {
    // read-only root filesystem
    const hasNoWritePaths = config.filesystemACLs.every((acl) => acl.access !== 'write')
    if (hasNoWritePaths) {
      flags.push('--read-only')
    }

    for (const acl of config.filesystemACLs) {
      switch (acl.access) {
        case 'read':
          flags.push(`--tmpfs=${acl.path}:ro,size=0`)
          break
        case 'write':
          flags.push(`--tmpfs=${acl.path}:rw,size=100m`)
          break
        case 'none':
          // Mount an empty, unreadable tmpfs
          flags.push(`--tmpfs=${acl.path}:ro,size=0,noexec`)
          break
      }
    }
  }

  return flags
}

// ---------------------------------------------------------------------------
// Escape detection helpers
// ---------------------------------------------------------------------------

/** Patterns that indicate a potential container escape attempt */
const ESCAPE_PATTERNS: RegExp[] = [
  /nsenter/,
  /docker\.sock/,
  /\/proc\/1\/root/,
  /mount\s+.*-t\s+cgroup/,
  /chroot\s/,
  /pivot_root\s/,
  /unshare\s+--mount/,
]

/** Check if a command string contains escape attempt patterns */
export function detectEscapeAttempt(command: string): boolean {
  return ESCAPE_PATTERNS.some((pattern) => pattern.test(command))
}
