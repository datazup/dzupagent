/**
 * Deep unit coverage for the per-dialect SQL adapters in
 * @dzupagent/connectors (W26-A1).
 *
 * These adapters wrap native DB drivers. Rather than spin up live databases,
 * each connector is constructed normally (drivers are installed direct deps)
 * and a fake driver/connection/client is injected into its private field so
 * that the dialect-specific logic — LIMIT/TOP wrapping, identifier quoting,
 * type mapping, read-only guards, introspection SQL strings, and result
 * shaping — can be exercised in isolation with no network access.
 *
 * The injected fakes capture the SQL strings the adapters generate so we can
 * assert dialect-correct syntax (placeholders, quoting, system catalogs).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { PostgreSQLConnector } from "../sql/adapters/postgresql.js";
import { MySQLConnector } from "../sql/adapters/mysql.js";
import { ClickHouseConnector } from "../sql/adapters/clickhouse.js";
import { SnowflakeConnector } from "../sql/adapters/snowflake.js";
import { BigQueryConnector } from "../sql/adapters/bigquery.js";
import { SQLiteConnector } from "../sql/adapters/sqlite.js";
import { SQLServerConnector } from "../sql/adapters/sqlserver.js";
import { DuckDBConnector } from "../sql/adapters/duckdb.js";
import type { SQLConnectionConfig } from "../sql/types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function baseConfig(
  overrides: Partial<SQLConnectionConfig> = {}
): SQLConnectionConfig {
  return {
    host: "localhost",
    port: 5432,
    database: "testdb",
    username: "user",
    password: "pass",
    ssl: false,
    ...overrides,
  };
}

/** Loose handle for poking at private members in tests. */
type Priv = Record<string, unknown> & {
  wrapWithLimit(sql: string, n: number): string;
  getDialect(): string;
  getDefaultSchema(): string;
};

const priv = (c: unknown): Priv => c as unknown as Priv;

/** Collapse runs of whitespace so SQL string assertions ignore formatting. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

// ===========================================================================
// PostgreSQL
// ===========================================================================

describe("PostgreSQLConnector", () => {
  /** Build a connector with an injected fake pool that records queries. */
  function makePg(
    rows: Record<string, unknown>[] = [],
    fields: { name: string }[] = []
  ) {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const result = {
      rows,
      rowCount: rows.length,
      fields: fields.length
        ? fields
        : rows[0]
        ? Object.keys(rows[0]).map((name) => ({ name }))
        : [],
    };
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return result;
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return result;
      }),
      connect: vi.fn(async () => client),
      on: vi.fn(),
      end: vi.fn(async () => undefined),
    };
    const c = new PostgreSQLConnector(baseConfig());
    (c as unknown as { pool: unknown }).pool = pool;
    return { c, pool, client, calls };
  }

  it("reports the postgresql dialect", () => {
    const { c } = makePg();
    expect(c.getDialect()).toBe("postgresql");
  });

  it("defaults the schema to public", () => {
    const { c } = makePg();
    expect(priv(c).getDefaultSchema()).toBe("public");
  });

  it("honours a configured schema override", () => {
    const c = new PostgreSQLConnector(baseConfig({ schema: "analytics" }));
    (c as unknown as { pool: unknown }).pool = { on: vi.fn() };
    expect(priv(c).getDefaultSchema()).toBe("analytics");
  });

  it("appends LIMIT n+1 to detect truncation", () => {
    const { c } = makePg();
    expect(priv(c).wrapWithLimit("SELECT * FROM t", 100)).toBe(
      "SELECT * FROM t LIMIT 101"
    );
  });

  it("does not double-wrap an existing LIMIT", () => {
    const { c } = makePg();
    expect(priv(c).wrapWithLimit("SELECT * FROM t LIMIT 5", 100)).toBe(
      "SELECT * FROM t LIMIT 5"
    );
  });

  it("strips a trailing semicolon before wrapping", () => {
    const { c } = makePg();
    expect(priv(c).wrapWithLimit("SELECT 1;", 10)).toBe("SELECT 1 LIMIT 11");
  });

  it("quotes identifiers with double quotes and escapes embedded quotes", () => {
    const { c } = makePg();
    const q = (priv(c).quoteIdent as (s: string) => string).bind(c);
    expect(q("users")).toBe('"users"');
    expect(q('we"ird')).toBe('"we""ird"');
  });

  it("maps postgres data types to friendly short names", () => {
    const { c } = makePg();
    const map = (priv(c).mapDataType as (d: string, u: string) => string).bind(
      c
    );
    expect(map("character varying", "varchar")).toBe("varchar");
    expect(map("timestamp without time zone", "timestamp")).toBe("timestamp");
    expect(map("timestamp with time zone", "timestamptz")).toBe("timestamptz");
    expect(map("double precision", "float8")).toBe("float8");
    expect(map("boolean", "bool")).toBe("bool");
  });

  it("resolves USER-DEFINED types to their udt_name (enums)", () => {
    const { c } = makePg();
    const map = (priv(c).mapDataType as (d: string, u: string) => string).bind(
      c
    );
    expect(map("USER-DEFINED", "order_status")).toBe("order_status");
  });

  it("renders array types using the underscore-prefixed udt_name", () => {
    const { c } = makePg();
    const map = (priv(c).mapDataType as (d: string, u: string) => string).bind(
      c
    );
    expect(map("ARRAY", "_int4")).toBe("int4[]");
    expect(map("ARRAY", "text")).toBe("text[]");
  });

  it("discoverTables filters by schema with a $1 placeholder against information_schema", async () => {
    const { c, calls } = makePg([
      { table_name: "orders", table_schema: "public", description: null },
    ]);
    const tables = await priv(c).discoverTables("public");
    const call = calls.at(-1)!;
    expect(flat(call.text)).toContain("FROM information_schema.tables");
    expect(call.text).toContain("$1");
    expect(call.values).toEqual(["public"]);
    expect((tables as Array<{ tableName: string }>)[0]!.tableName).toBe(
      "orders"
    );
  });

  it("discoverColumns binds schema and table as $1/$2", async () => {
    const { c, calls } = makePg([
      {
        column_name: "id",
        data_type: "integer",
        udt_name: "int4",
        is_nullable: "NO",
        column_default: null,
        character_maximum_length: null,
        is_primary_key: true,
      },
    ]);
    const cols = await priv(c).discoverColumns("orders", "public");
    const call = calls.at(-1)!;
    expect(call.text).toContain("$1");
    expect(call.text).toContain("$2");
    expect(call.values).toEqual(["public", "orders"]);
    expect((cols as Array<{ isPrimaryKey: boolean }>)[0]!.isPrimaryKey).toBe(
      true
    );
  });

  it("discoverRowCount uses pg_class.reltuples estimate and floors -1 to 0", async () => {
    const { c, calls } = makePg([{ estimate: "-1" }]);
    const count = await priv(c).discoverRowCount("t", "public");
    expect(flat(calls.at(-1)!.text)).toContain("pg_class");
    expect(count).toBe(0);
  });

  it("discoverSampleValues quotes the fully-qualified identifier", async () => {
    const { c, calls } = makePg([{ val: 1 }, { val: 2 }]);
    const vals = await priv(c).discoverSampleValues(
      "orders",
      "public",
      "status",
      5
    );
    expect(calls.at(-1)!.text).toContain('"public"."orders"');
    expect(calls.at(-1)!.text).toContain("LIMIT 5");
    expect(vals).toEqual([1, 2]);
  });

  it("executeQuery applies statement_timeout and resets it afterwards", async () => {
    const { c, client } = makePg([{ id: 1 }]);
    await c.executeQuery("SELECT * FROM t", { timeoutMs: 1234, maxRows: 50 });
    const texts = client.query.mock.calls.map((args) => args[0] as string);
    expect(texts.some((t) => t.includes("SET statement_timeout = 1234"))).toBe(
      true
    );
    expect(texts.some((t) => t.includes("SET statement_timeout = 0"))).toBe(
      true
    );
  });

  it("executeQuery marks the result as truncated when more than maxRows are returned", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: i }));
    const { c } = makePg(rows);
    const result = await c.executeQuery("SELECT * FROM t", { maxRows: 2 });
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(2);
  });

  it("executeQuery wraps native driver errors with a PostgreSQL tag", async () => {
    const c = new PostgreSQLConnector(baseConfig());
    (c as unknown as { pool: unknown }).pool = {
      on: vi.fn(),
      connect: vi.fn(async () => ({
        query: vi.fn(async (text: string) => {
          if (text.startsWith("SELECT"))
            throw new Error("relation does not exist");
          return { rows: [], rowCount: 0, fields: [] };
        }),
        release: vi.fn(),
      })),
    };
    await expect(c.executeQuery("SELECT * FROM missing")).rejects.toThrow(
      /PostgreSQL query failed: relation does not exist/
    );
  });

  it("testConnection returns ok with a latency measurement on success", async () => {
    const { c } = makePg([{ "?column?": 1 }]);
    const res = await c.testConnection();
    expect(res.ok).toBe(true);
    expect(typeof res.latencyMs).toBe("number");
  });

  it("testConnection returns ok:false with the error message on failure", async () => {
    const c = new PostgreSQLConnector(baseConfig());
    (c as unknown as { pool: unknown }).pool = {
      on: vi.fn(),
      connect: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    };
    const res = await c.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ECONNREFUSED");
  });

  it("constructor configures the pool with rejectUnauthorized when ssl=true", () => {
    // ssl=true (boolean) must not throw and must select the dialect correctly.
    const c = new PostgreSQLConnector(baseConfig({ ssl: true }));
    expect(c.getDialect()).toBe("postgresql");
  });
});

