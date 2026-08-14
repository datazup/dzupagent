import { describe, expect, it } from "vitest";

import { EFFECT_CLASSES } from "@dzupagent/flow-ast";
import { EXECUTION_EFFECT_CLASSES } from "@dzupagent/runtime-contracts/canonical-execution";
import {
  AgentHandlerEffectMappingError,
  resolveAgentHandlerEffectClass,
} from "@dzupagent/runtime-contracts/agent-blueprint";

describe("canonical effect-class conformance", () => {
  it("keeps flow AST and runtime execution vocabularies exactly equal", () => {
    expect(EXECUTION_EFFECT_CLASSES).toEqual(EFFECT_CLASSES);
  });

  it("maps exact coarse handler classes without caller inference", () => {
    expect(resolveAgentHandlerEffectClass("none")).toEqual({
      handlerEffectClass: "none",
      executionEffectClass: "compute",
    });
    expect(resolveAgentHandlerEffectClass("read")).toEqual({
      handlerEffectClass: "read",
      executionEffectClass: "read",
    });
  });

  it("requires explicit canonical enrichment for ambiguous handler effects", () => {
    for (const coarse of ["write", "external"] as const) {
      expect(() => resolveAgentHandlerEffectClass(coarse)).toThrow(
        expect.objectContaining({
          name: "AgentHandlerEffectMappingError",
          code: "HANDLER_EFFECT_ENRICHMENT_REQUIRED",
        }),
      );
    }
    expect(AgentHandlerEffectMappingError).toBeTypeOf("function");
  });

  it("admits explicit fine-grained mappings and rejects incompatible writes", () => {
    expect(resolveAgentHandlerEffectClass("write", "db_write")).toEqual({
      handlerEffectClass: "write",
      executionEffectClass: "db_write",
    });
    expect(resolveAgentHandlerEffectClass("external", "llm")).toEqual({
      handlerEffectClass: "external",
      executionEffectClass: "llm",
    });
    expect(() => resolveAgentHandlerEffectClass("write", "read")).toThrow(
      expect.objectContaining({
        code: "HANDLER_EFFECT_ENRICHMENT_INCOMPATIBLE",
      }),
    );
  });
});
