import { describe, it, expect, beforeEach } from "vitest";
import { OpenAICompletionMapper } from "../completion-mapper.js";

describe("OpenAICompletionMapper", () => {
  let sut: OpenAICompletionMapper;

  beforeEach(() => {
    sut = new OpenAICompletionMapper();
  });

  // ---------------------------------------------------------------------------
  // mapChunk
  // ---------------------------------------------------------------------------

  describe("mapChunk", () => {
    it("should return a valid ChatCompletionChunk shape", () => {
      const chunk = sut.mapChunk("hello", "agent-1", "chatcmpl-xyz", 0, false);

      expect(chunk).toEqual(
        expect.objectContaining({
          id: "chatcmpl-xyz",
          object: "chat.completion.chunk",
          model: "agent-1",
        })
      );
      expect(typeof chunk.created).toBe("number");
      expect(chunk.choices).toHaveLength(1);
    });

    it("should set object to chat.completion.chunk", () => {
      const chunk = sut.mapChunk("hello", "agent-1", "id-1", 0, false);

      expect(chunk.object).toBe("chat.completion.chunk");
    });

    it("should set finish_reason to null for non-last chunks", () => {
      const chunk = sut.mapChunk("hello", "agent-1", "id-1", 0, false);

      expect(chunk.choices[0]!.finish_reason).toBeNull();
    });

    it("should set finish_reason to stop for the last chunk", () => {
      const chunk = sut.mapChunk("", "agent-1", "id-1", 0, true);

      expect(chunk.choices[0]!.finish_reason).toBe("stop");
    });

    it("should include delta.content for non-last chunks", () => {
      const chunk = sut.mapChunk("world", "agent-1", "id-1", 0, false);

      expect(chunk.choices[0]!.delta.content).toBe("world");
      expect(chunk.choices[0]!.delta.role).toBe("assistant");
    });

    it("should have an empty delta for the last chunk", () => {
      const chunk = sut.mapChunk("", "agent-1", "id-1", 0, true);

      expect(chunk.choices[0]!.delta).toEqual({});
    });

    it("should propagate the choice index", () => {
      const chunk = sut.mapChunk("text", "agent-1", "id-1", 3, false);

      expect(chunk.choices[0]!.index).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // generateId
  // ---------------------------------------------------------------------------

  describe("generateId", () => {
    it("should return a string starting with chatcmpl-", () => {
      const id = sut.generateId();

      expect(id).toMatch(/^chatcmpl-/);
    });

    it("should return a string of the expected length (chatcmpl- prefix + 24 chars)", () => {
      const id = sut.generateId();

      // "chatcmpl-" is 9 chars, plus 24 random chars = 33
      expect(id).toHaveLength(9 + 24);
    });

    it("should generate unique IDs on successive calls", () => {
      const ids = new Set(Array.from({ length: 50 }, () => sut.generateId()));

      expect(ids.size).toBe(50);
    });
  });
});