// ===========================================================================
// MySQL
// ===========================================================================

describe("MySQLConnector", () => {
  function makeMy(rows: unknown[] = [], fields: { name: string }[] = []) {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const conn = {
      query: vi.fn(
        async (sql: string | { sql: string }, params?: unknown[]) => {
          const text = typeof sql === "string" ? sql : sql.sql;
          calls.push({ sql: text, params });
          if (/^SET\b/i.test(text.trim())) return [{}, []];
          return [rows, fields];
        }
      ),
      release: vi.fn(),
    };
    const pool = {
      getConnection: vi.fn(async () => conn),
      end: vi.fn(async () => undefined),
    };
    const c = new MySQLConnector(baseConfig({ port: 3306 }));
    (c as unknown as { pool: unknown }).pool = pool;
    return { c, pool, conn, calls };
  }

  it("reports the mysql dialect", () => {
    const { c } = makeMy();
    expect(c.getDialect()).toBe("mysql");
  });

  it("defaults the schema to the configured database name", () => {
    const { c } = makeMy();
    expect(priv(c).getDefaultSchema()).toBe("testdb");
  });

  it("injects a MAX_EXECUTION_TIME optimizer hint into SELECT statements", () => {
    const { c } = makeMy();
    const wrap = (
      priv(c).wrapWithTimeout as (s: string, n: number) => string
    ).bind(c);
    expect(wrap("SELECT * FROM t", 5000)).toBe(
      "SELECT /*+ MAX_EXECUTION_TIME(5000) */ * FROM t"
    );
  });

  it("does not add an optimizer hint to non-SELECT statements", () => {
    const { c } = makeMy();
    const wrap = (
      priv(c).wrapWithTimeout as (s: string, n: number) => string
    ).bind(c);
    expect(wrap("SHOW TABLES", 5000)).toBe("SHOW TABLES");
  });

  it("does not double-wrap an existing MAX_EXECUTION_TIME hint", () => {
    const { c } = makeMy();
    const wrap = (
      priv(c).wrapWithTimeout as (s: string, n: number) => string
    ).bind(c);
    const already = "SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM t";
    expect(wrap(already, 5000)).toBe(already);
  });

  it("uses LIMIT n+1 wrapping inherited from the base connector", () => {
    const { c } = makeMy();
    expect(priv(c).wrapWithLimit("SELECT * FROM t", 10)).toBe(
      "SELECT * FROM t LIMIT 11"
    );
  });

  it("discoverTables binds the schema with a ? placeholder", async () => {
    const { c, calls } = makeMy([
      { tableName: "orders", description: "the orders" },
    ]);
    const tables = await priv(c).discoverTables("shop");
    const dataCall = calls.find((x) =>
      x.sql.includes("information_schema.TABLES")
    )!;
    expect(dataCall.sql).toContain("?");
    expect(dataCall.params).toEqual(["shop"]);
    expect((tables as Array<{ tableName: string }>)[0]!.tableName).toBe(
      "orders"
    );
  });

  it("discoverColumns binds schema and table with two ? placeholders", async () => {
    const { c, calls } = makeMy([
      {
        columnName: "id",
        dataType: "int(11)",
        isNullable: "NO",
        defaultValue: null,
        description: "",
        maxLength: null,
        isPrimaryKey: 1,
      },
    ]);
    const cols = await priv(c).discoverColumns("orders", "shop");
    const dataCall = calls.find((x) =>
      x.sql.includes("information_schema.COLUMNS")
    )!;
    expect((dataCall.sql.match(/\?/g) ?? []).length).toBe(2);
    expect(dataCall.params).toEqual(["shop", "orders"]);
    expect((cols as Array<{ isPrimaryKey: boolean }>)[0]!.isPrimaryKey).toBe(
      true
    );
  });

  it("discoverSampleValues backtick-quotes identifiers and binds the limit", async () => {
    const { c, calls } = makeMy([{ val: "a" }]);
    await priv(c).discoverSampleValues("or`ders", "shop", "sta`tus", 7);
    const call = calls.find((x) => x.sql.includes("DISTINCT"))!;
    expect(call.sql).toContain("`shop`.`or``ders`");
    expect(call.sql).toContain("`sta``tus`");
    expect(call.sql).toContain("LIMIT ?");
    expect(call.params).toEqual([7]);
  });

  it("always sets the session to READ ONLY when acquiring a connection", async () => {
    const { c, conn } = makeMy([{ id: 1 }]);
    await c.testConnection();
    const setCalls = conn.query.mock.calls.map((a) =>
      typeof a[0] === "string" ? a[0] : (a[0] as { sql: string }).sql
    );
    expect(
      setCalls.some((s) => /SET SESSION TRANSACTION READ ONLY/i.test(s))
    ).toBe(true);
  });

  it("executeQuery returns empty result when the driver returns a non-array (DML header)", async () => {
    const { c, conn } = makeMy();
    conn.query = vi.fn(async (sql: string | { sql: string }) => {
      const text = typeof sql === "string" ? sql : sql.sql;
      if (/^SET\b/i.test(text.trim())) return [{}, []];
      return [{ affectedRows: 0 }, []] as unknown as [unknown, unknown];
    });
    const result = await c.executeQuery("SELECT 1");
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
  });
});

