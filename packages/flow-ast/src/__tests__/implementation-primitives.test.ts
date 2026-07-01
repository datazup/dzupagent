import { describe, expect, it } from "vitest";

import { parseFlow } from "../parse.js";
import { flowNodeSchema } from "../validate.js";

describe("implementation primitive AST nodes", () => {
  it("parses shell.run, evidence.write, and validate.schema nodes", () => {
    const result = parseFlow({
      type: "sequence",
      nodes: [
        {
          type: "shell.run",
          id: "run_tests",
          command: "node --test scripts/mpco/*.test.mjs",
          cwd: ".",
          timeoutMs: 600000,
          required: true,
          output: "testResult",
          effectClass: "code_change",
          idempotency: "at-least-once",
        },
        {
          type: "evidence.write",
          id: "write_evidence",
          source: "{{ state.testResult }}",
          output: "evidenceRef",
          redact: true,
        },
        {
          type: "validate.schema",
          id: "validate_summary",
          source: "{{ state.summary }}",
          schema: { type: "object" },
          output: "schemaResult",
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.ast?.type).toBe("sequence");
    if (result.ast?.type !== "sequence") return;
    expect(result.ast.nodes.map((node) => node.type)).toEqual([
      "shell.run",
      "evidence.write",
      "validate.schema",
    ]);
  });

  it("validates shell.run shape", () => {
    const result = flowNodeSchema.safeParse({
      type: "shell.run",
      id: "run_tests",
      command: "yarn test",
      output: "testResult",
      effectClass: "code_change",
      idempotency: "at-least-once",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.type).toBe("shell.run");
    if (result.data.type === "shell.run") {
      expect(result.data.command).toBe("yarn test");
      expect(result.data.effectClass).toBe("code_change");
    }
  });
});
