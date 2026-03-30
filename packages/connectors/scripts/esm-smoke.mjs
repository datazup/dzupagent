import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

async function main() {
  const distEntry = resolve(process.cwd(), 'dist/index.js');
  const mod = await import(pathToFileURL(distEntry).href);

  if (typeof mod.createSQLConnector !== 'function') {
    throw new Error('createSQLConnector export missing from dist/index.js');
  }

  // Regression guard: this path previously crashed at runtime with
  // "Dynamic require of \"buffer\" is not supported" when mysql2/sql-escaper
  // were bundled into ESM output.
  const connector = mod.createSQLConnector('mysql', {
    host: '127.0.0.1',
    port: 3306,
    database: 'test_db',
    username: 'test_user',
    password: 'test_password',
  });

  const dialect = connector.getDialect();
  if (dialect !== 'mysql') {
    throw new Error(`Expected mysql dialect, got ${String(dialect)}`);
  }

  await connector.destroy();
  console.log('esm smoke passed');
}

main().catch((err) => {
  console.error('esm smoke failed');
  console.error(err);
  process.exitCode = 1;
});
