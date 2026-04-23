import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  DEFAULT_CONFIG,
  loadEnvConfig,
  loadFileConfig,
  mergeConfigs,
  resolveConfig,
  validateConfig,
  getConfigValue,
} from '../config/index.js';
import type { ForgeConfig, ConfigLayer } from '../config/index.js';

// ---------------------------------------------------------------------------
// loadEnvConfig
// ---------------------------------------------------------------------------

describe('loadEnvConfig', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('DZIP_')) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, origEnv);
  });

  it('returns empty partial when no DZIP_ vars set', () => {
    const config = loadEnvConfig();
    expect(config).toEqual({});
  });

  it('parses DZIP_PORT', () => {
    process.env['DZIP_PORT'] = '8080';
    const config = loadEnvConfig();
    expect(config.server?.port).toBe(8080);
  });

  it('parses DZIP_MEMORY_STORE', () => {
    process.env['DZIP_MEMORY_STORE'] = 'postgres';
    process.env['DZIP_MEMORY_CONN'] = 'postgresql://localhost/db';
    const config = loadEnvConfig();
    expect(config.memory?.store).toBe('postgres');
    expect(config.memory?.connectionString).toBe('postgresql://localhost/db');
  });

  it('ignores invalid DZIP_MEMORY_STORE values', () => {
    process.env['DZIP_MEMORY_STORE'] = 'sqlite';
    const config = loadEnvConfig();
    expect(config.memory).toBeUndefined();
  });

  it('parses DZIP_MODEL_* vars', () => {
    process.env['DZIP_MODEL_CHAT'] = 'gpt-4o-mini';
    const config = loadEnvConfig();
    expect(config.models?.chat).toBe('gpt-4o-mini');
    // Fills defaults for unset tiers
    expect(config.models?.codegen).toBe(DEFAULT_CONFIG.models.codegen);
  });

  it('parses DZIP_PROVIDERS JSON', () => {
    process.env['DZIP_PROVIDERS'] = JSON.stringify([
      {
        provider: 'anthropic',
        priority: 1,
        structuredOutputDefaults: {
          preferredStrategy: 'anthropic-tool-use',
          schemaProvider: 'generic',
          fallbackStrategies: ['generic-parse', 'fallback-prompt'],
        },
      },
    ]);
    const config = loadEnvConfig();
    expect(config.providers).toHaveLength(1);
    expect(config.providers![0].provider).toBe('anthropic');
    expect(config.providers![0].structuredOutputDefaults).toEqual({
      preferredStrategy: 'anthropic-tool-use',
      schemaProvider: 'generic',
      fallbackStrategies: ['generic-parse', 'fallback-prompt'],
    });
  });

  it('hydrates known provider structured-output defaults in DZIP_PROVIDERS when omitted', () => {
    process.env['DZIP_PROVIDERS'] = JSON.stringify([
      {
        provider: 'google',
        priority: 1,
      },
    ]);
    const config = loadEnvConfig();
    expect(config.providers).toEqual([{
      provider: 'google',
      priority: 1,
      structuredOutputDefaults: {
        preferredStrategy: 'openai-json-schema',
        schemaProvider: 'openai',
        fallbackStrategies: ['generic-parse', 'fallback-prompt'],
      },
    }]);
  });

  it('ignores malformed DZIP_PROVIDERS JSON', () => {
    process.env['DZIP_PROVIDERS'] = 'not-json';
    const config = loadEnvConfig();
    expect(config.providers).toBeUndefined();
  });

  it('parses DZIP_CORS_ORIGINS as comma-separated', () => {
    process.env['DZIP_CORS_ORIGINS'] = 'http://a.com, http://b.com';
    const config = loadEnvConfig();
    expect(config.server?.corsOrigins).toEqual(['http://a.com', 'http://b.com']);
  });

  it('parses DZIP_PLUGINS as comma-separated', () => {
    process.env['DZIP_PLUGINS'] = './a.js, ./b.js';
    const config = loadEnvConfig();
    expect(config.plugins).toEqual(['./a.js', './b.js']);
  });

  it('parses security booleans', () => {
    process.env['DZIP_SECURITY_SECRETS_SCANNING'] = 'false';
    const config = loadEnvConfig();
    expect(config.security?.secretsScanning).toBe(false);
    expect(config.security?.riskClassification).toBe(true); // default
  });
});

// ---------------------------------------------------------------------------
// loadFileConfig
// ---------------------------------------------------------------------------

