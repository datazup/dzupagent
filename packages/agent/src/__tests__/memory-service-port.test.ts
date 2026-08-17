/**
 * Contract guards for `MemoryServicePort`.
 *
 * `MemoryConfigSlice.memory` used to be typed as the concrete `MemoryService`
 * class. That class holds `private readonly` state, so no object literal could
 * ever satisfy it and every caller wanting a lightweight memory implementation
 * was forced to write `as unknown as MemoryService`. The field is now typed as
 * the structural `MemoryServicePort`.
 *
 * The widening is only safe while two things stay true, and neither is checked
 * by any behavioural test — that is what this file is for:
 *
 *  1. A real `MemoryService` still satisfies the port. If it ever stops doing
 *     so, the port has drifted from the class and the framework would be
 *     calling methods that are not there. Asserted at COMPILE time, so the
 *     build breaks rather than a run failing later.
 *  2. A plain object literal satisfies the port. That is the entire point of
 *     the change; if it regresses, the casts come back.
 *
 * The runtime block guards the one claim in the port's doc comment that is a
 * statement about a DIFFERENT class and so cannot be pinned by assignability
 * here: that `EncryptedMemoryService` is deliberately outside the port.
 */
import { describe, it, expect } from "vitest";
import type { MemoryService } from "@dzupagent/memory";
import { EncryptedMemoryService } from "@dzupagent/memory";
import type { MemoryServicePort } from "../agent/agent-types-memory.js";

describe("MemoryServicePort", () => {
  it("is satisfied by a real MemoryService (compile-time)", () => {
    // If `MemoryService` ever loses a member the port marks required, this
    // assignment stops compiling and the test-typecheck gate fails. It is a
    // type-level assertion; there is nothing to execute.
    const fromRealService = (service: MemoryService): MemoryServicePort =>
      service;
    expect(typeof fromRealService).toBe("function");
  });

  it("is satisfied by a plain object literal — the reason the port exists", () => {
    // No `as unknown as MemoryService` anywhere. This is what the concrete
    // class annotation made impossible.
    const double: MemoryServicePort = {
      get: async () => [],
      put: async () => undefined,
      getKeyed: async () => [],
      // Returns `Promise<boolean>`, not `Promise<void>` — caught by removing
      // the cast this literal originally carried. The runtime test passed
      // either way; only the typecheck knew.
      delete: async () => true,
      formatForPrompt: () => "",
    };

    expect(typeof double.get).toBe("function");
    expect(typeof double.getKeyed).toBe("function");
    expect(typeof double.delete).toBe("function");
  });

  it("excludes EncryptedMemoryService, which has no getKeyed and no delete", () => {
    // The port's doc comment claims `EncryptedMemoryService` is deliberately
    // outside it because the decay sweep (`runMemoryDecay`) calls `getKeyed`
    // and `delete` unguarded. That claim is about a class this file cannot
    // pin with an assignability check, so pin it on the prototype instead: if
    // someone later adds these methods, this test fails and the doc comment
    // (and possibly the port) must be revisited.
    const proto = EncryptedMemoryService.prototype as unknown as Record<
      string,
      unknown
    >;

    expect(typeof proto["getKeyed"]).toBe("undefined");
    expect(typeof proto["delete"]).toBe("undefined");

    // Control: the members it DOES expose are present, so the assertions above
    // are testing absence rather than a mistyped prototype reference.
    expect(typeof proto["get"]).toBe("function");
    expect(typeof proto["put"]).toBe("function");
    expect(typeof proto["formatForPrompt"]).toBe("function");
  });
});
