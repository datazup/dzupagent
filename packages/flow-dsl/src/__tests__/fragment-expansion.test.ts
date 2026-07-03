import { describe, expect, it } from "vitest";
import type { FlowNode } from "@dzupagent/flow-ast";

import { parseDslToDocument } from "../parse-dsl.js";
import { expandFragmentInvocation } from "../fragments/expand-fragment.js";
import { createFragmentRegistry } from "../fragments/registry.js";

function createValidationGateRegistry() {
  return createFragmentRegistry([
    {
      id: "sdlc.validation_gate",
      version: 1,
      namespace: "sdlc",
      fragment: {
        dsl: "dzupflow/v1",
        documentType: "fragment",
        id: "sdlc.validation_gate",
        version: 1,
        params: { cwd: { type: "string", required: true } },
        exports: { status: "{{ state.validationStatus }}" },
        root: {
          type: "sequence",
          nodes: [
            {
              type: "shell.run",
              id: "run_commands",
              command: "yarn test",
              cwd: "{{ params.cwd }}",
              output: "commandResult",
            },
            {
              type: "validate.schema",
              id: "classify_result",
              source: "commandResult",
              schema: "dzup.sdlc.validation-result@1",
              output: "validationStatus",
            },
          ],
        },
      },
    },
  ]);
}

