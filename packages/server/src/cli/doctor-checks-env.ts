/**
 * Synchronous environment + security posture checks for `forge doctor`.
 *
 * These checks need no external probes — they read process env vars and
 * the {@link DoctorContext} flags that the host wires up at startup.
 */

import type { CheckCategory, CheckResult, DoctorContext } from './doctor-types.js'

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

/**
 * Validate required and optional environment variables.
 *
 * - `DATABASE_URL` is required.
 * - At least one LLM provider key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) is required.
 * - `REDIS_URL` is optional but recommended.
 */
export function checkEnvVars(ctx: DoctorContext, fix: boolean): CheckCategory {
  const env = ctx.env ?? process.env
  const checks: CheckResult[] = []

  // Required env vars
  const required: Array<{ key: string; description: string }> = [
    { key: 'DATABASE_URL', description: 'PostgreSQL connection string' },
  ]

  for (const { key, description } of required) {
    if (env[key]) {
      checks.push({ name: key, status: 'pass', message: `${description} is set` })
    } else {
      const result: CheckResult = {
        name: key,
        status: 'fail',
        message: `${description} is not set`,
      }
      if (fix) {
        result.fix = `Set ${key} in your environment or .env file`
      }
      checks.push(result)
    }
  }

  // At least one LLM API key
  const llmKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']
  const hasLLMKey = llmKeys.some((k) => Boolean(env[k]))

  if (hasLLMKey) {
    const found = llmKeys.filter((k) => Boolean(env[k]))
    checks.push({
      name: 'LLM API Key',
      status: 'pass',
      message: `LLM provider key(s) found: ${found.join(', ')}`,
    })
  } else {
    checks.push({
      name: 'LLM API Key',
      status: 'fail',
      message: 'No LLM API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY',
    })
  }

  // Optional but recommended
  const optional: Array<{ key: string; description: string }> = [
    { key: 'REDIS_URL', description: 'Redis connection string (needed for BullMQ)' },
  ]

  for (const { key, description } of optional) {
    if (env[key]) {
      checks.push({ name: key, status: 'pass', message: `${description} is set` })
    } else {
      checks.push({ name: key, status: 'warn', message: `${description} is not set (optional)` })
    }
  }

  return { category: 'Environment', checks }
}

// ---------------------------------------------------------------------------
// Security posture
// ---------------------------------------------------------------------------

/**
 * Inspect security-relevant configuration: API key auth, CORS, audit trail.
 */
export function checkSecurityPosture(ctx: DoctorContext, fix: boolean): CheckCategory {
  const checks: CheckResult[] = []

  // API key auth
  if (ctx.authEnabled === true) {
    checks.push({
      name: 'API key auth',
      status: 'pass',
      message: 'Enabled',
    })
  } else if (ctx.authEnabled === false) {
    const result: CheckResult = {
      name: 'API key auth',
      status: 'warn',
      message: 'Disabled — API is unprotected',
    }
    if (fix) {
      result.fix = 'Enable auth by setting auth.mode in server config'
    }
    checks.push(result)
  } else {
    checks.push({
      name: 'API key auth',
      status: 'warn',
      message: 'Auth status unknown',
    })
  }

  // CORS
  if (ctx.corsOrigins) {
    const origins = Array.isArray(ctx.corsOrigins) ? ctx.corsOrigins : [ctx.corsOrigins]
    const hasWildcard = origins.includes('*')
    checks.push({
      name: 'CORS config',
      status: hasWildcard ? 'warn' : 'pass',
      message: hasWildcard
        ? 'Wildcard (*) CORS — restrict in production'
        : `Restricted to: ${origins.join(', ')}`,
    })
  } else {
    checks.push({
      name: 'CORS config',
      status: 'warn',
      message: 'No CORS origins configured',
    })
  }

  // Audit trail
  if (ctx.auditTrailEnabled === true) {
    checks.push({
      name: 'Audit trail',
      status: 'pass',
      message: 'Enabled',
    })
  } else {
    checks.push({
      name: 'Audit trail',
      status: 'warn',
      message: 'Not enabled — recommended for production',
    })
  }

  return { category: 'Security Posture', checks }
}
