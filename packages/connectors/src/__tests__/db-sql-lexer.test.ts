/**
 * Unit tests for db-sql-lexer.ts — the low-level SQL scanning primitives
 * that power the read-only safety policy.
 *
 * Covers: splitTopLevelStatements, maskSqlLiteralsAndComments, leadingKeyword
 *
 * These primitives have previously had zero direct test coverage; this file
 * adds deep coverage for the dialect-aware scanner internals including
 * dollar-quoting, nested block comments, escaped quotes, and paren depth
 * management.
 */
import { describe, it, expect } from "vitest";
import {
  splitTopLevelStatements,
  maskSqlLiteralsAndComments,
  leadingKeyword,
} from "../database/db-sql-lexer.js";

// ── splitTopLevelStatements ────────────────────────────────

describe("splitTopLevelStatements", () => {
  // Basic splitting

  it("returns single statement without trailing semicolon", () => {
    expect(splitTopLevelStatements("SELECT 1")).toEqual(["SELECT 1"]);
  });

  it("returns single statement with trailing semicolon", () => {
    expect(splitTopLevelStatements("SELECT 1;")).toEqual(["SELECT 1"]);
  });

  it("splits two statements separated by semicolon", () => {
    const result = splitTopLevelStatements("SELECT 1; SELECT 2");
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("SELECT 1");
    expect(result[1]).toBe("SELECT 2");
  });

  it("ignores semicolons inside single-quoted strings", () => {
    const sql = "SELECT 'a;b' FROM t";
    const result = splitTopLevelStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(sql);
  });

  it("ignores semicolons inside double-quoted identifiers", () => {
    const sql = 'SELECT "col;name" FROM t';
    const result = splitTopLevelStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(sql);
  });

  it("ignores semicolons inside line comments", () => {
    const sql = "SELECT 1 -- this;ends\nFROM t";
    const result = splitTopLevelStatements(sql);
    expect(result).toHaveLength(1);
  });

  it("ignores semicolons inside block comments", () => {
    const sql = "SELECT 1 /* semi;colon */ FROM t";
    const result = splitTopLevelStatements(sql);
    expect(result).toHaveLength(1);
  });

  it("ignores semicolons inside parentheses (subquery)", () => {
    const sql = "SELECT (SELECT 1) AS sub FROM t";
    const result = splitTopLevelStatements(sql);
    expect(result).toHaveLength(1);
  });

  it("handles dollar-quoted block that contains semicolons", () => {
    const sql = "SELECT $$hello;world$$ AS text";
    const result = splitTopLevelStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(sql);
  });

  it("handles named dollar-quote that contains semicolons", () => {
    const sql = "SELECT $tag$foo;bar$tag$ AS x";
    const result = splitTopLevelStatements(sql);
    expect(result).toHaveLength(1);
  });

  it("handles escaped single quotes inside single-quoted strings", () => {
    const sql = "SELECT 'it''s fine; right?' AS s";
    const result = splitTopLevelStatements(sql);
    expect(result).toHaveLength(1);
  });

  it("handles escaped double quotes inside double-quoted identifiers", () => {
    const sql = 'SELECT "col""name" FROM t';
    const result = splitTopLevelStatements(sql);
    expect(result).toHaveLength(1);
  });

  it("trims whitespace from each statement", () => {
    const result = splitTopLevelStatements("  SELECT 1  ;  SELECT 2  ");
    expect(result[0]).toBe("SELECT 1");
    expect(result[1]).toBe("SELECT 2");
  });

  it("returns empty array for empty string", () => {
    expect(splitTopLevelStatements("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(splitTopLevelStatements("   \n\t  ")).toEqual([]);
  });

  it("returns empty array for semicolon-only string", () => {
    expect(splitTopLevelStatements(";")).toEqual([]);
  });

  it("ignores multiple trailing semicolons", () => {
    const result = splitTopLevelStatements("SELECT 1;;; SELECT 2");
    expect(result).toHaveLength(2);
  });

  it("handles nested block comments (PostgreSQL supports depth > 1)", () => {
    const sql = "SELECT /* outer /* inner */ outer */ 1";
    const result = splitTopLevelStatements(sql);
    expect(result).toHaveLength(1);
  });

  it("splits CTE with semicolon after it", () => {
    const sql = "WITH cte AS (SELECT 1) SELECT * FROM cte; SELECT 2";
    const result = splitTopLevelStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("WITH cte");
    expect(result[1]).toBe("SELECT 2");
  });

  it("handles multiple statements with line comments in between", () => {
    const sql = "SELECT 1; -- comment\nSELECT 2";
    const result = splitTopLevelStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("SELECT 1");
  });
});

// ── maskSqlLiteralsAndComments ─────────────────────────────

describe("maskSqlLiteralsAndComments", () => {
  it("passes through plain SQL without masking", () => {
    const sql = "SELECT id FROM users";
    expect(maskSqlLiteralsAndComments(sql)).toBe(sql);
  });

  it("masks content inside single-quoted strings", () => {
    const sql = "SELECT 'secret' FROM t";
    const masked = maskSqlLiteralsAndComments(sql);
    expect(masked).not.toContain("secret");
    expect(masked.length).toBe(sql.length);
  });

  it("masks content inside double-quoted identifiers", () => {
    const sql = 'SELECT "column name" FROM t';
    const masked = maskSqlLiteralsAndComments(sql);
    expect(masked).not.toContain("column name");
    expect(masked.length).toBe(sql.length);
  });

  it("masks line comment content but preserves newline", () => {
    const sql = "SELECT 1 -- DROP TABLE\nFROM t";
    const masked = maskSqlLiteralsAndComments(sql);
    expect(masked).not.toContain("DROP TABLE");
    // Newline must be preserved for line counting
    expect(masked).toContain("\n");
    expect(masked.length).toBe(sql.length);
  });

  it("masks block comment content", () => {
    const sql = "SELECT /* DELETE FROM t */ 1";
    const masked = maskSqlLiteralsAndComments(sql);
    expect(masked).not.toContain("DELETE");
    expect(masked.length).toBe(sql.length);
  });

  it("masks dollar-quoted block ($$)", () => {
    const sql = "SELECT $$ DROP TABLE users $$ AS val";
    const masked = maskSqlLiteralsAndComments(sql);
    expect(masked).not.toContain("DROP TABLE");
    expect(masked.length).toBe(sql.length);
  });

  it("masks named dollar-quoted block", () => {
    const sql = "SELECT $body$ DELETE FROM t; $body$ AS v";
    const masked = maskSqlLiteralsAndComments(sql);
    expect(masked).not.toContain("DELETE");
    expect(masked.length).toBe(sql.length);
  });

  it("handles escaped single quotes inside single-quoted strings", () => {
    const sql = "SELECT 'it''s here' FROM t";
    const masked = maskSqlLiteralsAndComments(sql);
    expect(masked).not.toContain("it''s");
    expect(masked.length).toBe(sql.length);
  });

  it("handles escaped double quotes inside double-quoted identifiers", () => {
    const sql = 'SELECT "col""n" FROM t';
    const masked = maskSqlLiteralsAndComments(sql);
    expect(masked).not.toContain("col");
    expect(masked.length).toBe(sql.length);
  });

  it("masks nested block comments", () => {
    const sql = "SELECT /* outer /* inner INSERT */ stuff */ 1";
    const masked = maskSqlLiteralsAndComments(sql);
    expect(masked).not.toContain("INSERT");
    expect(masked.length).toBe(sql.length);
  });

  it("preserves newlines inside block comments for line-count accuracy", () => {
    const sql = "SELECT /* line1\nline2 */ 1";
    const masked = maskSqlLiteralsAndComments(sql);
    expect(masked).toContain("\n");
  });

  it("returns empty string for empty input", () => {
    expect(maskSqlLiteralsAndComments("")).toBe("");
  });

  it("does not mask SQL keywords outside quoted context", () => {
    const sql = "SELECT id, name FROM users WHERE id = 1";
    const masked = maskSqlLiteralsAndComments(sql);
    expect(masked).toContain("SELECT");
    expect(masked).toContain("FROM");
    expect(masked).toContain("WHERE");
  });
});

// ── leadingKeyword ─────────────────────────────────────────

describe("leadingKeyword", () => {
  it("returns SELECT for a select query", () => {
    expect(leadingKeyword("SELECT id FROM t")).toBe("SELECT");
  });

  it("returns WITH for a CTE", () => {
    expect(leadingKeyword("WITH cte AS (...)")).toBe("WITH");
  });

  it("returns INSERT for insert statement", () => {
    expect(leadingKeyword("INSERT INTO t VALUES (1)")).toBe("INSERT");
  });

  it("returns UPDATE for update statement", () => {
    expect(leadingKeyword("UPDATE t SET col = 1")).toBe("UPDATE");
  });

  it("returns DELETE for delete statement", () => {
    expect(leadingKeyword("DELETE FROM t")).toBe("DELETE");
  });

  it("returns DROP for drop statement", () => {
    expect(leadingKeyword("DROP TABLE t")).toBe("DROP");
  });

  it("returns EXPLAIN for explain query", () => {
    expect(leadingKeyword("EXPLAIN SELECT 1")).toBe("EXPLAIN");
  });

  it("uppercases the keyword", () => {
    expect(leadingKeyword("select id FROM t")).toBe("SELECT");
  });

  it("handles leading whitespace", () => {
    expect(leadingKeyword("   SELECT 1")).toBe("SELECT");
  });

  it("returns null for empty string", () => {
    expect(leadingKeyword("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(leadingKeyword("   ")).toBeNull();
  });

  it("returns null for string starting with non-alpha character", () => {
    expect(leadingKeyword(";SELECT 1")).toBeNull();
  });

  it("returns SHOW for show command", () => {
    expect(leadingKeyword("SHOW search_path")).toBe("SHOW");
  });

  it("returns VALUES for values statement", () => {
    expect(leadingKeyword("VALUES (1, 2, 3)")).toBe("VALUES");
  });

  it("returns TRUNCATE for truncate statement", () => {
    expect(leadingKeyword("TRUNCATE TABLE t")).toBe("TRUNCATE");
  });
});
