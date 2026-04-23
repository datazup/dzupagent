/**
 * Configuration validation and typed access helpers.
 */

import type { ForgeConfig } from './config-loader.js';
import type { StructuredOutputStrategy } from '../llm/model-config.js';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushIf(errors: string[], condition: boolean, msg: string): void {
  if (condition) errors.push(msg);
}

const STRUCTURED_OUTPUT_STRATEGIES: StructuredOutputStrategy[] = [
  'anthropic-tool-use',
  'openai-json-schema',
  'generic-parse',
  'fallback-prompt',
];

function isStructuredOutputStrategy(value: unknown): value is StructuredOutputStrategy {
  return typeof value === 'string'
    && STRUCTURED_OUTPUT_STRATEGIES.includes(value as StructuredOutputStrategy);
}

/**
 * Validate a configuration object against the ForgeConfig schema.
 * Returns `{ valid: true, errors: [] }` when the config is acceptable.
 */
export function validateConfig(config: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!isPlainObject(config)) {
    return { valid: false, errors: ['Config must be a plain object'] };
  }

  const c = config as Record<string, unknown>;

  // providers
  if (c['providers'] !== undefined) {
    pushIf(errors, !Array.isArray(c['providers']), 'providers must be an array');
    if (Array.isArray(c['providers'])) {
      for (let i = 0; i < (c['providers'] as unknown[]).length; i++) {
        const p = (c['providers'] as unknown[])[i];
        pushIf(errors, !isPlainObject(p), `providers[${i}] must be an object`);
        if (isPlainObject(p)) {
          pushIf(errors, typeof p['provider'] !== 'string', `providers[${i}].provider must be a string`);
          pushIf(
            errors,
            p['apiKey'] !== undefined && typeof p['apiKey'] !== 'string',
            `providers[${i}].apiKey must be a string`,
          );
          pushIf(
            errors,
            p['baseUrl'] !== undefined && typeof p['baseUrl'] !== 'string',
            `providers[${i}].baseUrl must be a string`,
          );
          pushIf(
            errors,
            p['priority'] !== undefined && (typeof p['priority'] !== 'number' || !Number.isFinite(p['priority'])),
            `providers[${i}].priority must be a finite number`,
          );

          const structuredOutputDefaults = p['structuredOutputDefaults'];
          pushIf(
            errors,
            structuredOutputDefaults !== undefined && !isPlainObject(structuredOutputDefaults),
            `providers[${i}].structuredOutputDefaults must be an object`,
          );
          if (isPlainObject(structuredOutputDefaults)) {
            pushIf(
              errors,
              !isStructuredOutputStrategy(structuredOutputDefaults['preferredStrategy']),
              `providers[${i}].structuredOutputDefaults.preferredStrategy must be a supported strategy`,
            );
            pushIf(
              errors,
              structuredOutputDefaults['schemaProvider'] !== undefined
                && structuredOutputDefaults['schemaProvider'] !== 'generic'
                && structuredOutputDefaults['schemaProvider'] !== 'openai',
              `providers[${i}].structuredOutputDefaults.schemaProvider must be "generic" or "openai"`,
            );
            pushIf(
              errors,
              structuredOutputDefaults['fallbackStrategies'] !== undefined
                && !Array.isArray(structuredOutputDefaults['fallbackStrategies']),
              `providers[${i}].structuredOutputDefaults.fallbackStrategies must be an array`,
            );
            if (Array.isArray(structuredOutputDefaults['fallbackStrategies'])) {
              for (let j = 0; j < structuredOutputDefaults['fallbackStrategies'].length; j++) {
                pushIf(
                  errors,
                  !isStructuredOutputStrategy(structuredOutputDefaults['fallbackStrategies'][j]),
                  `providers[${i}].structuredOutputDefaults.fallbackStrategies[${j}] must be a supported strategy`,
                );
              }
            }
          }
        }
      }
    }
  }

  // models
  if (c['models'] !== undefined) {
    pushIf(errors, !isPlainObject(c['models']), 'models must be an object');
    if (isPlainObject(c['models'])) {
      const m = c['models'] as Record<string, unknown>;
      for (const tier of ['chat', 'codegen', 'reasoning'] as const) {
        if (m[tier] !== undefined) {
          pushIf(errors, typeof m[tier] !== 'string', `models.${tier} must be a string`);
        }
      }
    }
  }

  // memory
  if (c['memory'] !== undefined) {
    pushIf(errors, !isPlainObject(c['memory']), 'memory must be an object');
    if (isPlainObject(c['memory'])) {
      const store = (c['memory'] as Record<string, unknown>)['store'];
      if (store !== undefined) {
        pushIf(errors, store !== 'postgres' && store !== 'in-memory', 'memory.store must be "postgres" or "in-memory"');
      }
    }
  }

  // server
  if (c['server'] !== undefined) {
    pushIf(errors, !isPlainObject(c['server']), 'server must be an object');
    if (isPlainObject(c['server'])) {
      const s = c['server'] as Record<string, unknown>;
      if (s['port'] !== undefined) {
        pushIf(errors, typeof s['port'] !== 'number' || s['port'] < 0 || s['port'] > 65535, 'server.port must be a number 0-65535');
      }
      if (s['corsOrigins'] !== undefined) {
        pushIf(errors, !Array.isArray(s['corsOrigins']), 'server.corsOrigins must be an array');
      }
    }
  }

  // plugins
  if (c['plugins'] !== undefined) {
    pushIf(errors, !Array.isArray(c['plugins']), 'plugins must be an array');
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Typed access
// ---------------------------------------------------------------------------

/**
 * Get a nested config value by dot-delimited path with a typed fallback.
 *
 * @example
 *   getConfigValue(config, 'server.port', 3000)       // number
 *   getConfigValue(config, 'models.chat', 'haiku')     // string
 */
export function getConfigValue<T>(config: ForgeConfig, path: string, fallback: T): T {
  const segments = path.split('.');
  let current: unknown = config;

  for (const segment of segments) {
    if (!isPlainObject(current)) return fallback;
    current = (current as Record<string, unknown>)[segment];
  }

  if (current === undefined || current === null) return fallback;
  return current as T;
}
