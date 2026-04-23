/**
 * Layered configuration system for DzupAgent.
 *
 * Resolution order (highest priority wins):
 *   runtime overrides > environment variables > config file > defaults
 */

import { readFile } from 'node:fs/promises';
import { validateConfig } from './config-schema.js';
import type { StructuredOutputModelCapabilities } from '../llm/model-config.js';
import {
  getStructuredOutputDefaultsForProviderName,
  normalizeStructuredOutputCapabilities,
} from '../llm/structured-output-capabilities.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  priority?: number;
  structuredOutputDefaults?: StructuredOutputModelCapabilities;
}

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export interface ForgeConfig {
  /** Model provider settings */
  providers: ProviderConfig[];
  /** Default model tiers */
  models: { chat: string; codegen: string; reasoning: string };
  /** Memory settings */
  memory: { store: 'postgres' | 'in-memory'; connectionString?: string };
  /** MCP server connections */
  mcp: Array<{ id: string; url: string; transport: string }>;
  /** Security settings */
  security: {
    riskClassification: boolean;
    secretsScanning: boolean;
    outputSanitization: boolean;
  };
  /** Server settings */
  server: { port: number; corsOrigins: string[]; rateLimit: RateLimitConfig };
  /** Plugin paths */
  plugins: string[];
  /** Custom settings (extensible) */
  custom: Record<string, unknown>;
}

