import type { AdapterConfig, AgentInput, EnvFilterConfig } from '../types.js'
import { ADAPTER_TRACE_ENV_OPTION } from '../observability/adapter-tracer.js'

/** Default patterns for sensitive env vars that should not leak to child processes */
const DEFAULT_SENSITIVE_PATTERNS: RegExp[] = [
  /SECRET/i,
  /PASSWORD/i,
  /PRIVATE_KEY/i,
  /^DATABASE_URL$/i,
  /^JWT_SECRET$/i,
  /^COOKIE_SECRET$/i,
  /TOKEN(?!_LIMIT|_COUNT|S_PER)/i,
]

/**
 * Filter sensitive environment variables based on the provided config.
 *
 * Removes entries whose keys match any blocked pattern, unless the key
 * is explicitly listed in `allowedVars`. Returns a new object; does not
 * mutate the input.
 */
export function filterSensitiveEnvVars(
  env: Record<string, string>,
  config?: EnvFilterConfig,
): Record<string, string> {
  if (config?.disableFilter) {
    return { ...env }
  }
  const patterns = [
    ...DEFAULT_SENSITIVE_PATTERNS,
    ...(config?.blockedPatterns ?? []),
  ]
  const allowed = new Set(config?.allowedVars ?? [])
  const result: Record<string, string> = {}
  for (const key of Object.keys(env)) {
    if (!allowed.has(key) && patterns.some((p) => p.test(key))) {
      continue
    }
    const val = env[key]
    if (val !== undefined) result[key] = val
  }
  return result
}

/**
 * Build the base environment for a child CLI process.
 *
 * Starts from `process.env`, runs it through {@link filterSensitiveEnvVars}
 * using the adapter's `envFilter` config, then layers on any explicit
 * overrides from `config.env`.
 */
export function buildEnv(config: AdapterConfig): Record<string, string> {
  const inherited = filterSensitiveEnvVars(
    { ...process.env } as Record<string, string>,
    config.envFilter,
  )
  const merged = config.env
    ? { ...inherited, ...config.env }
    : inherited

  // Re-apply the same filter after config overrides so sensitive keys cannot
  // bypass filtering via `config.env` unless explicitly allowlisted.
  return filterSensitiveEnvVars(merged, config.envFilter)
}

/**
 * Build the spawn-time environment by combining {@link buildEnv} with any
 * trace-env options carried on the input.
 */
export function buildSpawnEnv(
  config: AdapterConfig,
  input: AgentInput,
): Record<string, string> {
  return filterSensitiveEnvVars(applyTraceEnv(buildEnv(config), input), config.envFilter)
}

/**
 * Layer trace-env options from the input onto an already-built env map.
 * Mutates and returns the same object; safe for callers that need to honor
 * subclass overrides of {@link buildEnv}.
 */
export function applyTraceEnv(
  env: Record<string, string>,
  input: AgentInput,
): Record<string, string> {
  const traceEnv = readTraceEnvOption(input)
  if (traceEnv) {
    Object.assign(env, traceEnv)
  }
  return env
}

function readTraceEnvOption(input: AgentInput): Record<string, string> | undefined {
  const value = input.options?.[ADAPTER_TRACE_ENV_OPTION]
  if (!value || typeof value !== 'object') return undefined

  const env: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      env[key] = raw
    }
  }
  return Object.keys(env).length > 0 ? env : undefined
}
