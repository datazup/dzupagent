import { ForgeError } from '../errors/forge-error.js'

/** Environment variables that must never be overridden by MCP server config */
const BLOCKED_ENV_VARS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_DEBUG',
  'ELECTRON_RUN_AS_NODE',
  'PATH',
])

/** Characters that should not appear in executable paths */
const UNSAFE_PATH_CHARS = /[;&|`$(){}[\]<>!#~]/

/**
 * Validate an MCP server executable path.
 * Blocks paths with shell metacharacters and relative traversals.
 */
export function validateMcpExecutablePath(path: string): void {
  if (!path || path.trim().length === 0) {
    throw new ForgeError({
      code: 'MCP_CONNECTION_FAILED',
      message: 'MCP server executable path is empty',
      recoverable: false,
    })
  }

  if (UNSAFE_PATH_CHARS.test(path)) {
    throw new ForgeError({
      code: 'MCP_CONNECTION_FAILED',
      message: `MCP server executable path contains unsafe characters: ${path}`,
      recoverable: false,
      context: { path },
    })
  }

  // Block obvious traversal attempts
  if (path.includes('..')) {
    throw new ForgeError({
      code: 'MCP_CONNECTION_FAILED',
      message: `MCP server executable path contains directory traversal: ${path}`,
      recoverable: false,
      context: { path },
    })
  }
}

/**
 * Sanitize environment variables for MCP child processes.
 * Removes dangerous variables that could be used for code injection.
 */
export function sanitizeMcpEnv(
  baseEnv: Record<string, string | undefined>,
  serverEnv?: Record<string, string>,
): Record<string, string | undefined> {
  const result = { ...baseEnv }

  if (serverEnv) {
    for (const [key, value] of Object.entries(serverEnv)) {
      if (BLOCKED_ENV_VARS.has(key.toUpperCase())) {
        // Silently skip blocked vars — don't throw, just don't apply
        continue
      }
      result[key] = value
    }
  }

  return result
}