export interface ConfigLayer {
  name: string;
  priority: number;
  config: Partial<ForgeConfig>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: ForgeConfig = {
  providers: [],
  models: { chat: 'claude-haiku', codegen: 'claude-sonnet', reasoning: 'claude-sonnet' },
  memory: { store: 'in-memory' },
  mcp: [],
  security: { riskClassification: true, secretsScanning: true, outputSanitization: true },
  server: { port: 3000, corsOrigins: ['http://localhost:3000'], rateLimit: { maxRequests: 100, windowMs: 60_000 } },
  plugins: [],
  custom: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep merge `source` into `target`. Arrays replace (not concat). */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (srcVal === undefined) continue;
    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

function tryParseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function normalizeProviderConfig(provider: ProviderConfig): ProviderConfig {
  const structuredOutputDefaults = provider.structuredOutputDefaults
    ? normalizeStructuredOutputCapabilities(provider.structuredOutputDefaults)
    : getStructuredOutputDefaultsForProviderName(provider.provider)

  return structuredOutputDefaults
    ? { ...provider, structuredOutputDefaults }
    : provider
}

function normalizeForgeConfig(config: Partial<ForgeConfig>): Partial<ForgeConfig> {
  return config.providers
    ? { ...config, providers: config.providers.map(normalizeProviderConfig) }
    : config
}

// ---------------------------------------------------------------------------
// loadEnvConfig
// ---------------------------------------------------------------------------

/**
 * Load configuration from environment variables (DZIP_* prefix).
 *
 * Supported variables:
 * - DZIP_PROVIDERS        — JSON array of ProviderConfig
 * - DZIP_MODEL_CHAT       — chat tier model id
 * - DZIP_MODEL_CODEGEN    — codegen tier model id
 * - DZIP_MODEL_REASONING  — reasoning tier model id
 * - DZIP_MEMORY_STORE     — "postgres" | "in-memory"
 * - DZIP_MEMORY_CONN      — connection string
 * - DZIP_PORT             — server port
 * - DZIP_CORS_ORIGINS     — comma-separated origins
 * - DZIP_PLUGINS          — comma-separated plugin paths
 * - DZIP_SECURITY_RISK_CLASSIFICATION  — "true" | "false"
 * - DZIP_SECURITY_SECRETS_SCANNING     — "true" | "false"
 * - DZIP_SECURITY_OUTPUT_SANITIZATION  — "true" | "false"
 */
export function loadEnvConfig(): Partial<ForgeConfig> {
  const env = process.env;
  const config: Partial<ForgeConfig> = {};

  // Providers
  if (env['DZIP_PROVIDERS']) {
    const parsed = tryParseJson<ProviderConfig[]>(env['DZIP_PROVIDERS']);
    if (parsed) config.providers = parsed.map(normalizeProviderConfig);
  }

  // Models
  const chat = env['DZIP_MODEL_CHAT'];
  const codegen = env['DZIP_MODEL_CODEGEN'];
  const reasoning = env['DZIP_MODEL_REASONING'];
  if (chat || codegen || reasoning) {
    config.models = {
      chat: chat ?? DEFAULT_CONFIG.models.chat,
      codegen: codegen ?? DEFAULT_CONFIG.models.codegen,
      reasoning: reasoning ?? DEFAULT_CONFIG.models.reasoning,
    };
  }

  // Memory
  const memStore = env['DZIP_MEMORY_STORE'];
  if (memStore === 'postgres' || memStore === 'in-memory') {
    const connStr = env['DZIP_MEMORY_CONN'];
    config.memory = connStr !== undefined
      ? { store: memStore, connectionString: connStr }
      : { store: memStore };
  }

  // Server
  const port = env['DZIP_PORT'];
  const cors = env['DZIP_CORS_ORIGINS'];
  if (port || cors) {
    config.server = {
      port: port ? Number(port) : DEFAULT_CONFIG.server.port,
      corsOrigins: cors ? cors.split(',').map((s) => s.trim()) : DEFAULT_CONFIG.server.corsOrigins,
      rateLimit: DEFAULT_CONFIG.server.rateLimit,
    };
  }

  // Plugins
  if (env['DZIP_PLUGINS']) {
    config.plugins = env['DZIP_PLUGINS'].split(',').map((s) => s.trim());
  }

  // Security
  const rc = env['DZIP_SECURITY_RISK_CLASSIFICATION'];
  const ss = env['DZIP_SECURITY_SECRETS_SCANNING'];
  const os = env['DZIP_SECURITY_OUTPUT_SANITIZATION'];
  if (rc !== undefined || ss !== undefined || os !== undefined) {
    config.security = {
      riskClassification: rc !== undefined ? rc === 'true' : DEFAULT_CONFIG.security.riskClassification,
      secretsScanning: ss !== undefined ? ss === 'true' : DEFAULT_CONFIG.security.secretsScanning,
      outputSanitization: os !== undefined ? os === 'true' : DEFAULT_CONFIG.security.outputSanitization,
    };
  }

  return config;
}

// ---------------------------------------------------------------------------
// loadFileConfig
// ---------------------------------------------------------------------------

/**
 * Load configuration from a JSON file. Returns empty partial on missing file.
 */
export async function loadFileConfig(filePath: string): Promise<Partial<ForgeConfig>> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return {};
    const result = validateConfig(parsed);
    if (!result.valid) return {};
    return normalizeForgeConfig(parsed as Partial<ForgeConfig>);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// mergeConfigs
// ---------------------------------------------------------------------------

/**
 * Deep merge multiple config layers. Higher priority wins.
 */
export function mergeConfigs(...layers: ConfigLayer[]): ForgeConfig {
  const sorted = [...layers].sort((a, b) => a.priority - b.priority);
  let result: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const layer of sorted) {
    result = deepMerge(result, layer.config as Record<string, unknown>);
  }
  return normalizeForgeConfig(result as unknown as ForgeConfig) as ForgeConfig;
}

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

/**
 * Resolve the full configuration from all sources.
 * Priority: runtime (40) > env (30) > file (20) > defaults (10)
 */
export async function resolveConfig(options?: {
  configFile?: string;
  runtimeOverrides?: Partial<ForgeConfig>;
}): Promise<ForgeConfig> {
  const layers: ConfigLayer[] = [
    { name: 'defaults', priority: 10, config: {} },
  ];

  if (options?.configFile) {
    const fileConfig = await loadFileConfig(options.configFile);
    layers.push({ name: 'file', priority: 20, config: fileConfig });
  }

  const envConfig = loadEnvConfig();
  layers.push({ name: 'env', priority: 30, config: envConfig });

  if (options?.runtimeOverrides) {
    layers.push({ name: 'runtime', priority: 40, config: options.runtimeOverrides });
  }

  return mergeConfigs(...layers);
}