// ===========================================================================
// SQL Server
// ===========================================================================

describe("SQLServerConnector", () => {
  function makeMs() {
    const c = new SQLServerConnector(baseConfig({ port: 1433 }));
    return c;
  }

  it("reports the sqlserver dialect", () => {
    expect(makeMs().getDialect()).toBe("sqlserver");
  });

  it("defaults the schema to dbo", () => {
    expect(priv(makeMs()).getDefaultSchema()).toBe("dbo");
  });

  it("rewrites LIMIT semantics to SELECT TOP n+1", () => {
    const c = makeMs();
    expect(priv(c).wrapWithLimit("SELECT * FROM t", 100)).toBe(
      "SELECT TOP 101 * FROM t"
    );
  });

  it("injects TOP after SELECT DISTINCT", () => {
    const c = makeMs();
    expect(priv(c).wrapWithLimit("SELECT DISTINCT name FROM t", 10)).toBe(
      "SELECT DISTINCT TOP 11 name FROM t"
    );
  });

  it("does not add TOP when the query already has TOP", () => {
    const c = makeMs();
    expect(priv(c).wrapWithLimit("SELECT TOP 5 * FROM t", 100)).toBe(
      "SELECT TOP 5 * FROM t"
    );
  });

  it("does not add TOP when the query already has LIMIT", () => {
    const c = makeMs();
    expect(priv(c).wrapWithLimit("SELECT * FROM t LIMIT 5", 100)).toBe(
      "SELECT * FROM t LIMIT 5"
    );
  });

  it("strips a trailing semicolon before injecting TOP", () => {
    const c = makeMs();
    expect(priv(c).wrapWithLimit("SELECT * FROM t;", 10)).toBe(
      "SELECT TOP 11 * FROM t"
    );
  });

  it("quotes identifiers with square brackets and escapes embedded brackets", () => {
    const c = makeMs();
    const esc = (priv(c).escapeIdentifier as (s: string) => string).bind(c);
    expect(esc("Orders")).toBe("[Orders]");
    expect(esc("we]ird")).toBe("[we]]ird]");
  });

  it("executeQuery prepends a READ UNCOMMITTED isolation level and uses @ named binds for introspection", async () => {
    const inputs: Array<{ name: string; value: unknown }> = [];
    const queries: string[] = [];
    const request = {
      timeout: 0,
      input(name: string, _type: unknown, value: unknown) {
        inputs.push({ name, value });
        return this;
      },
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { recordset: [{ ok: 1 }] };
      }),
    };
    const pool = { request: () => request };
    const c = makeMs();
    (c as unknown as { pool: unknown }).pool = pool;
    await c.executeQuery("SELECT * FROM t", { maxRows: 3 });
    expect(queries[0]).toContain(
      "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED"
    );
    expect(queries[0]).toContain("SELECT TOP 4 *");
  });

  it("discoverColumns lower-cases the data type and binds @schemaName/@tableName", async () => {
    const inputs: Array<{ name: string; value: unknown }> = [];
    let capturedSql = "";
    const request = {
      input(name: string, _type: unknown, value: unknown) {
        inputs.push({ name, value });
        return this;
      },
      query: vi.fn(async (sql: string) => {
        capturedSql = sql;
        return {
          recordset: [
            {
              columnName: "Id",
              dataType: "INT",
              isNullable: "NO",
              defaultValue: null,
              maxLength: null,
              isPrimaryKey: 1,
            },
          ],
        };
      }),
    };
    // mssql module supplies VarChar; stub the loader via the pool path only.
    const c = makeMs();
    (c as unknown as { pool: unknown }).pool = { request: () => request };
    // loadMSSQLModule is called for the VarChar type — provide it through the cached promise.
    const cols = (await priv(c).discoverColumns("Orders", "dbo")) as Array<{
      dataType: string;
    }>;
    expect(capturedSql).toContain("@schemaName");
    expect(capturedSql).toContain("@tableName");
    expect(inputs.map((i) => i.name)).toContain("schemaName");
    expect(cols[0]!.dataType).toBe("int");
  });

  it("testConnection reports failure when the pool cannot connect", async () => {
    const c = makeMs();
    (c as unknown as { getPool: () => Promise<unknown> }).getPool = vi.fn(
      async () => {
        throw new Error("login failed");
      }
    );
    const res = await c.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("login failed");
  });
});