describe("fragment expansion", () => {
  it("prefixes internal ids and output keys per invocation", () => {
    const registry = createValidationGateRegistry();

    const first = expandFragmentInvocation({
      registry,
      kind: "sdlc.validation_gate",
      raw: { id: "api_gate", cwd: "apps/research-app", output: "apiValidation" },
      path: "root.steps[0]",
    });
    const second = expandFragmentInvocation({
      registry,
      kind: "sdlc.validation_gate",
      raw: { id: "web_gate", cwd: "apps/research-app", output: "webValidation" },
      path: "root.steps[1]",
    });

    const firstBodies = first.steps.map(
      (step) => Object.values(step)[0] as { id?: string },
    );
    const secondBodies = second.steps.map(
      (step) => Object.values(step)[0] as { id?: string },
    );

    expect(firstBodies.slice(0, 2).map((body) => body.id)).toEqual([
      "api_gate__run_commands",
      "api_gate__classify_result",
    ]);
    expect(secondBodies.slice(0, 2).map((body) => body.id)).toEqual([
      "web_gate__run_commands",
      "web_gate__classify_result",
    ]);
    expect(JSON.stringify(first.steps)).toContain("api_gate__commandResult");
    expect(JSON.stringify(second.steps)).toContain("web_gate__commandResult");
    expect(first.exports).toEqual({
      status: "{{ state.api_gate__validationStatus }}",
    });
    expect(second.exports).toEqual({
      status: "{{ state.web_gate__validationStatus }}",
    });
  });

  it("applies parameter defaults and rejects missing required params", () => {
    const registry = createFragmentRegistry([
      {
        dsl: "dzupflow/v1",
        documentType: "fragment",
        id: "sdlc.defaulted_gate",
        version: 1,
        params: {
          cwd: { type: "string", required: true },
          command: { type: "string", default: "yarn test" },
        },
        root: {
          type: "sequence",
          nodes: [
            {
              type: "shell.run",
              id: "run_commands",
              command: "{{ params.command }}",
              cwd: "{{ params.cwd }}",
              output: "commandResult",
            },
          ],
        },
      },
    ]);

    expect(() =>
      expandFragmentInvocation({
        registry,
        kind: "sdlc.defaulted_gate",
        raw: { id: "gate_without_cwd" },
        path: "root.steps[0]",
      }),
    ).toThrow(/missing required fragment param "cwd"/i);

    const expanded = expandFragmentInvocation({
      registry,
      kind: "sdlc.defaulted_gate",
      raw: { id: "gate", cwd: "apps/research-app" },
      path: "root.steps[0]",
    });

    expect(expanded.steps).toEqual([
      {
        "shell.run": {
          id: "gate__run_commands",
          command: "yarn test",
          cwd: "apps/research-app",
          output: "gate__commandResult",
        },
      },
    ]);

    expect(() =>
      expandFragmentInvocation({
        registry,
        kind: "sdlc.defaulted_gate",
        raw: { id: "gate", cwd: "apps/research-app", extra: true },
        path: "root.steps[0]",
      }),
    ).toThrow(/unknown fragment param "extra"/i);
  });

  it("binds a single declared export to the parent output key", () => {
    const registry = createValidationGateRegistry();

    const expanded = expandFragmentInvocation({
      registry,
      kind: "sdlc.validation_gate",
      raw: { id: "api_gate", cwd: "apps/research-app", output: "apiValidation" },
      path: "root.steps[0]",
    });

    expect(expanded.steps.at(-1)).toEqual({
      set: {
        id: "api_gate__export_status",
        assign: {
          apiValidation: "{{ state.api_gate__validationStatus }}",
        },
      },
    });
  });

  it("requires explicit output mapping for multi-export fragments", () => {
    const registry = createFragmentRegistry([
      {
        dsl: "dzupflow/v1",
        documentType: "fragment",
        id: "sdlc.multi_export_gate",
        version: 1,
        params: { cwd: { type: "string", required: true } },
        exports: {
          status: "{{ state.validationStatus }}",
          evidence: "{{ state.evidenceRef }}",
        },
        root: {
          type: "sequence",
          nodes: [
            {
              type: "shell.run",
              id: "run_validation",
              command: "yarn test",
              cwd: "{{ params.cwd }}",
              output: "validationStatus",
            },
            {
              type: "evidence.write",
              id: "write_evidence",
              source: "validationStatus",
              output: "evidenceRef",
            },
          ],
        },
      },
    ]);

    expect(() =>
      expandFragmentInvocation({
        registry,
        kind: "sdlc.multi_export_gate",
        raw: {
          id: "gate",
          cwd: "packages/flow-dsl",
          output: "validationResult",
        },
        path: "root.steps[0]",
      }),
    ).toThrow(/multi-export fragment output binding requires explicit output mapping/i);

    const expanded = expandFragmentInvocation({
      registry,
      kind: "sdlc.multi_export_gate",
      raw: {
        id: "gate",
        cwd: "packages/flow-dsl",
        output: {
          status: "validationStatus",
          evidence: "validationEvidence",
        },
      },
      path: "root.steps[0]",
    });

    expect(expanded.steps.slice(-2)).toEqual([
      {
        set: {
          id: "gate__export_status",
          assign: {
            validationStatus: "{{ state.gate__validationStatus }}",
          },
        },
      },
      {
        set: {
          id: "gate__export_evidence",
          assign: {
            validationEvidence: "{{ state.gate__evidenceRef }}",
          },
        },
      },
    ]);
  });

  it("recursively expands fragment invocations inside fragment bodies", () => {
    const registry = createFragmentRegistry([
      {
        dsl: "dzupflow/v1",
        documentType: "fragment",
        id: "sdlc.validation_gate",
        version: 1,
        params: { cwd: { type: "string", required: true } },
        exports: { status: "{{ state.validationStatus }}" },
        root: {
          type: "sequence",
          nodes: [
            {
              type: "shell.run",
              id: "run_validation",
              command: "yarn test",
              cwd: "{{ params.cwd }}",
              output: "validationStatus",
            },
          ],
        },
      },
      {
        dsl: "dzupflow/v1",
        documentType: "fragment",
        id: "sdlc.gated_packet",
        version: 1,
        params: { cwd: { type: "string", required: true } },
        root: {
          type: "sequence",
          nodes: [
            {
              type: "sdlc.validation_gate",
              id: "validation",
              cwd: "{{ params.cwd }}",
              output: "validationResult",
            } as unknown as FlowNode,
          ],
        },
      },
    ]);

    const expanded = expandFragmentInvocation({
      registry,
      kind: "sdlc.gated_packet",
      raw: { id: "packet", cwd: "packages/flow-dsl" },
      path: "root.steps[0]",
    });

    expect(expanded.steps.map((step) => Object.keys(step)[0])).toEqual([
      "shell.run",
      "set",
    ]);
    expect(JSON.stringify(expanded.steps)).toContain(
      "packet__validation__run_validation",
    );
    expect(JSON.stringify(expanded.steps)).toContain(
      "packet__validationResult",
    );
  });

  it("aggregates nested fragment expansion metadata", () => {
    const registry = createFragmentRegistry([
      {
        dsl: "dzupflow/v1",
        documentType: "fragment",
        id: "sdlc.validation_gate",
        version: 1,
        params: { cwd: { type: "string", required: true } },
        exports: { status: "{{ state.validationStatus }}" },
        root: {
          type: "sequence",
          nodes: [
            {
              type: "shell.run",
              id: "run_validation",
              command: "yarn test",
              cwd: "{{ params.cwd }}",
              output: "validationStatus",
            },
          ],
        },
      },
      {
        dsl: "dzupflow/v1",
        documentType: "fragment",
        id: "sdlc.gated_packet",
        version: 1,
        params: { cwd: { type: "string", required: true } },
        root: {
          type: "sequence",
          nodes: [
            {
              type: "sdlc.validation_gate",
              id: "validation",
              cwd: "{{ params.cwd }}",
              output: "validationResult",
            } as unknown as FlowNode,
          ],
        },
      },
    ]);

    const result = parseDslToDocument(
      `
dsl: dzupflow/v1
id: nested-fragment-metadata
version: 1
steps:
  - sdlc.gated_packet:
      id: packet
      cwd: packages/flow-dsl
`,
      { fragmentRegistry: registry },
    );

    expect(result.ok).toBe(true);
    expect(result.document?.meta?.fragmentExpansions).toEqual([
      expect.objectContaining({
        id: "sdlc.gated_packet",
        instanceId: "packet",
        invocationPath: "steps[0]",
      }),
      expect.objectContaining({
        id: "sdlc.validation_gate",
        instanceId: "packet__validation",
        invocationPath: "steps[0].fragment[0]",
      }),
    ]);
  });

  it("expands registered fragment invocations before normalization", () => {
    const registry = createValidationGateRegistry();
    const result = parseDslToDocument(
      `
dsl: dzupflow/v1
id: fragment-integration
version: 1
steps:
  - sdlc.validation_gate:
      id: api_gate
      cwd: apps/research-app
      output: apiValidation
  - sdlc.validation_gate:
      id: web_gate
      cwd: apps/research-app
      output: webValidation
`,
      { fragmentRegistry: registry },
    );

    expect(result.ok).toBe(true);
    expect(result.document?.root.nodes.map((node) => node.id)).toEqual([
      "api_gate__run_commands",
      "api_gate__classify_result",
      "api_gate__export_status",
      "web_gate__run_commands",
      "web_gate__classify_result",
      "web_gate__export_status",
    ]);
    expect(JSON.stringify(result.document?.root.nodes)).toContain(
      "api_gate__commandResult",
    );
    expect(JSON.stringify(result.document?.root.nodes)).toContain(
      "web_gate__commandResult",
    );
    expect(result.document?.meta?.fragmentExpansions).toEqual([
      expect.objectContaining({
        id: "sdlc.validation_gate",
        version: 1,
        namespace: "sdlc",
        instanceId: "api_gate",
        invocationPath: "steps[0]",
      }),
      expect.objectContaining({
        id: "sdlc.validation_gate",
        version: 1,
        namespace: "sdlc",
        instanceId: "web_gate",
        invocationPath: "steps[1]",
      }),
    ]);
  });
});
