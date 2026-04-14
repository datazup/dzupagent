import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

function assertDialect(connector, expected) {
  const actual = connector.getDialect();
  if (actual !== expected) {
    throw new Error(`Expected ${expected} dialect, got ${String(actual)}`);
  }
}

async function main() {
  const distEntry = resolve(process.cwd(), 'dist/index.js');
  const mod = await import(pathToFileURL(distEntry).href);

  if (typeof mod.createSQLConnector !== 'function') {
    throw new Error('createSQLConnector export missing from dist/index.js');
  }

  // Regression guard: this path previously crashed at runtime with
  // "Dynamic require of \"buffer\" is not supported" when mysql2/sql-escaper
  // were bundled into ESM output.
  const mysql = mod.createSQLConnector('mysql', {
    host: '127.0.0.1',
    port: 3306,
    database: 'test_db',
    username: 'test_user',
    password: 'test_password',
  });
  assertDialect(mysql, 'mysql');

  // Additional guard for another CJS-heavy runtime dependency path.
  const postgres = mod.createSQLConnector('postgresql', {
    host: '127.0.0.1',
    port: 5432,
    database: 'test_db',
    username: 'test_user',
    password: 'test_password',
  });
  assertDialect(postgres, 'postgresql');

  // Additional guard for non-CJS SQL driver path in the same ESM bundle.
  const clickhouse = mod.createSQLConnector('clickhouse', {
    host: '127.0.0.1',
    port: 8123,
    database: 'default',
    username: 'default',
    password: '',
  });
  assertDialect(clickhouse, 'clickhouse');

  await Promise.all([mysql.destroy(), postgres.destroy(), clickhouse.destroy()]);
  console.log('esm smoke passed (mysql, postgresql, clickhouse)');
}

main().catch((err) => {
  console.error('esm smoke failed');
  console.error(err);
  process.exitCode = 1;
});