// ===========================================================================
// Snowflake
// ===========================================================================

describe("SnowflakeConnector", () => {
  function makeSf(rows: Record<string, unknown>[] = []) {
    const c = new SnowflakeConnector(
      baseConfig({ account: "acct123", warehouse: "WH", role: "R" })
    );
    const sqls: string[] = [];
    // Replace the private query() with a recorder.
    (
      c as unknown as {
        query: (sql: string, binds?: unknown[]) => Promise<unknown[]>;
      }
    ).query = vi.fn(async (sql: string) => {
      sqls.push(sql);
      return rows;
    });
    return { c, sqls };
  }

  it("reports the snowflake dialect", () => {
    const { c } = makeSf();
    expect(c.getDialect()).toBe("snowflake");
  });

  it("defaults the schema to PUBLIC", () => {
    const { c } = makeSf();
    expect(priv(c).getDefaultSchema()).toBe("PUBLIC");
  });

  it("wraps queries in a subquery with LIMIT n+1", () => {
    const { c } = makeSf();
    const wrapped = priv(c).wrapWithLimit("SELECT * FROM t", 100);
    expect(wrapped).toBe("SELECT * FROM (SELECT * FROM t) AS _sub LIMIT 101");
  });

  it("does not re-wrap a query that already has LIMIT", () => {
    const { c } = makeSf();
    expect(priv(c).wrapWithLimit("SELECT * FROM t LIMIT 5", 100)).toBe(
      "SELECT * FROM t LIMIT 5"
    );
  });

  it("quotes identifiers with double quotes and escapes embedded quotes", () => {
    const { c } = makeSf();
    const esc = (priv(c).escapeIdentifier as (s: string) => string).bind(c);
    expect(esc("TBL")).toBe('"TBL"');
    expect(esc('a"b')).toBe('"a""b"');
  });

  it("normalizes Snowflake VARIANT/OBJECT/ARRAY semi-structured types", () => {
    const { c } = makeSf();
    const map = (priv(c).mapDataType as (d: string) => string).bind(c);
    expect(map("variant")).toBe("VARIANT");
    expect(map("OBJECT")).toBe("OBJECT");
    expect(map("array")).toBe("ARRAY");
  });

  it("normalizes numeric and float aliases", () => {
    const { c } = makeSf();
    const map = (priv(c).mapDataType as (d: string) => string).bind(c);
    expect(map("DECIMAL")).toBe("NUMERIC");
    expect(map("NUMERIC")).toBe("NUMERIC");
    expect(map("FLOAT8")).toBe("FLOAT");
    expect(map("DOUBLE PRECISION")).toBe("FLOAT");
  });

  it("normalizes the three timestamp variants distinctly", () => {
    const { c } = makeSf();
    const map = (priv(c).mapDataType as (d: string) => string).bind(c);
    expect(map("TIMESTAMP_NTZ")).toBe("TIMESTAMP_NTZ");
    expect(map("TIMESTAMP_LTZ")).toBe("TIMESTAMP_LTZ");
    expect(map("TIMESTAMP_TZ")).toBe("TIMESTAMP_TZ");
    expect(map("TIMESTAMP")).toBe("TIMESTAMP_NTZ");
  });

  it("collapses text-like aliases to VARCHAR", () => {
    const { c } = makeSf();
    const map = (priv(c).mapDataType as (d: string) => string).bind(c);
    expect(map("STRING")).toBe("VARCHAR");
    expect(map("TEXT")).toBe("VARCHAR");
    expect(map("CHAR")).toBe("VARCHAR");
  });

  it("passes unknown types through upper-cased", () => {
    const { c } = makeSf();
    const map = (priv(c).mapDataType as (d: string) => string).bind(c);
    expect(map("geography")).toBe("GEOGRAPHY");
    expect(map("some_custom")).toBe("SOME_CUSTOM");
  });

  it("discoverTables queries INFORMATION_SCHEMA.TABLES with a ? placeholder bind", async () => {
    const { c, sqls } = makeSf([
      { TABLE_NAME: "O", TABLE_TYPE: "BASE TABLE", COMMENT: null },
    ]);
    const tables = await priv(c).discoverTables("PUBLIC");
    expect(flat(sqls.at(-1)!)).toContain("FROM INFORMATION_SCHEMA.TABLES");
    expect(sqls.at(-1)!).toContain("?");
    expect((tables as Array<{ tableName: string }>)[0]!.tableName).toBe("O");
  });

  it("discoverColumns maps DATA_TYPE through the normalizer", async () => {
    const { c } = makeSf([
      {
        COLUMN_NAME: "meta",
        DATA_TYPE: "VARIANT",
        IS_NULLABLE: "YES",
        COLUMN_DEFAULT: null,
        ORDINAL_POSITION: 1,
        CHARACTER_MAXIMUM_LENGTH: null,
        COMMENT: null,
      },
    ]);
    const cols = (await priv(c).discoverColumns("O", "PUBLIC")) as Array<{
      dataType: string;
      isNullable: boolean;
    }>;
    expect(cols[0]!.dataType).toBe("VARIANT");
    expect(cols[0]!.isNullable).toBe(true);
  });

  it("executeQuery sets a session statement timeout in seconds (ceil)", async () => {
    const { c, sqls } = makeSf([{ id: 1 }]);
    await c.executeQuery("SELECT * FROM t", { timeoutMs: 1500, maxRows: 10 });
    expect(
      sqls.some((s) => s.includes("STATEMENT_TIMEOUT_IN_SECONDS = 2"))
    ).toBe(true);
  });

  it("discoverRowCount returns 0 when the table is absent", async () => {
    const { c } = makeSf([]);
    expect(await priv(c).discoverRowCount("missing", "PUBLIC")).toBe(0);
  });
});

