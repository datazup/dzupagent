/**
 * Shared types and terminal helpers for the `forge doctor` CLI command.
 *
 * Sibling check modules import {@link CheckResult} / {@link CheckCategory}
 * to build their results, and the runner/formatter consume the assembled
 * {@link DoctorReport}.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status of an individual diagnostic check. */
export type CheckStatus = 'pass' | 'warn' | 'fail'

/** A single diagnostic check result. */
export interface CheckResult {
  /** Human-readable name of the check. */
  name: string
  /** pass / warn / fail */
  status: CheckStatus
  /** Short message explaining the result. */
  message: string
  /** Optional auto-fix that was attempted (only with --fix). */
  fix?: string
}

/** A group of related check results. */
export interface CheckCategory {
  /** Category label (e.g. "Environment", "Database Health"). */
  category: string
  /** Individual results in this category. */
  checks: CheckResult[]
}

/** Full doctor report. */
export interface DoctorReport {
  categories: CheckCategory[]
  summary: {
    passed: number
    warnings: number
    failures: number
    total: number
  }
  timestamp: string
}

/** Options for running the doctor command. */
export interface DoctorOptions {
  /** When true, attempt auto-fixes for common issues. */
  fix?: boolean
  /** When true, return raw JSON report instead of formatted output. */
  json?: boolean
}

/**
 * Injectable context — allows the doctor command to be tested without
 * real external dependencies. Every field is optional; the check is
 * skipped (with a "warn") if its dependency is not provided.
 */
export interface DoctorContext {
  /** Environment variables to inspect (defaults to process.env). */
  env?: Record<string, string | undefined>
  /** Attempt a Postgres connection. Return latency in ms or throw. */
  pingDatabase?: () => Promise<number>
  /** Attempt a Redis connection. Return latency in ms or throw. */
  pingRedis?: () => Promise<number>
  /** Ping an LLM provider. Return the provider name or throw. */
  pingLLM?: (provider: string, apiKey: string) => Promise<string>
  /** Check if database migrations are up to date. Return true if current. */
  checkMigrations?: () => Promise<boolean>
  /** Check vector store health. */
  pingVectorStore?: () => Promise<{ provider: string; healthy: boolean; latencyMs: number }>
  /** Read queue stats. */
  getQueueStats?: () => Promise<{ pending: number; active: number; failed: number }>
  /** Check OTEL exporter reachability. */
  pingOtel?: () => Promise<boolean>
  /** Check memory service initialization. */
  pingMemory?: () => Promise<{ initialized: boolean; embeddingProvider?: string }>
  /** Retrieve installed @dzupagent/* package versions. */
  getPackageVersions?: () => Promise<Record<string, string>>
  /** CORS origins as configured. */
  corsOrigins?: string | string[]
  /** Whether API key auth is enabled. */
  authEnabled?: boolean
  /** Whether the audit trail is active. */
  auditTrailEnabled?: boolean
}

// ---------------------------------------------------------------------------
// ANSI helpers (for terminal output)
// ---------------------------------------------------------------------------

/** ANSI escape codes used by the terminal formatter. */
export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
} as const

/** Render a status icon with ANSI colour for terminal output. */
export function statusIcon(status: CheckStatus): string {
  switch (status) {
    case 'pass': return `${ANSI.green}[PASS]${ANSI.reset}`
    case 'warn': return `${ANSI.yellow}[WARN]${ANSI.reset}`
    case 'fail': return `${ANSI.red}[FAIL]${ANSI.reset}`
  }
}