describe('loadFileConfig', () => {
  const tmpDir = join(tmpdir(), 'forge-config-test-' + Date.now());

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid JSON config file', async () => {
    const filePath = join(tmpDir, 'forge.json');
    await writeFile(filePath, JSON.stringify({
      models: { chat: 'gpt-4o' },
      providers: [{
        provider: 'custom',
        baseUrl: 'https://gateway.example/v1',
        structuredOutputDefaults: {
          preferredStrategy: 'generic-parse',
          schemaProvider: 'generic',
          fallbackStrategies: ['fallback-prompt'],
        },
      }],
    }));
    const config = await loadFileConfig(filePath);
    expect(config.models).toEqual({ chat: 'gpt-4o' });
    expect(config.providers).toEqual([{
      provider: 'custom',
      baseUrl: 'https://gateway.example/v1',
      structuredOutputDefaults: {
        preferredStrategy: 'generic-parse',
        schemaProvider: 'generic',
        fallbackStrategies: ['fallback-prompt'],
      },
    }]);
  });

  it('hydrates known provider structured-output defaults from file config when omitted', async () => {
    const filePath = join(tmpDir, 'forge.json');
    await writeFile(filePath, JSON.stringify({
      providers: [{
        provider: 'openrouter',
        baseUrl: 'https://openrouter.example/v1',
      }],
    }));
    const config = await loadFileConfig(filePath);
    expect(config.providers).toEqual([{
      provider: 'openrouter',
      baseUrl: 'https://openrouter.example/v1',
      structuredOutputDefaults: {
        preferredStrategy: 'generic-parse',
        schemaProvider: 'generic',
        fallbackStrategies: ['fallback-prompt'],
      },
    }]);
  });

  it('returns empty partial for missing file', async () => {
    const config = await loadFileConfig(join(tmpDir, 'nope.json'));
    expect(config).toEqual({});
  });

  it('returns empty partial for invalid JSON', async () => {
    const filePath = join(tmpDir, 'bad.json');
    await writeFile(filePath, '{ invalid json }}}');
    const config = await loadFileConfig(filePath);
    expect(config).toEqual({});
  });

  it('returns empty partial for non-object JSON', async () => {
    const filePath = join(tmpDir, 'array.json');
    await writeFile(filePath, '[1,2,3]');
    const config = await loadFileConfig(filePath);
    expect(config).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// mergeConfigs
// ---------------------------------------------------------------------------

describe('mergeConfigs', () => {
  it('returns defaults when no layers provided', () => {
    const result = mergeConfigs();
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it('higher priority layer wins for scalar values', () => {
    const low: ConfigLayer = {
      name: 'low',
      priority: 10,
      config: { server: { port: 4000, corsOrigins: ['http://a.com'], rateLimit: { maxRequests: 50, windowMs: 60000 } } },
    };
    const high: ConfigLayer = {
      name: 'high',
      priority: 20,
      config: { server: { port: 5000, corsOrigins: ['http://b.com'], rateLimit: { maxRequests: 200, windowMs: 30000 } } },
    };
    const result = mergeConfigs(high, low); // order shouldn't matter
    expect(result.server.port).toBe(5000);
  });

  it('arrays replace rather than concatenate', () => {
    const base: ConfigLayer = {
      name: 'base',
      priority: 10,
      config: { plugins: ['a.js', 'b.js'] },
    };
    const override: ConfigLayer = {
      name: 'override',
      priority: 20,
      config: { plugins: ['c.js'] },
    };
    const result = mergeConfigs(base, override);
    expect(result.plugins).toEqual(['c.js']);
  });

  it('deep merges nested objects', () => {
    const layer: ConfigLayer = {
      name: 'partial',
      priority: 20,
      config: { models: { chat: 'gpt-4o', codegen: 'codestral', reasoning: 'o1' } },
    };
    const result = mergeConfigs(layer);
    expect(result.models.chat).toBe('gpt-4o');
    // Other defaults preserved
    expect(result.memory.store).toBe('in-memory');
  });

  it('normalizes known provider structured-output defaults after merge', () => {
    const result = mergeConfigs({
      name: 'runtime',
      priority: 20,
      config: {
        providers: [{
          provider: 'qwen',
          apiKey: 'qwen-key',
        }],
      },
    });

    expect(result.providers).toEqual([{
      provider: 'qwen',
      apiKey: 'qwen-key',
      structuredOutputDefaults: {
        preferredStrategy: 'openai-json-schema',
        schemaProvider: 'openai',
        fallbackStrategies: ['generic-parse', 'fallback-prompt'],
      },
    }]);
  });
});

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

describe('resolveConfig', () => {
  const tmpDir = join(tmpdir(), 'forge-resolve-test-' + Date.now());

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('DZIP_')) delete process.env[key];
    }
  });

  it('returns defaults with no options', async () => {
    const result = await resolveConfig();
    expect(result.server.port).toBe(DEFAULT_CONFIG.server.port);
  });

  it('file config overrides defaults', async () => {
    const filePath = join(tmpDir, 'forge.json');
    await writeFile(filePath, JSON.stringify({ server: { port: 9000, corsOrigins: [], rateLimit: { maxRequests: 10, windowMs: 1000 } } }));
    const result = await resolveConfig({ configFile: filePath });
    expect(result.server.port).toBe(9000);
  });

  it('env overrides file config', async () => {
    const filePath = join(tmpDir, 'forge.json');
    await writeFile(filePath, JSON.stringify({ server: { port: 9000, corsOrigins: [], rateLimit: { maxRequests: 10, windowMs: 1000 } } }));
    process.env['DZIP_PORT'] = '7777';
    const result = await resolveConfig({ configFile: filePath });
    expect(result.server.port).toBe(7777);
  });

  it('runtime overrides everything', async () => {
    process.env['DZIP_PORT'] = '7777';
    const result = await resolveConfig({
      runtimeOverrides: { server: { port: 1111, corsOrigins: [], rateLimit: { maxRequests: 1, windowMs: 1 } } },
    });
    expect(result.server.port).toBe(1111);
  });

  it('normalizes provider defaults in runtime overrides during resolveConfig', async () => {
    const result = await resolveConfig({
      runtimeOverrides: {
        providers: [{
          provider: 'google',
          apiKey: 'google-key',
        }],
      },
    });

    expect(result.providers).toEqual([{
      provider: 'google',
      apiKey: 'google-key',
      structuredOutputDefaults: {
        preferredStrategy: 'openai-json-schema',
        schemaProvider: 'openai',
        fallbackStrategies: ['generic-parse', 'fallback-prompt'],
      },
    }]);
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  it('accepts valid config', () => {
    const { valid, errors } = validateConfig(DEFAULT_CONFIG);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('rejects non-object', () => {
    const { valid, errors } = validateConfig('string');
    expect(valid).toBe(false);
    expect(errors).toContain('Config must be a plain object');
  });

  it('rejects invalid providers', () => {
    const { valid, errors } = validateConfig({ providers: 'not-array' });
    expect(valid).toBe(false);
    expect(errors[0]).toContain('providers must be an array');
  });

  it('rejects provider without provider field', () => {
    const { valid, errors } = validateConfig({ providers: [{ apiKey: 'abc' }] });
    expect(valid).toBe(false);
    expect(errors[0]).toContain('providers[0].provider must be a string');
  });

  it('rejects invalid memory store', () => {
    const { valid, errors } = validateConfig({ memory: { store: 'sqlite' } });
    expect(valid).toBe(false);
    expect(errors[0]).toContain('memory.store must be "postgres" or "in-memory"');
  });

  it('rejects invalid port', () => {
    const { valid, errors } = validateConfig({ server: { port: 99999 } });
    expect(valid).toBe(false);
    expect(errors[0]).toContain('server.port must be a number 0-65535');
  });

  it('accepts partial config (empty object)', () => {
    const { valid } = validateConfig({});
    expect(valid).toBe(true);
  });

  it('accepts provider structured-output defaults', () => {
    const { valid, errors } = validateConfig({
      providers: [{
        provider: 'custom',
        baseUrl: 'https://gateway.example/v1',
        structuredOutputDefaults: {
          preferredStrategy: 'generic-parse',
          schemaProvider: 'generic',
          fallbackStrategies: ['fallback-prompt'],
        },
      }],
    });
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  it('rejects invalid provider structured-output defaults', () => {
    const { valid, errors } = validateConfig({
      providers: [{
        provider: 'custom',
        structuredOutputDefaults: {
          preferredStrategy: 'not-a-strategy',
        },
      }],
    });
    expect(valid).toBe(false);
    expect(errors[0]).toContain('providers[0].structuredOutputDefaults.preferredStrategy');
  });
});

// ---------------------------------------------------------------------------
// getConfigValue
// ---------------------------------------------------------------------------

describe('getConfigValue', () => {
  it('retrieves nested value by dot path', () => {
    const val = getConfigValue(DEFAULT_CONFIG, 'server.port', 0);
    expect(val).toBe(3000);
  });

  it('returns fallback for missing path', () => {
    const val = getConfigValue(DEFAULT_CONFIG, 'server.nonexistent', 42);
    expect(val).toBe(42);
  });

  it('returns fallback for deeply missing path', () => {
    const val = getConfigValue(DEFAULT_CONFIG, 'a.b.c.d', 'nope');
    expect(val).toBe('nope');
  });

  it('retrieves top-level value', () => {
    const val = getConfigValue(DEFAULT_CONFIG, 'plugins', ['fallback']);
    expect(val).toEqual([]);
  });

  it('retrieves models.chat', () => {
    const val = getConfigValue(DEFAULT_CONFIG, 'models.chat', '');
    expect(val).toBe('claude-haiku');
  });
});