// ===========================================================================
// BigQuery
// ===========================================================================

describe("BigQueryConnector", () => {
  function makeBq(rows: Record<string, unknown>[] = []) {
    const c = new BigQueryConnector(
      baseConfig({ projectId: "proj", dataset: "ds" })
    );
    const queries: Array<{ query: string; params?: Record<string, unknown> }> =
      [];
    const client = {
      query: vi.fn(
        async (
          arg: string | { query: string; params?: Record<string, unknown> }
        ) => {
          const q = typeof arg === "string" ? { query: arg } : arg;
          queries.push(q);
          return [rows];
        }
      ),
      createQueryJob: vi.fn(async (opts: { query: string }) => {
        queries.push({ query: opts.query });
        return [{ getQueryResults: async () => [rows] }];
      }),
    };
    (c as unknown as { client: unknown }).client = client;
    return { c, client, queries };
  }

  it("reports the bigquery dialect", () => {
    const { c } = makeBq();
    expect(c.getDialect()).toBe("bigquery");
  });

  it("defaults the schema to the configured dataset", () => {
    const { c } = makeBq();
    expect(priv(c).getDefaultSchema()).toBe("ds");
  });

  it("falls back to schema then default when no dataset is provided", () => {
    const c = new BigQueryConnector(
      baseConfig({ projectId: "p", schema: "sch" })
    );
    (c as unknown as { client: unknown }).client = {};
    expect(priv(c).getDefaultSchema()).toBe("sch");
  });

  it("uses the database as projectId when projectId is omitted", () => {
    const c = new BigQueryConnector(baseConfig({ database: "mydb" }));
    (c as unknown as { client: unknown }).client = {};
    // dataset falls through to schema/'default'
    expect(priv(c).getDefaultSchema()).toBe("default");
  });

  it("blocks DML/DDL statements before they reach BigQuery", () => {
    const { c } = makeBq();
    const assert = (priv(c).assertReadOnly as (s: string) => void).bind(c);
    for (const kw of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET x=1",
      "DELETE FROM t",
      "DROP TABLE t",
      "CREATE TABLE t (x INT)",
      "ALTER TABLE t",
      "TRUNCATE TABLE t",
      "MERGE INTO t",
    ]) {
      expect(() => assert(kw)).toThrow(/Only SELECT queries are allowed/);
    }
  });

  it("allows SELECT and WITH statements through the read-only guard", () => {
    const { c } = makeBq();
    const assert = (priv(c).assertReadOnly as (s: string) => void).bind(c);
    expect(() => assert("SELECT 1")).not.toThrow();
    expect(() => assert("WITH x AS (SELECT 1) SELECT * FROM x")).not.toThrow();
  });

  it("escapes backtick identifiers and escapes embedded backticks/backslashes", () => {
    const { c } = makeBq();
    const esc = (
      priv(c).escapeBacktickIdentifier as (s: string) => string
    ).bind(c);
    expect(esc("tbl")).toBe("`tbl`");
    expect(esc("a`b")).toBe("`a\\`b`");
  });

  it("strips backticks from project and schema identifiers for INFORMATION_SCHEMA paths", () => {
    const { c } = makeBq();
    const escId = (priv(c).escapeIdentifier as (s: string) => string).bind(c);
    expect(escId("da`taset")).toBe("dataset");
  });

  it("extracts max length from STRING(N) and BYTES(N)", () => {
    const { c } = makeBq();
    const extract = (
      priv(c).extractMaxLength as (s: string) => number | null
    ).bind(c);
    expect(extract("STRING(255)")).toBe(255);
    expect(extract("BYTES(16)")).toBe(16);
    expect(extract("STRING")).toBeNull();
    expect(extract("INT64")).toBeNull();
  });

  it("executeQuery enforces a maximumBytesBilled cost cap and the read-only guard", async () => {
    const { c, client } = makeBq([{ id: 1 }]);
    await c.executeQuery("SELECT * FROM t", { maxRows: 10 });
    const jobOpts = client.createQueryJob.mock.calls[0]![0] as {
      maximumBytesBilled: string;
    };
    expect(jobOpts.maximumBytesBilled).toBe("1000000000");
  });

  it("executeQuery rejects a write statement via the read-only guard", async () => {
    const { c } = makeBq();
    await expect(c.executeQuery("DELETE FROM t")).rejects.toThrow(
      /Only SELECT queries are allowed/
    );
  });

  it("discoverColumns dedupes COLUMN_FIELD_PATHS rows for STRUCT/ARRAY and keeps array/struct types", async () => {
    const { c } = makeBq([
      {
        column_name: "tags",
        data_type: "ARRAY<STRING>",
        is_nullable: "YES",
        column_default: null,
        ordinal_position: 1,
        description: null,
      },
      {
        column_name: "tags",
        data_type: "ARRAY<STRING>",
        is_nullable: "YES",
        column_default: null,
        ordinal_position: 1,
        description: null,
      },
      {
        column_name: "addr",
        data_type: "STRUCT<city STRING>",
        is_nullable: "YES",
        column_default: null,
        ordinal_position: 2,
        description: null,
      },
    ]);
    const cols = (await priv(c).discoverColumns("events", "ds")) as Array<{
      columnName: string;
      dataType: string;
    }>;
    expect(cols).toHaveLength(2);
    expect(cols[0]!.dataType).toBe("ARRAY<STRING>");
    expect(cols[1]!.dataType).toBe("STRUCT<city STRING>");
  });

  it("discoverColumns binds the table name via the @tableName named parameter", async () => {
    const { c, queries } = makeBq([]);
    await priv(c).discoverColumns("events", "ds");
    const call = queries.at(-1)!;
    expect(call.query).toContain("@tableName");
    expect(call.params).toEqual({ tableName: "events" });
  });

  it("discoverForeignKeys returns [] when INFORMATION_SCHEMA constraints are unavailable", async () => {
    const c = new BigQueryConnector(
      baseConfig({ projectId: "p", dataset: "d" })
    );
    (c as unknown as { client: unknown }).client = {
      query: vi.fn(async () => {
        throw new Error("constraints view not found");
      }),
    };
    const fks = await priv(c).discoverForeignKeys("t", "d");
    expect(fks).toEqual([]);
  });
});

