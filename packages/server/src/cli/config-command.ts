/**
 * Config CLI commands — validate and display DzipAgent server configuration.
 */
import { readFileSync } from 'node:fs'

/** Schema of expected config file fields. */
interface ConfigSchema {
  port?: number
  auth?: { mode?: string }
  database?: { url?: string }
  modelRegistry?: Record<string, unknown>
  corsOrigins?: string | string[]
  rateLimit?: { maxRequests?: number; windowMs?: number }
}

/**
 * Validate a DzipAgent config file at the given path.
 * Returns { valid: true, errors: [] } if valid, or { valid: false, errors: [...] } otherwise.
 */
export function configValidate(configPath: string): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  let raw: string
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch {
    return { valid: false, errors: [`Cannot read config file: ${configPath}`] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { valid: false, errors: ['Config file is not valid JSON'] }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, errors: ['Config must be a JSON object'] }
  }

  const config = parsed as Record<string, unknown>

  // Validate port
  if ('port' in config) {
    if (typeof config['port'] !== 'number' || config['port'] < 1 || config['port'] > 65535) {
      errors.push('port must be a number between 1 and 65535')
    }
  }

  // Validate auth
  if ('auth' in config) {
    const auth = config['auth']
    if (typeof auth !== 'object' || auth === null) {
      errors.push('auth must be an object')
    } else {
      const authObj = auth as Record<string, unknown>
      if ('mode' in authObj && typeof authObj['mode'] !== 'string') {
        errors.push('auth.mode must be a string')
      }
    }
  }

  // Validate rateLimit
  if ('rateLimit' in config) {
    const rl = config['rateLimit']
    if (typeof rl !== 'object' || rl === null) {
      errors.push('rateLimit must be an object')
    } else {
      const rlObj = rl as Record<string, unknown>
      if ('maxRequests' in rlObj && (typeof rlObj['maxRequests'] !== 'number' || rlObj['maxRequests'] <= 0)) {
        errors.push('rateLimit.maxRequests must be a positive number')
      }
      if ('windowMs' in rlObj && (typeof rlObj['windowMs'] !== 'number' || rlObj['windowMs'] <= 0)) {
        errors.push('rateLimit.windowMs must be a positive number')
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Read and return the parsed contents of a config file.
 * Returns an empty object if the file cannot be read.
 */
export function configShow(configPath: string): Record<string, unknown> {
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

// Re-export for type consumers
export type { ConfigSchema }
