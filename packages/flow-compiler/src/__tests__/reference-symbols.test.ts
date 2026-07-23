import type {
  FlowDocumentV1,
  FlowNode,
} from "@dzupagent/flow-ast";
import { describe, expect, it } from "vitest";

import {
  deriveDocumentReferenceBindings,
  deriveNodeReferenceBindings,
  mergeReferenceBindings,
} from "../stages/reference-symbols.js";
import {
  deriveDocumentReferenceTypeBindings,
  deriveNodeReferencePortBindings,
  deriveNodeReferenceTypeBindings,
  mergeReferencePortBindings,
  mergeReferenceTypeBindings,
} from "../stages/reference-symbol-contracts.js";
import {
  deriveDocumentReferenceClassificationBindings,
  deriveNodeReferenceClassificationBindings,
  deriveSecretReferenceClassificationBindings,
  mergeReferenceClassificationBindings,
} from "../stages/reference-classifications.js";

describe("reference symbol derivation", () => {
  it("derives canonical document inputs without inventing host state", () => {
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "symbols",
      version: 1,
      inputs: {
        goal: { type: "string", required: true },
        attempts: { type: "number", default: 0 },
      },
      root: { type: "sequence", nodes: [] },
    };

    expect(deriveDocumentReferenceBindings(document)).toEqual({
      inputs: ["attempts", "goal"],
    });
  });

  it("collects declared state outputs, step ids, and loop symbols", () => {
    const root: FlowNode = {
      type: "sequence",
      id: "root",
      nodes: [
        {
          type: "set",
          id: "seed",
          assign: { ready: true },
        },
        {
          type: "prompt",
          id: "summarize",
          userPrompt: "Summarize",
          outputKey: "summary",
        },
        {
          type: "for_each",
          id: "review_each",
          source: "state.items",
          as: "reviewItem",
          collect: { from: "review", into: "reviews" },
          accumulator: { key: "reviewWindow" },
          body: [
            {
              type: "shell.run",
              id: "verify",
              command: "yarn test",
              output: "verification",
            },
          ],
        },
        {
          type: "try_catch",
          id: "recover",
          errorVar: "lastError",
          body: [],
          catch: [],
        },
      ],
    };

    expect(deriveNodeReferenceBindings(root)).toEqual({
      artifacts: [],
      context: [],
      inputs: [],
      params: [],
      secrets: [],
      state: [
        "lastError",
        "ready",
        "reviewItem",
        "reviews",
        "reviewWindow",
        "summary",
        "verification",
      ],
      steps: ["recover", "review_each", "root", "seed", "summarize", "verify"],
      loop: ["index", "item"],
    });
  });

  it("unions host bindings with compiler-derived roots deterministically", () => {
    expect(
      mergeReferenceBindings(
        { inputs: ["goal"], state: ["goal", "summary"] },
        { context: ["tenantId"], state: ["external"] },
        { secrets: ["apiKey"], inputs: ["cwd"] },
      ),
    ).toEqual({
      context: ["tenantId"],
      inputs: ["cwd", "goal"],
      secrets: ["apiKey"],
      state: ["external", "goal", "summary"],
    });
  });

  it("derives document and explicit node value types without resolving opaque schemas", () => {
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "typed_symbols",
      version: 1,
      inputs: {
        payload: { type: "object" },
        enabled: { type: "boolean" },
      },
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          { type: "set", id: "seed", assign: { attempts: 0, tags: [] } },
          {
            type: "agent",
            id: "review",
            agentId: "reviewer",
            instructions: "Review",
            output: {
              key: "reviewResult",
              schema: { type: "object" },
            },
          },
          {
            type: "worker.dispatch",
            id: "worker",
            dispatchId: "worker-1",
            provider: "codex",
            instructions: "Run",
            outputKey: "workerText",
          },
        ],
      },
    };

    expect(deriveDocumentReferenceTypeBindings(document)).toEqual({
      inputs: { enabled: "boolean", payload: "object" },
    });
    expect(deriveNodeReferenceTypeBindings(document.root)).toEqual({
      state: {
        attempts: "number",
        reviewResult: "object",
        tags: "array",
        workerText: "string",
      },
    });
  });

  it("declares step ids with empty ports and merges reviewed host contracts", () => {
    const root: FlowNode = {
      type: "sequence",
      id: "root",
      nodes: [{ type: "set", id: "prepare", assign: { ready: true } }],
    };

    expect(deriveNodeReferencePortBindings(root)).toEqual({
      prepare: {},
      root: {},
    });
    expect(
      mergeReferencePortBindings(
        deriveNodeReferencePortBindings(root),
        { prepare: { result: "object" } },
      ),
    ).toEqual({
      prepare: { result: "object" },
      root: {},
    });
    expect(
      mergeReferenceTypeBindings(
        { inputs: { goal: "string" }, state: { count: "number" } },
        { context: { tenant: "string" }, state: { count: "unknown" } },
      ),
    ).toEqual({
      context: { tenant: "string" },
      inputs: { goal: "string" },
      state: { count: "number" },
    });
  });

  it("derives and propagates classifications monotonically", () => {
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "classified_symbols",
      version: 1,
      inputs: {
        customerRecord: {
          type: "object",
          classification: "sensitive",
        },
      },
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "set",
            id: "copy",
            assign: {
              customerCopy: "{{ inputs.customerRecord }}",
              credentialCopy: "{{ secrets.apiKey }}",
            },
          },
          {
            type: "prompt",
            id: "summarize",
            userPrompt: "Summarize {{ state.customerCopy }}",
            outputKey: "summary",
          },
        ],
      },
    };
    const seed = mergeReferenceClassificationBindings(
      deriveDocumentReferenceClassificationBindings(document),
      deriveSecretReferenceClassificationBindings({
        secrets: ["apiKey"],
      }),
    );

    expect(seed).toEqual({
      inputs: { customerRecord: "sensitive" },
      secrets: { apiKey: "secret" },
    });
    expect(
      deriveNodeReferenceClassificationBindings(document.root, seed),
    ).toEqual({
      state: {
        credentialCopy: "secret",
        customerCopy: "sensitive",
        summary: "sensitive",
      },
    });
    expect(
      mergeReferenceClassificationBindings(
        { state: { value: "internal" } },
        { state: { value: "secret" } },
        { state: { value: "public" } },
      ),
    ).toEqual({ state: { value: "secret" } });
  });
});