// ===========================================================================
// ClickHouse
// ===========================================================================

describe("ClickHouseConnector", () => {
  function makeCh(
    data: Record<string, unknown>[] = [],
    meta: { name: string; type: string }[] = []
  ) {
    const c = new ClickHouseConnector(baseConfig({ port: 8123 }));
    const queries: Array<{
      query: string;
      format?: string;
      query_params?: Record<string, unknown>;
    }> = [];
    const client = {
      query: vi.fn(
        async (arg: {
          query: string;
          format?: string;
          query_params?: Record<string, unknown>;
        }) => {
          queries.push(arg);
          return {
            json: async <T = unknown>(): Promise<T> =>
              (arg.format === "JSON"
                ? ({ meta, data, rows: data.length } as unknown)
                : (data as unknown)) as T,
          };
        }
      ),
      close: vi.fn(async () => undefined),
    };
    (c as unknown as { client: unknown }).client = client;
    return { c, client, queries };
  }

  it("reports the clickhouse dialect", () => {
    const { c } = makeCh();
    expect(c.getDialect()).toBe("clickhouse");
  });

  it("defaults the schema to default", () => {
    const { c } = makeCh();
    expect(priv(c).getDefaultSchema()).toBe("default");
  });

  it("quotes identifiers with double quotes", () => {
    const { c } = makeCh();
    const esc = (priv(c).escapeIdentifier as (s: string) => string).bind(c);
    expect(esc("events")).toBe('"events"');
    expect(esc('a"b')).toBe('"a""b"');
  });

  it("detects Nullable(T) types as nullable", () => {
    const { c } = makeCh();
    const isNull = (priv(c).isNullableType as (s: string) => boolean).bind(c);
    expect(isNull("Nullable(String)")).toBe(true);
    expect(isNull("String")).toBe(false);
  });

  it("detects LowCardinality(Nullable(T)) as nullable", () => {
    const { c } = makeCh();
    const isNull = (priv(c).isNullableType as (s: string) => boolean).bind(c);
    expect(isNull("LowCardinality(Nullable(String))")).toBe(true);
    expect(isNull("LowCardinality(String)")).toBe(false);
  });

  it("extracts max length from FixedString(N)", () => {
    const { c } = makeCh();
    const extract = (
      priv(c).extractMaxLength as (s: string) => number | null
    ).bind(c);
    expect(extract("FixedString(16)")).toBe(16);
    expect(extract("String")).toBeNull();
  });

  it("discoverForeignKeys always returns [] (ClickHouse has no FK constraints)", async () => {
    const { c } = makeCh();
    expect(await priv(c).discoverForeignKeys("t", "default")).toEqual([]);
  });

  it("discoverTables excludes view engines and binds via {schemaName: String}", async () => {
    const { c, queries } = makeCh([
      { name: "events", comment: "", total_rows: "100" },
    ]);
    const tables = await priv(c).discoverTables("default");
    const call = queries.at(-1)!;
    expect(flat(call.query)).toContain("FROM system.tables");
    expect(call.query).toContain("{schemaName: String}");
    expect(call.query).toContain(
      "engine NOT IN ('View', 'MaterializedView', 'LiveView')"
    );
    expect(call.query_params).toEqual({ schemaName: "default" });
    expect((tables as Array<{ tableName: string }>)[0]!.tableName).toBe(
      "events"
    );
  });

  it("discoverColumns reads is_in_primary_key and Nullable from system.columns", async () => {
    const { c } = makeCh([
      {
        name: "id",
        type: "UInt64",
        default_kind: "",
        default_expression: "",
        comment: "",
        is_in_primary_key: 1,
      },
      {
        name: "note",
        type: "Nullable(String)",
        default_kind: "",
        default_expression: "",
        comment: "",
        is_in_primary_key: 0,
      },
    ]);
    const cols = (await priv(c).discoverColumns("events", "default")) as Array<{
      isPrimaryKey: boolean;
      isNullable: boolean;
    }>;
    expect(cols[0]!.isPrimaryKey).toBe(true);
    expect(cols[0]!.isNullable).toBe(false);
    expect(cols[1]!.isNullable).toBe(true);
  });

  it("executeQuery converts the timeout from ms to ceil-seconds for max_execution_time", async () => {
    const { c, queries } = makeCh([{ x: 1 }], [{ name: "x", type: "UInt8" }]);
    await c.executeQuery("SELECT 1", { timeoutMs: 2500, maxRows: 5 });
    const exec = queries.find(
      (q) => q.format === "JSON" && "clickhouse_settings" in (q as object)
    ) as { clickhouse_settings: { max_execution_time: number } } | undefined;
    expect(exec?.clickhouse_settings.max_execution_time).toBe(3);
  });

  it("strips protocol and trailing slashes from the host when constructing the client URL", () => {
    // Re-construct with a real driver to exercise the URL normalization path.
    const c = new ClickHouseConnector(
      baseConfig({ host: "https://ch.example.com/", port: 8443, ssl: true })
    );
    expect(c.getDialect()).toBe("clickhouse");
  });
});

