/**
 * Database connector — connection pool setup and PostgreSQL type mapping.
 *
 * Uses `pg` as an optional peer dependency via dynamic import with graceful
 * failure when the package is not installed.
 */
import type { DatabaseConnectorConfig, PgPool } from './db-types.js'

/** Data-type OID to human-readable name (PostgreSQL common types). */
const PG_TYPE_MAP: Record<number, string> = {
  16: 'boolean',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  114: 'json',
  700: 'float4',
  701: 'float8',
  1043: 'varchar',
  1082: 'date',
  1114: 'timestamp',
  1184: 'timestamptz',
  2950: 'uuid',
  3802: 'jsonb',
}

export function oidToName(oid: number): string {
  return PG_TYPE_MAP[oid] ?? `oid:${oid}`
}

/**
 * Create a pg Pool via dynamic import. Throws a clear message when `pg`
 * is not installed.
 */
export async function createPool(config: DatabaseConnectorConfig): Promise<PgPool> {
  let PgPool: new (opts: Record<string, unknown>) => PgPool
  try {
    const pgModule = await import('pg') as { Pool: typeof PgPool; default?: { Pool: typeof PgPool } }
    // Handle both ESM default export and named export
    PgPool = pgModule.Pool ?? pgModule.default?.Pool ?? (pgModule as unknown as { Pool: typeof PgPool }).Pool
  } catch {
    throw new Error(
      'The "pg" package is required for the database connector. Install it with: npm install pg',
    )
  }

  const poolConfig: Record<string, unknown> = {
    max: config.maxConnections ?? 5,
    statement_timeout: config.queryTimeout ?? 30_000,
  }

  if (config.connectionString) {
    poolConfig['connectionString'] = config.connectionString
  } else {
    poolConfig['host'] = config.host ?? 'localhost'
    poolConfig['port'] = config.port ?? 5432
    if (config.database) poolConfig['database'] = config.database
    if (config.user) poolConfig['user'] = config.user
    if (config.password) poolConfig['password'] = config.password
  }

  if (config.ssl) {
    poolConfig['ssl'] = typeof config.ssl === 'object'
      ? config.ssl
      : { rejectUnauthorized: config.sslAllowSelfSigned !== true }
  }

  return new PgPool(poolConfig)
}
