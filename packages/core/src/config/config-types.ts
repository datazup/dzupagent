import type { StructuredOutputModelCapabilities } from '../llm/model-config.js';

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
