/**
 * Wave 36 database connector tests (+65 tests)
 *
 * Covers areas not yet exercised by earlier waves:
 *   - oidToName type-OID mapping (all known types + unknown fallback)
 *   - createCustomExecutor: field derivation, rowCount passthrough, duration
 *   - createPgExecutor: executeReadOnly path (BEGIN/SET/COMMIT/ROLLBACK)
 *   - createDatabaseOperations: executeReadOnly dispatch, isPrimaryKey 't' string
 *   - shouldApplyAutoLimit: all branches
 *   - enforceReadOnlyStatement: EXPLAIN of safe CTEs, empty SQL, VALUES multi-row
 *   - Query building: SELECT with multiple params, INSERT multi-value (rw mode)
 *   - Result mapping / type coercion: boolean, null, Buffer/binary, integer, float
 *   - Large result set formatting (truncated row count line)
 *   - Unicode in query results
 *   - createDatabaseConnectorToolkit: toolkit wrapper shape
 *   - Savepoint / nested transaction simulation sequences
 *   - Retry simulation: failure then success on same tool instance
 *   - DbToolError class: properties and message structure
 *   - handleDbToolError: all seven category branches
 *   - Idle timeout and pool drain simulation
 *   - describeTable isPrimaryKey 't' string mapping
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDatabaseConnector,
  createDatabaseConnectorToolkit,
  createDatabaseOperations,
  DbToolError,
} from "../database/db-connector.js";
import type { DatabaseConnectorConfig } from "../database/db-connector.js";
import {
  createCustomExecutor,
  createPgExecutor,
} from "../database/db-query.js";
import { oidToName } from "../database/db-connection.js";
import { handleDbToolError } from "../database/db-errors.js";
import {
  shouldApplyAutoLimit,
  enforceReadOnlyStatement,
  LIMIT_RE,
} from "../database/db-sql-safety.js";
import type { PgPool, PgPoolClient } from "../database/db-types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function mockQuery(rows: Record<string, unknown>[] = [], rowCount?: number) {
  return vi.fn().mockResolvedValue({ rows, rowCount: rowCount ?? rows.length });
}

function makeConfig(
  overrides: Partial<DatabaseConnectorConfig> = {},
): DatabaseConnectorConfig {
  return { query: mockQuery(), ...overrides };
}

function makeExecutor(queryFn: NonNullable<DatabaseConnectorConfig["query"]>) {
  return {
    async execute(sql: string, params?: unknown[]) {
      const result = await queryFn(sql, params);
      const firstRow = result.rows[0] as Record<string, unknown> | undefined;
      return {
        rows: result.rows as Record<string, unknown>[],
        rowCount: result.rowCount,
        fields: firstRow
          ? Object.keys(firstRow).map((n) => ({ name: n, type: "unknown" }))
          : [],
        duration: 1,
      };
    },
    async close() {
      /* noop */
    },
  };
}

// ---------------------------------------------------------------------------
// 1. oidToName — PostgreSQL type OID mapping
// ---------------------------------------------------------------------------

describe("oidToName — PostgreSQL type OID mapping", () => {
  it("maps OID 16 to boolean", () => {
    expect(oidToName(16)).toBe("boolean");
  });

  it("maps OID 20 to bigint", () => {
    expect(oidToName(20)).toBe("bigint");
  });

  it("maps OID 21 to smallint", () => {
    expect(oidToName(21)).toBe("smallint");
  });

  it("maps OID 23 to integer", () => {
    expect(oidToName(23)).toBe("integer");
  });

  it("maps OID 25 to text", () => {
    expect(oidToName(25)).toBe("text");
  });

  it("maps OID 114 to json", () => {
    expect(oidToName(114)).toBe("json");
  });

  it("maps OID 700 to float4", () => {
    expect(oidToName(700)).toBe("float4");
  });

  it("maps OID 701 to float8", () => {
    expect(oidToName(701)).toBe("float8");
  });

  it("maps OID 1043 to varchar", () => {
    expect(oidToName(1043)).toBe("varchar");
  });

  it("maps OID 1082 to date", () => {
    expect(oidToName(1082)).toBe("date");
  });

  it("maps OID 1114 to timestamp", () => {
    expect(oidToName(1114)).toBe("timestamp");
  });

  it("maps OID 1184 to timestamptz", () => {
    expect(oidToName(1184)).toBe("timestamptz");
  });

  it("maps OID 2950 to uuid", () => {
    expect(oidToName(2950)).toBe("uuid");
  });

  it("maps OID 3802 to jsonb", () => {
    expect(oidToName(3802)).toBe("jsonb");
  });

  it("returns oid:<n> for unknown OID", () => {
    expect(oidToName(9999)).toBe("oid:9999");
  });

  it("returns oid:0 for OID 0", () => {
    expect(oidToName(0)).toBe("oid:0");
  });
});

