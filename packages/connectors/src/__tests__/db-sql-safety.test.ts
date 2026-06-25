/**
 * Unit tests for db-sql-safety.ts — the SQL read-only enforcement layer.
 *
 * Covers: enforceReadOnlyStatement, shouldApplyAutoLimit, LIMIT_RE,
 * maskSqlLiteralsAndComments (re-exported), splitTopLevelStatements (re-exported)
 *
 * These functions have had zero direct test coverage; this file adds
 * comprehensive coverage including injection bypass attempts, EXPLAIN edge
 * cases, data-modifying CTEs, and all branch paths in shouldApplyAutoLimit.
 */
import { describe, it, expect } from "vitest";
import {
  enforceReadOnlyStatement,
  shouldApplyAutoLimit,
  LIMIT_RE,
  maskSqlLiteralsAndComments,
  splitTopLevelStatements,
} from "../database/db-sql-safety.js";

// ── enforceReadOnlyStatement — allowed queries ─────────────

describe("enforceReadOnlyStatement — allowed", () => {
  it("allows a plain SELECT", () => {
    expect(enforceReadOnlyStatement("SELECT 1")).toBe("SELECT 1");
  });

  it("allows SELECT with WHERE clause", () => {
    const sql = "SELECT id, name FROM users WHERE active = true";
    expect(enforceReadOnlyStatement(sql)).toBe(sql);
  });

  it("allows a CTE (WITH ... SELECT)", () => {
    const sql = "WITH cte AS (SELECT 1 AS n) SELECT * FROM cte";
    expect(() => enforceReadOnlyStatement(sql)).not.toThrow();
  });

  it("allows SHOW statement", () => {
    expect(() => enforceReadOnlyStatement("SHOW search_path")).not.toThrow();
  });

  it("allows VALUES statement", () => {
    expect(() => enforceReadOnlyStatement("VALUES (1, 2, 3)")).not.toThrow();
  });

  it("allows EXPLAIN SELECT", () => {
    expect(() =>
      enforceReadOnlyStatement("EXPLAIN SELECT * FROM t")
    ).not.toThrow();
  });

  it("allows EXPLAIN with options block", () => {
    expect(() =>
      enforceReadOnlyStatement("EXPLAIN (FORMAT JSON) SELECT * FROM t")
    ).not.toThrow();
  });

  it("allows lowercase select", () => {
    expect(() => enforceReadOnlyStatement("select * from t")).not.toThrow();
  });

  it("allows SELECT with DML keyword inside a string literal", () => {
    expect(() =>
      enforceReadOnlyStatement("SELECT 'INSERT' AS kw FROM t")
    ).not.toThrow();
  });

  it("allows SELECT with DML keyword in a line comment", () => {
    expect(() =>
      enforceReadOnlyStatement("SELECT 1 -- UPDATE t SET x=1\nFROM t")
    ).not.toThrow();
  });

  it("returns the (trimmed) statement on success", () => {
    const result = enforceReadOnlyStatement("  SELECT 1  ");
    expect(result).toBe("SELECT 1");
  });
});

// ── enforceReadOnlyStatement — rejected queries ────────────

