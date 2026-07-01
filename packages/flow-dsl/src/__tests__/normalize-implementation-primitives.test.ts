import { describe, expect, it } from "vitest";

import { formatDocumentToDsl } from "../format-dsl.js";
import { parseDslToDocument } from "../parse-dsl.js";
import type { ParseDslResult } from "../types.js";

function expectOk(result: ParseDslResult): asserts result is Extract<
  ParseDslResult,
  { ok: true }
> {
  expect(result, JSON.stringify(result.diagnostics, null, 2)).toMatchObject({
    ok: true,
  });
}

describe("implementation primitives", () => {
  it("normalizes shell.run with policy and output", () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: shell-demo
version: 1
steps:
  - shell.run:
      id: test_mpco
      command: node --test scripts/mpco/*.test.mjs
      cwd: .
      timeoutMs: 600000
      required: true
      output: shellResult
      effectClass: code_change
      idempotency: at-least-once
`);

    expectOk(result);
    expect(result.document.root.nodes[0]).toMatchObject({
      type: "shell.run",
      command: "node --test scripts/mpco/*.test.mjs",
      cwd: ".",
      timeoutMs: 600000,
      required: true,
      output: "shellResult",
      effectClass: "code_change",
      idempotency: "at-least-once",
    });
  });

  it("normalizes evidence.write with sanitized digest policy", () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: evidence-demo
version: 1
steps:
  - evidence.write:
      id: write_evidence
      source: "{{ state.shellResult }}"
      output: evidenceRef
      redact: true
`);

    expectOk(result);
    expect(result.document.root.nodes[0]).toMatchObject({
      type: "evidence.write",
      source: "{{ state.shellResult }}",
      output: "evidenceRef",
      redact: true,
    });
  });

  it("normalizes validate.schema with inline schema", () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: schema-demo
version: 1
steps:
  - validate.schema:
      id: validate_summary
      source: "{{ state.summary }}"
      schema:
        type: object
      output: schemaResult
`);

    expectOk(result);
    expect(result.document.root.nodes[0]).toMatchObject({
      type: "validate.schema",
      source: "{{ state.summary }}",
      schema: { type: "object" },
      output: "schemaResult",
    });
  });

  it("round-trips implementation primitives through the DSL formatter", () => {
    const parsed = parseDslToDocument(`
dsl: dzupflow/v1
id: implementation-roundtrip
version: 1
steps:
  - shell.run:
      id: run_tests
      command: yarn test
      output: testResult
      effectClass: code_change
      idempotency: at-least-once
  - evidence.write:
      id: write_digest
      source: "{{ state.testResult }}"
      output: evidenceRef
      redact: true
`);
    expectOk(parsed);

    const reparsed = parseDslToDocument(formatDocumentToDsl(parsed.document));
    expectOk(reparsed);
    expect(reparsed.document.root.nodes.map((node) => node.type)).toEqual([
      "shell.run",
      "evidence.write",
    ]);
  });
});
