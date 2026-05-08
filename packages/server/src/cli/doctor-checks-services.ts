/**
 * Asynchronous service-layer checks for `forge doctor`.
 *
 * Covers LLM provider configuration, the in-process memory service,
 * and `@dzupagent/*` package version consistency.
 */

import type { CheckCategory, CheckResult, DoctorContext } from './doctor-types.js'

// ---------------------------------------------------------------------------
// Model / LLM provider configuration
// ---------------------------------------------------------------------------

/**
 * Validate that at least one supported LLM provider has a key configured
 * and (when a probe is supplied) that the key is functional.
 */
export async function checkModelConfiguration(ctx: DoctorContext): Promise<CheckCategory> {
  const env = ctx.env ?? process.env
  const checks: CheckResult[] = []

  const providers: Array<{ name: string; keyEnv: string }> = [
    { name: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY' },
    { name: 'openai', keyEnv: 'OPENAI_API_KEY' },
  ]

  for (const { name, keyEnv } of providers) {
    const apiKey = env[keyEnv]
    if (!apiKey) {
      checks.push({
        name: `${name} provider`,
        status: 'warn',
        message: `${keyEnv} not set — ${name} models unavailable`,
      })
      continue
    }

    if (ctx.pingLLM) {
      try {
        const model = await ctx.pingLLM(name, apiKey)
        checks.push({
          name: `${name} provider`,
          status: 'pass',
          message: `Connected successfully (model: ${model})`,
        })
      } catch (err) {
        checks.push({
          name: `${name} provider`,
          status: 'fail',
          message: `Ping failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    } else {
      // Key is present but we cannot ping — partial validation
      const masked = apiKey.slice(0, 8) + '...'
      checks.push({
        name: `${name} provider`,
        status: 'pass',
        message: `API key present (${masked})`,
      })
    }
  }

  return { category: 'Model Configuration', checks }
}

// ---------------------------------------------------------------------------
// Memory service
// ---------------------------------------------------------------------------

/** Probe the memory service initialisation state and embedding provider. */
export async function checkMemoryService(ctx: DoctorContext): Promise<CheckCategory> {
  const checks: CheckResult[] = []

  if (!ctx.pingMemory) {
    checks.push({
      name: 'Memory service',
      status: 'warn',
      message: 'No memory probe provided — skipping',
    })
    return { category: 'Memory Service', checks }
  }

  try {
    const result = await ctx.pingMemory()
    checks.push({
      name: 'Memory initialization',
      status: result.initialized ? 'pass' : 'fail',
      message: result.initialized ? 'Initialized' : 'Not initialized',
    })

    if (result.embeddingProvider) {
      checks.push({
        name: 'Embedding provider',
        status: 'pass',
        message: `Using ${result.embeddingProvider}`,
      })
    } else {
      checks.push({
        name: 'Embedding provider',
        status: 'warn',
        message: 'No embedding provider detected — semantic search unavailable',
      })
    }
  } catch (err) {
    checks.push({
      name: 'Memory service',
      status: 'fail',
      message: `Probe failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  return { category: 'Memory Service', checks }
}

// ---------------------------------------------------------------------------
// Package versions
// ---------------------------------------------------------------------------

/**
 * Detect installed `@dzupagent/*` package versions and warn on mixed
 * versions that may cause runtime incompatibilities.
 */
export async function checkPackageVersions(ctx: DoctorContext): Promise<CheckCategory> {
  const checks: CheckResult[] = []

  if (!ctx.getPackageVersions) {
    // Use a built-in fallback with the known server version
    checks.push({
      name: '@dzupagent/server',
      status: 'pass',
      message: 'v0.1.0 (self)',
    })
    return { category: 'Package Versions', checks }
  }

  try {
    const versions = await ctx.getPackageVersions()
    const entries = Object.entries(versions)

    if (entries.length === 0) {
      checks.push({
        name: 'Packages',
        status: 'warn',
        message: 'No @dzupagent/* packages detected',
      })
    } else {
      // Check version consistency
      const versionSet = new Set(entries.map(([, v]) => v))
      const consistent = versionSet.size <= 1

      for (const [pkg, version] of entries) {
        checks.push({
          name: pkg,
          status: 'pass',
          message: `v${version}`,
        })
      }

      if (!consistent) {
        checks.push({
          name: 'Version consistency',
          status: 'warn',
          message: `Mixed versions detected: ${[...versionSet].join(', ')} — may cause compatibility issues`,
        })
      } else {
        checks.push({
          name: 'Version consistency',
          status: 'pass',
          message: 'All packages on the same version',
        })
      }
    }
  } catch (err) {
    checks.push({
      name: 'Package detection',
      status: 'warn',
      message: `Could not detect packages: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  return { category: 'Package Versions', checks }
}