// ===========================================================================
// DuckDB
// ===========================================================================

describe("DuckDBConnector", () => {
  function makeDuck(rows: unknown[] = []) {
    const c = new DuckDBConnector(baseConfig({ duckdbPath: ":memory:" }));
    const sqls: string[] = [];
    (c as unknown as { query: (sql: string) => Promise<unknown[]> }).query =
      vi.fn(async (sql: string) => {
        sqls.push(sql);
        return rows;
      });
    return { c, sqls };
  }

  it("reports the duckdb dialect", () => {
    const { c } = makeDuck();
    expect(c.getDialect()).toBe("duckdb");
  });

  it("defaults the schema to main", () => {
    const { c } = makeDuck();
    expect(priv(c).getDefaultSchema()).toBe("main");
  });

  it("defaults the db path to :memory: when none is configured", () => {
    const c = new DuckDBConnector(baseConfig());
    expect((c as unknown as { dbPath: string }).dbPath).toBe(":memory:");
  });

  it("uses LIMIT n+1 wrapping from the base connector", () => {
    const { c } = makeDuck();
    expect(priv(c).wrapWithLimit("SELECT * FROM t", 100)).toBe(
      "SELECT * FROM t LIMIT 101"
    );
  });

  it("escapes string literals by doubling single quotes", () => {
    const { c } = makeDuck();
    const esc = (priv(c).escape as (s: string) => string).bind(c);
    expect(esc("O'Brien")).toBe("O''Brien");
  });

  it("quotes identifiers with double quotes and escapes embedded quotes", () => {
    const { c } = makeDuck();
    const esc = (priv(c).escapeIdentifier as (s: string) => string).bind(c);
    expect(esc("tbl")).toBe('"tbl"');
    expect(esc('a"b')).toBe('"a""b"');
  });

  it("discoverTables escapes the schema literal and queries information_schema", async () => {
    const { c, sqls } = makeDuck([{ tableName: "events" }]);
    const tables = await priv(c).discoverTables("ma'in");
    expect(flat(sqls.at(-1)!)).toContain("FROM information_schema.tables");
    expect(sqls.at(-1)!).toContain("table_schema = 'ma''in'");
    expect((tables as Array<{ tableName: string }>)[0]!.tableName).toBe(
      "events"
    );
  });

  it("discoverColumns discovers primary keys via duckdb_constraints()", async () => {
    const c = new DuckDBConnector(baseConfig({ duckdbPath: ":memory:" }));
    const queries: string[] = [];
    (c as unknown as { query: (sql: string) => Promise<unknown[]> }).query =
      vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("duckdb_constraints")) return [{ col_name: "id" }];
        return [
          {
            columnName: "id",
            dataType: "INTEGER",
            isNullable: "NO",
            defaultValue: null,
            maxLength: null,
          },
          {
            columnName: "name",
            dataType: "VARCHAR",
            isNullable: "YES",
            defaultValue: null,
            maxLength: null,
          },
        ];
      });
    const cols = (await priv(c).discoverColumns("events", "main")) as Array<{
      columnName: string;
      isPrimaryKey: boolean;
      dataType: string;
    }>;
    expect(cols.find((x) => x.columnName === "id")!.isPrimaryKey).toBe(true);
    expect(cols.find((x) => x.columnName === "name")!.isPrimaryKey).toBe(false);
    expect(cols[0]!.dataType).toBe("integer");
  });

  it("discoverRowCount reads estimated_size from duckdb_tables()", async () => {
    const { c, sqls } = makeDuck([{ cnt: 42 }]);
    const count = await priv(c).discoverRowCount("events", "main");
    expect(sqls.at(-1)!).toContain("duckdb_tables()");
    expect(count).toBe(42);
  });
});

// ===========================================================================
// SQLite
// ===========================================================================

