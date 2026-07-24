import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/github-security.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: true,
  // Keep DB drivers external. Bundling CommonJS drivers into ESM output causes
  // runtime failures such as: Dynamic require of "buffer" is not supported.
  external: [
    'duckdb',
    'pg',
    'mysql2',
    'mysql2/promise',
    'sql-escaper',
    'buffer',
    '@clickhouse/client',
    'snowflake-sdk',
    '@google-cloud/bigquery',
    'better-sqlite3',
    'mssql',
    /^@dzupagent\//,
  ],
});