describe("enforceReadOnlyStatement — rejected", () => {
  it("rejects INSERT", () => {
    expect(() => enforceReadOnlyStatement("INSERT INTO t VALUES (1)")).toThrow(
      "Write operations not allowed"
    );
  });

  it("rejects UPDATE", () => {
    expect(() => enforceReadOnlyStatement("UPDATE t SET col = 1")).toThrow(
      "Write operations not allowed"
    );
  });

  it("rejects DELETE", () => {
    expect(() => enforceReadOnlyStatement("DELETE FROM t")).toThrow(
      "Write operations not allowed"
    );
  });

  it("rejects DROP TABLE", () => {
    expect(() => enforceReadOnlyStatement("DROP TABLE users")).toThrow(
      "Write operations not allowed"
    );
  });

  it("rejects ALTER TABLE", () => {
    expect(() =>
      enforceReadOnlyStatement("ALTER TABLE t ADD COLUMN x INT")
    ).toThrow("Write operations not allowed");
  });

  it("rejects CREATE TABLE", () => {
    expect(() => enforceReadOnlyStatement("CREATE TABLE x (id INT)")).toThrow(
      "Write operations not allowed"
    );
  });

  it("rejects TRUNCATE", () => {
    expect(() => enforceReadOnlyStatement("TRUNCATE TABLE t")).toThrow(
      "Write operations not allowed"
    );
  });

  it("rejects GRANT", () => {
    expect(() => enforceReadOnlyStatement("GRANT SELECT ON t TO user")).toThrow(
      "Write operations not allowed"
    );
  });

  it("rejects REVOKE", () => {
    expect(() => enforceReadOnlyStatement("REVOKE ALL ON t FROM user")).toThrow(
      "Write operations not allowed"
    );
  });

  it("rejects MERGE", () => {
    expect(() =>
      enforceReadOnlyStatement("MERGE INTO t USING s ON ...")
    ).toThrow("Write operations not allowed");
  });

  it("rejects COPY", () => {
    expect(() => enforceReadOnlyStatement("COPY t FROM STDIN")).toThrow(
      "Write operations not allowed"
    );
  });

  it("rejects empty SQL", () => {
    expect(() => enforceReadOnlyStatement("")).toThrow(
      "Write operations not allowed"
    );
  });

  it("rejects whitespace-only SQL", () => {
    expect(() => enforceReadOnlyStatement("   ")).toThrow(
      "Write operations not allowed"
    );
  });

  it("rejects multiple statements (SQL injection via semicolon)", () => {
    expect(() =>
      enforceReadOnlyStatement("SELECT 1; DROP TABLE users")
    ).toThrow("Multiple SQL statements are not permitted");
  });

  it("rejects stacked statements with second being INSERT", () => {
    expect(() =>
      enforceReadOnlyStatement("SELECT 1; INSERT INTO t VALUES (1)")
    ).toThrow();
  });

  it("rejects data-modifying CTE (WITH ... INSERT)", () => {
    expect(() =>
      enforceReadOnlyStatement(
        "WITH cte AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM cte"
      )
    ).toThrow("Data-modifying CTEs are not permitted");
  });

  it("rejects data-modifying CTE with UPDATE", () => {
    expect(() =>
      enforceReadOnlyStatement(
        "WITH updated AS (UPDATE t SET x=1 RETURNING *) SELECT * FROM updated"
      )
    ).toThrow("Data-modifying CTEs are not permitted");
  });

  it("rejects data-modifying CTE with DELETE", () => {
    expect(() =>
      enforceReadOnlyStatement(
        "WITH del AS (DELETE FROM t RETURNING id) SELECT * FROM del"
      )
    ).toThrow("Data-modifying CTEs are not permitted");
  });

  it("rejects EXPLAIN ANALYZE (execution side-effect)", () => {
    expect(() =>
      enforceReadOnlyStatement("EXPLAIN ANALYZE SELECT * FROM t")
    ).toThrow("EXPLAIN ANALYZE is not permitted");
  });

  it("rejects EXPLAIN of a DROP statement", () => {
    expect(() => enforceReadOnlyStatement("EXPLAIN DROP TABLE t")).toThrow(
      "EXPLAIN of write statements is not permitted"
    );
  });

  it("rejects EXPLAIN of a data-modifying CTE", () => {
    expect(() =>
      enforceReadOnlyStatement(
        "EXPLAIN WITH del AS (DELETE FROM t RETURNING id) SELECT * FROM del"
      )
    ).toThrow("EXPLAIN of data-modifying CTEs is not permitted");
  });
});

// ── shouldApplyAutoLimit ───────────────────────────────────

describe("shouldApplyAutoLimit", () => {
  it("returns true for SELECT", () => {
    expect(shouldApplyAutoLimit("SELECT id FROM t")).toBe(true);
  });

  it("returns true for WITH (read-only CTE)", () => {
    expect(
      shouldApplyAutoLimit("WITH cte AS (SELECT 1) SELECT * FROM cte")
    ).toBe(true);
  });

  it("returns true for VALUES", () => {
    expect(shouldApplyAutoLimit("VALUES (1, 2, 3)")).toBe(true);
  });

  it("returns false for SHOW", () => {
    expect(shouldApplyAutoLimit("SHOW search_path")).toBe(false);
  });

  it("returns false for EXPLAIN", () => {
    expect(shouldApplyAutoLimit("EXPLAIN SELECT 1")).toBe(false);
  });

  it("returns false for data-modifying WITH", () => {
    // WITH ... INSERT — masking must prevent false positives
    const sql =
      "WITH cte AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM cte";
    const masked = maskSqlLiteralsAndComments(sql);
    expect(shouldApplyAutoLimit(masked)).toBe(false);
  });

  it("returns false for INSERT", () => {
    expect(shouldApplyAutoLimit("INSERT INTO t VALUES (1)")).toBe(false);
  });

  it("returns false for UPDATE", () => {
    expect(shouldApplyAutoLimit("UPDATE t SET x=1")).toBe(false);
  });

  it("returns false for DELETE", () => {
    expect(shouldApplyAutoLimit("DELETE FROM t")).toBe(false);
  });

  it("returns false for empty/null-keyword SQL", () => {
    expect(shouldApplyAutoLimit("")).toBe(false);
  });
});

// ── LIMIT_RE ───────────────────────────────────────────────

describe("LIMIT_RE", () => {
  it("matches LIMIT keyword", () => {
    expect(LIMIT_RE.test("SELECT 1 LIMIT 100")).toBe(true);
  });

  it("matches lowercase limit", () => {
    expect(LIMIT_RE.test("SELECT 1 limit 100")).toBe(true);
  });

  it("does not match when no LIMIT present", () => {
    expect(LIMIT_RE.test("SELECT 1 FROM t")).toBe(false);
  });
});

// ── Re-exports from db-sql-lexer are available ─────────────

describe("re-exported functions", () => {
  it("maskSqlLiteralsAndComments is exported and works", () => {
    const masked = maskSqlLiteralsAndComments("SELECT 'secret' FROM t");
    expect(masked).not.toContain("secret");
  });

  it("splitTopLevelStatements is exported and works", () => {
    const stmts = splitTopLevelStatements("SELECT 1; SELECT 2");
    expect(stmts).toHaveLength(2);
  });
});