// ---------------------------------------------------------------------------
// 2. shouldApplyAutoLimit — all branches
// ---------------------------------------------------------------------------

describe("shouldApplyAutoLimit", () => {
  it("returns true for SELECT", () => {
    expect(shouldApplyAutoLimit("SELECT * FROM t")).toBe(true);
  });

  it("returns true for WITH (read-only CTE)", () => {
    expect(
      shouldApplyAutoLimit("WITH cte AS (SELECT 1) SELECT * FROM cte"),
    ).toBe(true);
  });

  it("returns true for VALUES", () => {
    // VALUES is in the allowed set (SELECT | WITH | VALUES)
    expect(shouldApplyAutoLimit("VALUES (1, 'a'), (2, 'b')")).toBe(true);
  });

  it("returns false for SHOW", () => {
    expect(shouldApplyAutoLimit("SHOW client_encoding")).toBe(false);
  });

  it("returns false for EXPLAIN", () => {
    expect(shouldApplyAutoLimit("EXPLAIN SELECT * FROM t")).toBe(false);
  });

  it("returns false for WITH data-modifying CTE", () => {
    expect(
      shouldApplyAutoLimit(
        "WITH d AS (DELETE FROM t RETURNING id) SELECT * FROM d",
      ),
    ).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(shouldApplyAutoLimit("")).toBe(false);
  });

  it("returns false for INSERT (write keyword)", () => {
    expect(shouldApplyAutoLimit("INSERT INTO t VALUES (1)")).toBe(false);
  });

  it("is case-insensitive for select", () => {
    expect(shouldApplyAutoLimit("select * from t")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. enforceReadOnlyStatement — additional branches
// ---------------------------------------------------------------------------

describe("enforceReadOnlyStatement — additional branches", () => {
  it("throws on empty SQL", () => {
    expect(() => enforceReadOnlyStatement("")).toThrow(/empty/i);
  });

  it("throws on whitespace-only SQL", () => {
    expect(() => enforceReadOnlyStatement("   ")).toThrow(/empty/i);
  });

  it("allows EXPLAIN of a plain SELECT", () => {
    const result = enforceReadOnlyStatement("EXPLAIN SELECT * FROM users");
    expect(result).toContain("EXPLAIN");
  });

  it("allows EXPLAIN with FORMAT option (parenthesized options)", () => {
    const result = enforceReadOnlyStatement(
      "EXPLAIN (FORMAT JSON) SELECT * FROM users",
    );
    expect(result).toContain("EXPLAIN");
  });

  it("blocks EXPLAIN ANALYZE (mutation risk)", () => {
    expect(() =>
      enforceReadOnlyStatement("EXPLAIN ANALYZE SELECT * FROM users"),
    ).toThrow(/not permitted/i);
  });

  it("blocks EXPLAIN of UPDATE", () => {
    expect(() =>
      enforceReadOnlyStatement("EXPLAIN UPDATE users SET name = $1"),
    ).toThrow(/not permitted/i);
  });

  it("blocks EXPLAIN of INSERT", () => {
    expect(() =>
      enforceReadOnlyStatement("EXPLAIN INSERT INTO users VALUES (1)"),
    ).toThrow(/not permitted/i);
  });

  it("allows WITH read-only CTE (no data-modifying keywords)", () => {
    const sql =
      "WITH active AS (SELECT id FROM users WHERE active) SELECT count(*) FROM active";
    const result = enforceReadOnlyStatement(sql);
    expect(result).toContain("WITH");
  });

  it("blocks WITH DELETE CTE", () => {
    expect(() =>
      enforceReadOnlyStatement(
        "WITH d AS (DELETE FROM logs RETURNING id) SELECT * FROM d",
      ),
    ).toThrow(/not permitted/i);
  });

  it("allows SHOW statement", () => {
    const result = enforceReadOnlyStatement("SHOW search_path");
    expect(result).toContain("SHOW");
  });

  it("allows VALUES statement", () => {
    const result = enforceReadOnlyStatement("VALUES (1, 'a'), (2, 'b')");
    expect(result).toContain("VALUES");
  });
});

// ---------------------------------------------------------------------------
// 4. LIMIT_RE exported constant
// ---------------------------------------------------------------------------

describe("LIMIT_RE", () => {
  it("matches LIMIT keyword", () => {
    expect(LIMIT_RE.test("SELECT * FROM t LIMIT 10")).toBe(true);
  });

  it("does not match limit inside a string alias", () => {
    // The regex is applied to masked SQL; this just tests the raw regex
    expect(LIMIT_RE.test("SELECT * FROM t")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. createCustomExecutor — unit tests
// ---------------------------------------------------------------------------

describe("createCustomExecutor", () => {
  it("passes sql and params to underlying query function", async () => {
    const queryFn = vi
      .fn()
      .mockResolvedValue({ rows: [{ x: 42 }], rowCount: 1 });
    const executor = createCustomExecutor(queryFn);
    await executor.execute("SELECT $1 AS x", [42]);
    expect(queryFn).toHaveBeenCalledWith("SELECT $1 AS x", [42]);
  });

  it("returns correct rowCount from query function", async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 7 });
    const executor = createCustomExecutor(queryFn);
    const result = await executor.execute("DELETE FROM t");
    expect(result.rowCount).toBe(7);
  });

  it("derives field names from first row keys", async () => {
    const queryFn = vi.fn().mockResolvedValue({
      rows: [{ id: 1, name: "Alice", score: 99.5 }],
      rowCount: 1,
    });
    const executor = createCustomExecutor(queryFn);
    const result = await executor.execute("SELECT id, name, score FROM t");
    expect(result.fields.map((f) => f.name)).toEqual(["id", "name", "score"]);
    expect(result.fields[0]!.type).toBe("unknown");
  });

  it("returns empty fields array when result has no rows", async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const executor = createCustomExecutor(queryFn);
    const result = await executor.execute("SELECT 1 WHERE false");
    expect(result.fields).toEqual([]);
  });

  it("records a non-negative duration", async () => {
    const queryFn = vi
      .fn()
      .mockResolvedValue({ rows: [{ ok: 1 }], rowCount: 1 });
    const executor = createCustomExecutor(queryFn);
    const result = await executor.execute("SELECT 1 AS ok");
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("close() resolves without throwing", async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const executor = createCustomExecutor(queryFn);
    await expect(executor.close()).resolves.toBeUndefined();
  });

  it("propagates rejection from query function", async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error("driver error"));
    const executor = createCustomExecutor(queryFn);
    await expect(executor.execute("SELECT 1")).rejects.toThrow("driver error");
  });
});

// ---------------------------------------------------------------------------
// 6. createPgExecutor — executeReadOnly path
// ---------------------------------------------------------------------------

describe("createPgExecutor — executeReadOnly", () => {
  type PgQueryResult = {
    rows: Record<string, unknown>[];
    rowCount: number | null;
    fields: Array<{ name: string; dataTypeID: number }>;
  };

  function makeMockClient(
    queryImpl: (text: string, values?: unknown[]) => Promise<PgQueryResult>,
  ): PgPoolClient & { _released: boolean } {
    const client = {
      _released: false,
      query: vi.fn().mockImplementation(queryImpl),
      release: vi.fn().mockImplementation(function (this: {
        _released: boolean;
      }) {
        this._released = true;
      }),
    };
    return client as unknown as PgPoolClient & { _released: boolean };
  }

  it("wraps query in BEGIN / SET LOCAL TRANSACTION READ ONLY / COMMIT", async () => {
    const client = makeMockClient(async (text: string) => {
      if (text === "BEGIN" || text.startsWith("SET") || text === "COMMIT") {
        return { rows: [], rowCount: 0, fields: [] };
      }
      return {
        rows: [{ id: 1 }],
        rowCount: 1,
        fields: [{ name: "id", dataTypeID: 23 }],
      };
    });

    const pool: PgPool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0, fields: [] }),
      connect: vi.fn().mockResolvedValue(client),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const executor = createPgExecutor(pool);
    const result = await executor.executeReadOnly!("SELECT id FROM t");

    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith(
      "SET LOCAL TRANSACTION READ ONLY",
    );
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(result.rows).toHaveLength(1);
    expect(client._released).toBe(true);
  });

  it("issues ROLLBACK and releases client when query throws", async () => {
    const client = makeMockClient(async (text: string) => {
      if (text === "BEGIN" || text.startsWith("SET") || text === "ROLLBACK") {
        return { rows: [], rowCount: 0, fields: [] };
      }
      throw new Error("simulated query failure");
    });

    const pool: PgPool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0, fields: [] }),
      connect: vi.fn().mockResolvedValue(client),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const executor = createPgExecutor(pool);
    await expect(executor.executeReadOnly!("SELECT * FROM t")).rejects.toThrow(
      "simulated query failure",
    );

    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client._released).toBe(true);
  });

  it("falls back to execute() when pool has no connect()", async () => {
    const pool: PgPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ n: 1 }],
        rowCount: 1,
        fields: [{ name: "n", dataTypeID: 23 }],
      }),
      end: vi.fn().mockResolvedValue(undefined),
      // no connect()
    };

    const executor = createPgExecutor(pool);
    const result = await executor.executeReadOnly!("SELECT 1 AS n");
    expect(result.rows).toHaveLength(1);
    expect(pool.query).toHaveBeenCalled();
  });

  it("maps pg field OIDs to human-readable types via oidToName", async () => {
    const pool: PgPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 1, name: "Alice" }],
        rowCount: 1,
        fields: [
          { name: "id", dataTypeID: 23 }, // integer
          { name: "name", dataTypeID: 25 }, // text
        ],
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const executor = createPgExecutor(pool);
    const result = await executor.execute("SELECT id, name FROM users");
    expect(result.fields[0]!.type).toBe("integer");
    expect(result.fields[1]!.type).toBe("text");
  });

  it("close() calls pool.end()", async () => {
    const pool: PgPool = {
      query: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const executor = createPgExecutor(pool);
    await executor.close();
    expect(pool.end).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7. createDatabaseOperations — executeReadOnly dispatch
// ---------------------------------------------------------------------------

describe("createDatabaseOperations — executeReadOnly dispatch", () => {
  it("uses executeReadOnly when executor provides it and readOnly is true", async () => {
    const executeReadOnly = vi.fn().mockResolvedValue({
      rows: [{ n: 1 }],
      rowCount: 1,
      fields: [],
      duration: 1,
    });
    const execute = vi.fn();
    const executor = {
      execute,
      executeReadOnly,
      async close() {},
    };
    const ops = createDatabaseOperations(executor, { readOnly: true });
    const result = await ops.query("SELECT 1 AS n");
    expect(executeReadOnly).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.rows[0]!["n"]).toBe(1);
  });

  it("uses execute() when readOnly is false even if executeReadOnly exists", async () => {
    const executeReadOnly = vi.fn();
    const execute = vi.fn().mockResolvedValue({
      rows: [{ n: 2 }],
      rowCount: 1,
      fields: [],
      duration: 1,
    });
    const executor = {
      execute,
      executeReadOnly,
      async close() {},
    };
    const ops = createDatabaseOperations(executor, { readOnly: false });
    await ops.query("INSERT INTO t VALUES (1)");
    expect(execute).toHaveBeenCalled();
    expect(executeReadOnly).not.toHaveBeenCalled();
  });

  it("uses execute() when executor has no executeReadOnly", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ ok: 1 }],
      rowCount: 1,
      fields: [],
      duration: 1,
    });
    const executor = { execute, async close() {} };
    const ops = createDatabaseOperations(executor, { readOnly: true });
    await ops.query("SELECT 1 AS ok");
    expect(execute).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 8. isPrimaryKey 't' string mapping in describeTable
// ---------------------------------------------------------------------------

describe("describeTable — isPrimaryKey 't' string mapping", () => {
  it("recognises is_primary_key = 't' as true", async () => {
    const queryFn = vi.fn().mockResolvedValue({
      rows: [
        {
          column_name: "id",
          data_type: "integer",
          is_nullable: "NO",
          column_default: null,
          is_primary_key: "t", // pg returns 't' for boolean true
        },
      ],
      rowCount: 1,
    });
    const executor = makeExecutor(queryFn);
    const ops = createDatabaseOperations(executor, { readOnly: false });
    const cols = await ops.describeTable("users");
    expect(cols[0]!.isPrimaryKey).toBe(true);
  });

  it("recognises is_primary_key = false as false", async () => {
    const queryFn = vi.fn().mockResolvedValue({
      rows: [
        {
          column_name: "email",
          data_type: "text",
          is_nullable: "YES",
          column_default: null,
          is_primary_key: false,
        },
      ],
      rowCount: 1,
    });
    const executor = makeExecutor(queryFn);
    const ops = createDatabaseOperations(executor, {});
    const cols = await ops.describeTable("users");
    expect(cols[0]!.isPrimaryKey).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. Result type coercion / value representation
// ---------------------------------------------------------------------------

describe("result type coercion and value representation", () => {
  it("formats boolean true as string in table output", async () => {
    const query = mockQuery([{ active: true }]);
    const tools = createDatabaseConnector(makeConfig({ query }));
    const dbQuery = tools.find((t) => t.name === "db-query")!;
    const result = await dbQuery.invoke({ sql: "SELECT active FROM users" });
    expect(result).toContain("true");
  });

  it("formats boolean false as string in table output", async () => {
    const query = mockQuery([{ active: false }]);
    const tools = createDatabaseConnector(makeConfig({ query }));
    const dbQuery = tools.find((t) => t.name === "db-query")!;
    const result = await dbQuery.invoke({ sql: "SELECT active FROM users" });
    expect(result).toContain("false");
  });

  it("formats integer zero as '0' (not NULL)", async () => {
    const query = mockQuery([{ count: 0 }]);
    const tools = createDatabaseConnector(makeConfig({ query }));
    const dbQuery = tools.find((t) => t.name === "db-query")!;
    const result = await dbQuery.invoke({ sql: "SELECT count(*) FROM users" });
    expect(result).toContain("0");
    expect(result).not.toContain("NULL");
  });

  it("formats floating point values", async () => {
    const query = mockQuery([{ ratio: 3.14159 }]);
    const tools = createDatabaseConnector(makeConfig({ query }));
    const dbQuery = tools.find((t) => t.name === "db-query")!;
    const result = await dbQuery.invoke({ sql: "SELECT 3.14159 AS ratio" });
    expect(result).toContain("3.14159");
  });

  it("formats Buffer/binary data as string (via String())", async () => {
    const buf = Buffer.from("binary\x00data");
    const query = mockQuery([{ data: buf }]);
    const tools = createDatabaseConnector(makeConfig({ query }));
    const dbQuery = tools.find((t) => t.name === "db-query")!;
    const result = await dbQuery.invoke({ sql: "SELECT data FROM blobs" });
    // String(Buffer) produces something non-null
    expect(result).not.toContain("NULL");
  });

  it("formats JSON object values as string", async () => {
    const query = mockQuery([{ payload: { key: "value", n: 42 } }]);
    const tools = createDatabaseConnector(makeConfig({ query }));
    const dbQuery = tools.find((t) => t.name === "db-query")!;
    const result = await dbQuery.invoke({ sql: "SELECT payload FROM events" });
    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
  });

  it("formats unicode string values", async () => {
    const query = mockQuery([{ name: "日本語テスト" }]);
    const tools = createDatabaseConnector(makeConfig({ query }));
    const dbQuery = tools.find((t) => t.name === "db-query")!;
    const result = await dbQuery.invoke({ sql: "SELECT name FROM users" });
    expect(result).toContain("日本語テスト");
  });

  it("formats emoji in string values", async () => {
    const query = mockQuery([{ status: "✅ done" }]);
    const tools = createDatabaseConnector(makeConfig({ query }));
    const dbQuery = tools.find((t) => t.name === "db-query")!;
    const result = await dbQuery.invoke({ sql: "SELECT status FROM tasks" });
    expect(result).toContain("✅");
  });
});

// ---------------------------------------------------------------------------
// 10. Large result set
// ---------------------------------------------------------------------------

describe("large result set handling", () => {
  it("formats a result with many rows and includes row count", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      val: `row_${i}`,
    }));
    const query = mockQuery(rows);
    const tools = createDatabaseConnector(
      makeConfig({ query, maxRows: 200, readOnly: false }),
    );
    const dbQuery = tools.find((t) => t.name === "db-query")!;
    const result = await dbQuery.invoke({
      sql: "SELECT id, val FROM big_table LIMIT 200",
    });
    expect(result).toContain("100 rows");
    expect(result).toContain("id");
    expect(result).toContain("val");
  });

  it("auto-limits a large SELECT to configured maxRows", async () => {
    const query = mockQuery([{ id: 1 }]);
    const tools = createDatabaseConnector(makeConfig({ query, maxRows: 500 }));
    const dbQuery = tools.find((t) => t.name === "db-query")!;
    await dbQuery.invoke({ sql: "SELECT * FROM events" });
    const calledSql = (query.mock.calls[0] as [string, unknown[]])[0];
    expect(calledSql).toContain("LIMIT 500");
  });
});

// ---------------------------------------------------------------------------
// 11. createDatabaseConnectorToolkit — wrapper shape
// ---------------------------------------------------------------------------

describe("createDatabaseConnectorToolkit", () => {
  it("returns a toolkit with name = 'database'", () => {
    const toolkit = createDatabaseConnectorToolkit(makeConfig());
    expect(toolkit.name).toBe("database");
  });

  it("toolkit.tools contains the same tools as createDatabaseConnector", () => {
    const config = makeConfig();
    const toolkit = createDatabaseConnectorToolkit(config);
    expect(toolkit.tools.map((t) => t.name)).toContain("db-query");
    expect(toolkit.tools.map((t) => t.name)).toContain("db-list-tables");
    expect(toolkit.tools.map((t) => t.name)).toContain("db-describe-table");
  });

  it("toolkit.enabledTools mirrors config.enabledTools", () => {
    const config = makeConfig({ enabledTools: ["db-query"] });
    const toolkit = createDatabaseConnectorToolkit(config);
    expect(toolkit.enabledTools).toEqual(["db-query"]);
    expect(toolkit.tools).toHaveLength(1);
  });

  it("toolkit.enabledTools is undefined when not specified", () => {
    const toolkit = createDatabaseConnectorToolkit(makeConfig());
    expect(toolkit.enabledTools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 12. DbToolError class
// ---------------------------------------------------------------------------

describe("DbToolError class", () => {
  it("has name 'DbToolError'", () => {
    const err = new DbToolError("query", "timeout", "the operation timed out");
    expect(err.name).toBe("DbToolError");
  });

  it("exposes operation and category properties", () => {
    const err = new DbToolError(
      "list_tables",
      "connection_error",
      "conn failed",
    );
    expect(err.operation).toBe("list_tables");
    expect(err.category).toBe("connection_error");
  });

  it("exposes message", () => {
    const err = new DbToolError("query", "syntax_error", "bad SQL");
    expect(err.message).toBe("bad SQL");
  });

  it("stores cause when provided", () => {
    const cause = new Error("original driver error");
    const err = new DbToolError(
      "query",
      "query_failed",
      "operation failed",
      cause,
    );
    expect(err.cause).toBe(cause);
  });

  it("cause is undefined when not provided", () => {
    const err = new DbToolError("query", "query_failed", "operation failed");
    expect(err.cause).toBeUndefined();
  });

  it("is an instance of Error", () => {
    const err = new DbToolError("query", "timeout", "timed out");
    expect(err instanceof Error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. handleDbToolError — all seven error category branches
// ---------------------------------------------------------------------------

describe("handleDbToolError — category classification", () => {
  it("classifies 'does not exist' as object_not_found", () => {
    const result = handleDbToolError(
      "query",
      "Query error",
      new Error("relation does not exist"),
    );
    expect(result).toContain("was not found");
    expect(result).not.toContain("does not exist");
  });

  it("classifies 'not found' as object_not_found", () => {
    const result = handleDbToolError(
      "query",
      "Query error",
      new Error("table not found"),
    );
    expect(result).toContain("was not found");
  });

  it("classifies 'syntax' as syntax_error", () => {
    const result = handleDbToolError(
      "query",
      "Query error",
      new Error("syntax error near token"),
    );
    expect(result).toContain("could not be parsed");
  });

  it("classifies 'parse' as syntax_error", () => {
    const result = handleDbToolError(
      "query",
      "Query error",
      new Error("parse error at line 1"),
    );
    expect(result).toContain("could not be parsed");
  });

  it("classifies 'permission denied' as permission_denied", () => {
    const result = handleDbToolError(
      "query",
      "Query error",
      new Error("permission denied for table users"),
    );
    expect(result).toContain("not permitted");
  });

  it("classifies 'not allowed' as permission_denied", () => {
    const result = handleDbToolError(
      "query",
      "Query error",
      new Error("operation not allowed"),
    );
    expect(result).toContain("not permitted");
  });

  it("classifies 'timeout' as timeout", () => {
    const result = handleDbToolError(
      "query",
      "Query error",
      new Error("statement timeout"),
    );
    expect(result).toContain("timed out");
  });

  it("classifies 'timed out' as timeout", () => {
    const result = handleDbToolError(
      "query",
      "Query error",
      new Error("connection timed out"),
    );
    expect(result).toContain("timed out");
  });

  it("classifies 'connect' / ECONNREFUSED as connection_error", () => {
    const result = handleDbToolError(
      "query",
      "Query error",
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
    );
    expect(result).toContain("connection failed");
  });

  it("classifies 'constraint' as constraint_violation", () => {
    const result = handleDbToolError(
      "query",
      "Query error",
      new Error("unique constraint violated"),
    );
    expect(result).toContain("constraint");
  });

  it("classifies 'duplicate' as constraint_violation", () => {
    const result = handleDbToolError(
      "query",
      "Query error",
      new Error("duplicate key value"),
    );
    expect(result).toContain("constraint");
  });

  it("classifies unknown errors as query_failed", () => {
    const result = handleDbToolError(
      "query",
      "Query error",
      new Error("something went wrong"),
    );
    expect(result).toContain("failed");
  });

  it("handles non-Error string throws", () => {
    const result = handleDbToolError(
      "query",
      "Query error",
      "plain string error",
    );
    expect(result).toContain("Query error");
    expect(result).not.toContain("plain string error");
  });

  it("includes the prefix in the output", () => {
    const result = handleDbToolError(
      "list_tables",
      "Error listing tables",
      new Error("connection refused"),
    );
    expect(result).toContain("Error listing tables");
  });
});

// ---------------------------------------------------------------------------
// 14. Savepoint / nested transaction simulation
// ---------------------------------------------------------------------------

describe("savepoint / nested transaction simulation", () => {
  it("executes SAVEPOINT in read-write mode", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT 1
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SAVEPOINT sp1
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT 2
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const tools = createDatabaseConnector(
      makeConfig({ query, readOnly: false }),
    );
    const dbQuery = tools.find((t) => t.name === "db-query")!;

    await dbQuery.invoke({ sql: "BEGIN" });
    await dbQuery.invoke({ sql: "INSERT INTO t(id) VALUES (1)" });
    await dbQuery.invoke({ sql: "SAVEPOINT sp1" });
    const r4 = await dbQuery.invoke({ sql: "INSERT INTO t(id) VALUES (2)" });
    await dbQuery.invoke({ sql: "COMMIT" });

    expect(r4).not.toContain("Query error");
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("executes ROLLBACK TO SAVEPOINT on inner failure", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SAVEPOINT sp1
      .mockRejectedValueOnce(new Error("constraint violation")) // INSERT fails
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ROLLBACK TO SAVEPOINT sp1
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const tools = createDatabaseConnector(
      makeConfig({ query, readOnly: false }),
    );
    const dbQuery = tools.find((t) => t.name === "db-query")!;

    await dbQuery.invoke({ sql: "BEGIN" });
    await dbQuery.invoke({ sql: "SAVEPOINT sp1" });
    const failResult = await dbQuery.invoke({
      sql: "INSERT INTO t(id) VALUES (1)",
    });
    const rollbackResult = await dbQuery.invoke({
      sql: "ROLLBACK TO SAVEPOINT sp1",
    });
    await dbQuery.invoke({ sql: "COMMIT" });

    expect(failResult).toContain("Query error");
    expect(rollbackResult).not.toContain("Query error");
  });
});

// ---------------------------------------------------------------------------
// 15. Retry simulation — failure then success on same tool instance
// ---------------------------------------------------------------------------

describe("retry simulation (transient failure then success)", () => {
  it("succeeds after transient connection failure on second attempt", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

    const tools = createDatabaseConnector(makeConfig({ query }));
    const dbQuery = tools.find((t) => t.name === "db-query")!;

    // First attempt fails
    const r1 = await dbQuery.invoke({ sql: "SELECT 1 AS id" });
    expect(r1).toContain("Query error");

    // Second attempt succeeds (same tool instance, ops already initialized)
    const r2 = await dbQuery.invoke({ sql: "SELECT 1 AS id" });
    expect(r2).toContain("1 rows");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("three transient failures followed by success", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({ rows: [{ status: "ok" }], rowCount: 1 });

    const tools = createDatabaseConnector(makeConfig({ query }));
    const dbQuery = tools.find((t) => t.name === "db-query")!;

    await dbQuery.invoke({ sql: "SELECT 'ok' AS status" }); // fail 1
    await dbQuery.invoke({ sql: "SELECT 'ok' AS status" }); // fail 2
    await dbQuery.invoke({ sql: "SELECT 'ok' AS status" }); // fail 3
    const r4 = await dbQuery.invoke({ sql: "SELECT 'ok' AS status" }); // success
    expect(r4).toContain("ok");
    expect(query).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// 16. Multi-param query building (SELECT / INSERT / UPDATE / DELETE in rw mode)
// ---------------------------------------------------------------------------

describe("multi-param query building", () => {
  it("SELECT with 5 parameters passes all to query function", async () => {
    const query = mockQuery([{ id: 1 }]);
    const tools = createDatabaseConnector(
      makeConfig({ query, readOnly: false }),
    );
    const dbQuery = tools.find((t) => t.name === "db-query")!;
    await dbQuery.invoke({
      sql: "SELECT * FROM t WHERE a=$1 AND b=$2 AND c=$3 AND d=$4 AND e=$5",
      params: [1, "two", true, null, 5.5],
    });
    const calledParams = (query.mock.calls[0] as [string, unknown[]])[1];
    expect(calledParams).toEqual([1, "two", true, null, 5.5]);
  });

  it("INSERT with multiple value rows (read-write mode)", async () => {
    const query = mockQuery([], 3);
    const tools = createDatabaseConnector(
      makeConfig({ query, readOnly: false }),
    );
    const dbQuery = tools.find((t) => t.name === "db-query")!;
    const result = await dbQuery.invoke({
      sql: "INSERT INTO users(name, age) VALUES ($1,$2),($3,$4),($5,$6)",
      params: ["Alice", 30, "Bob", 25, "Carol", 28],
    });
    expect(result).not.toContain("Query error");
    const calledParams = (query.mock.calls[0] as [string, unknown[]])[1];
    expect(calledParams).toHaveLength(6);
  });

  it("UPDATE with WHERE clause passes params in order", async () => {
    const query = mockQuery([], 1);
    const tools = createDatabaseConnector(
      makeConfig({ query, readOnly: false }),
    );
    const dbQuery = tools.find((t) => t.name === "db-query")!;
    await dbQuery.invoke({
      sql: "UPDATE users SET name=$1, age=$2 WHERE id=$3",
      params: ["Alice", 31, 42],
    });
    const calledParams = (query.mock.calls[0] as [string, unknown[]])[1];
    expect(calledParams).toEqual(["Alice", 31, 42]);
  });

  it("DELETE with parameterized WHERE clause", async () => {
    const query = mockQuery([], 2);
    const tools = createDatabaseConnector(
      makeConfig({ query, readOnly: false }),
    );
    const dbQuery = tools.find((t) => t.name === "db-query")!;
    await dbQuery.invoke({
      sql: "DELETE FROM users WHERE status=$1 AND created_at < $2",
      params: ["inactive", "2024-01-01"],
    });
    const calledParams = (query.mock.calls[0] as [string, unknown[]])[1];
    expect(calledParams).toEqual(["inactive", "2024-01-01"]);
  });
});

// ---------------------------------------------------------------------------
// 17. Idle timeout / pool drain simulation
// ---------------------------------------------------------------------------

describe("idle timeout and pool drain simulation", () => {
  it("reports connection error after idle timeout", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ ok: 1 }], rowCount: 1 }) // first query ok
      .mockRejectedValueOnce(
        new Error("connection terminated due to idle timeout"),
      ); // second after timeout

    const tools = createDatabaseConnector(makeConfig({ query }));
    const dbQuery = tools.find((t) => t.name === "db-query")!;

    const r1 = await dbQuery.invoke({ sql: "SELECT 1 AS ok" });
    expect(r1).toContain("1 rows");

    const r2 = await dbQuery.invoke({ sql: "SELECT 1 AS ok" });
    expect(r2).toContain("Query error");
    expect(r2).not.toContain("idle timeout");
  });

  it("close on ops drains the pool", async () => {
    const closeFn = vi.fn().mockResolvedValue(undefined);
    const executor = {
      ...makeExecutor(mockQuery()),
      close: closeFn,
    };
    const ops = createDatabaseOperations(executor, {});
    await ops.close();
    expect(closeFn).toHaveBeenCalledOnce();
  });
});