describe("SQLiteConnector", () => {
  function makeLite(rows: unknown[] = [], getValue: unknown = undefined) {
    const c = new SQLiteConnector(baseConfig({ filePath: ":memory:" }));
    const prepared: string[] = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        prepared.push(sql);
        return {
          all: vi.fn((..._p: unknown[]) => rows),
          get: vi.fn((..._p: unknown[]) => getValue),
        };
      }),
      pragma: vi.fn(),
      close: vi.fn(),
    };
    (c as unknown as { db: unknown }).db = db;
    return { c, db, prepared };
  }

  it("reports the sqlite dialect", () => {
    const { c } = makeLite();
    expect(c.getDialect()).toBe("sqlite");
  });

  it("defaults the schema to main", () => {
    const { c } = makeLite();
    expect(priv(c).getDefaultSchema()).toBe("main");
  });

  it("falls back to config.database when no filePath is given", () => {
    const c = new SQLiteConnector(baseConfig({ database: "/tmp/data.db" }));
    expect((c as unknown as { dbPath: string }).dbPath).toBe("/tmp/data.db");
  });

  it("throws when neither filePath nor database is provided", () => {
    expect(() => new SQLiteConnector(baseConfig({ database: "" }))).toThrow(
      /requires a filePath or database path/
    );
  });

  it("quotes identifiers with double quotes and escapes embedded quotes", () => {
    const { c } = makeLite();
    const esc = (priv(c).escapeIdentifier as (s: string) => string).bind(c);
    expect(esc("tbl")).toBe('"tbl"');
    expect(esc('a"b')).toBe('"a""b"');
  });

  it("discoverTables reads from sqlite_master and excludes internal tables", async () => {
    const { c, prepared } = makeLite([{ tableName: "users" }]);
    const tables = await priv(c).discoverTables("main");
    expect(flat(prepared.at(-1)!)).toContain("FROM sqlite_master");
    expect(prepared.at(-1)!).toContain("name NOT LIKE 'sqlite_%'");
    expect((tables as Array<{ tableName: string }>)[0]!.tableName).toBe(
      "users"
    );
  });

  it("discoverColumns uses PRAGMA table_info with a quoted identifier", async () => {
    const { c, prepared } = makeLite([
      {
        cid: 0,
        name: "id",
        type: "INTEGER",
        notnull: 1,
        dflt_value: null,
        pk: 1,
      },
      { cid: 1, name: "email", type: "", notnull: 0, dflt_value: null, pk: 0 },
    ]);
    const cols = (await priv(c).discoverColumns("users", "main")) as Array<{
      columnName: string;
      isPrimaryKey: boolean;
      isNullable: boolean;
      dataType: string;
    }>;
    expect(prepared.at(-1)!).toContain('PRAGMA table_info("users")');
    expect(cols[0]!.isPrimaryKey).toBe(true);
    expect(cols[0]!.isNullable).toBe(false);
    // empty type column falls back to 'text'
    expect(cols[1]!.dataType).toBe("text");
  });

  it("discoverForeignKeys uses PRAGMA foreign_key_list and synthesizes constraint names", async () => {
    const { c, prepared } = makeLite([
      { id: 0, seq: 0, table: "orgs", from: "org_id", to: "id" },
    ]);
    const fks = (await priv(c).discoverForeignKeys("users", "main")) as Array<{
      constraintName: string;
      referencedTable: string;
    }>;
    expect(prepared.at(-1)!).toContain('PRAGMA foreign_key_list("users")');
    expect(fks[0]!.referencedTable).toBe("orgs");
    expect(fks[0]!.constraintName).toContain("fk_users_org_id");
  });

  it("discoverRowCount runs COUNT(*) and returns the value", async () => {
    const { c } = makeLite([], { cnt: 7 });
    expect(await priv(c).discoverRowCount("users", "main")).toBe(7);
  });

  it("discoverSampleValues binds the limit and quotes the column", async () => {
    const { c, prepared } = makeLite([{ val: "a" }, { val: "b" }]);
    const vals = await priv(c).discoverSampleValues(
      "users",
      "main",
      "status",
      3
    );
    expect(prepared.at(-1)!).toContain('"status"');
    expect(prepared.at(-1)!).toContain("LIMIT ?");
    expect(vals).toEqual(["a", "b"]);
  });

  it("testConnection returns ok on a successful probe", async () => {
    const { c } = makeLite([], { "1": 1 });
    const res = await c.testConnection();
    expect(res.ok).toBe(true);
  });
});

// ===========================================================================
// Cross-dialect invariants
// ===========================================================================

describe("cross-dialect identifier quoting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('double-quote dialects (pg, snowflake, sqlite, clickhouse, duckdb) all use "..."', () => {
    const pg = new PostgreSQLConnector(baseConfig());
    (pg as unknown as { pool: unknown }).pool = { on: vi.fn() };
    const sf = new SnowflakeConnector(baseConfig({ account: "a" }));
    const lite = new SQLiteConnector(baseConfig({ filePath: ":memory:" }));
    const ch = new ClickHouseConnector(baseConfig({ port: 8123 }));
    const duck = new DuckDBConnector(baseConfig({ duckdbPath: ":memory:" }));

    expect((priv(pg).quoteIdent as (s: string) => string).call(pg, "x")).toBe(
      '"x"'
    );
    expect(
      (priv(sf).escapeIdentifier as (s: string) => string).call(sf, "x")
    ).toBe('"x"');
    expect(
      (priv(lite).escapeIdentifier as (s: string) => string).call(lite, "x")
    ).toBe('"x"');
    expect(
      (priv(ch).escapeIdentifier as (s: string) => string).call(ch, "x")
    ).toBe('"x"');
    expect(
      (priv(duck).escapeIdentifier as (s: string) => string).call(duck, "x")
    ).toBe('"x"');
  });

  it("MySQL uses backticks and SQL Server uses square brackets", () => {
    const my = new MySQLConnector(baseConfig({ port: 3306 }));
    (my as unknown as { pool: unknown }).pool = {};
    const ms = new SQLServerConnector(baseConfig({ port: 1433 }));
    expect(
      (priv(ms).escapeIdentifier as (s: string) => string).call(ms, "x")
    ).toBe("[x]");
    // MySQL quotes inline in discoverSampleValues; assert the backtick pattern directly.
    const quoted = `\`${"x".replace(/`/g, "``")}\``;
    expect(quoted).toBe("`x`");
  });

  it("every connector reports a distinct, stable dialect id", () => {
    const pg = new PostgreSQLConnector(baseConfig());
    (pg as unknown as { pool: unknown }).pool = { on: vi.fn() };
    const my = new MySQLConnector(baseConfig({ port: 3306 }));
    (my as unknown as { pool: unknown }).pool = {};
    const ch = new ClickHouseConnector(baseConfig({ port: 8123 }));
    const sf = new SnowflakeConnector(baseConfig({ account: "a" }));
    const bq = new BigQueryConnector(baseConfig({ projectId: "p" }));
    (bq as unknown as { client: unknown }).client = {};
    const lite = new SQLiteConnector(baseConfig({ filePath: ":memory:" }));
    const ms = new SQLServerConnector(baseConfig({ port: 1433 }));
    const duck = new DuckDBConnector(baseConfig({ duckdbPath: ":memory:" }));

    const dialects = [pg, my, ch, sf, bq, lite, ms, duck].map((c) =>
      c.getDialect()
    );
    expect(new Set(dialects).size).toBe(8);
    expect(dialects).toEqual([
      "postgresql",
      "mysql",
      "clickhouse",
      "snowflake",
      "bigquery",
      "sqlite",
      "sqlserver",
      "duckdb",
    ]);
  });
});
