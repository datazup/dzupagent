/**
 * Minimal-chunker tests — SmartChunker exercised with minimal / simplest-
 * possible configurations.  Covers the "basic split, max-chunk respected,
 * no trailing empty chunks" surface without repeating the full boundary-
 * detection suite in chunker.test.ts.
 */

import { describe, it, expect } from "vitest";
import { SmartChunker } from "../chunker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a SmartChunker in the simplest useful configuration:
 *   - no boundary detection (pure fixed-size splits)
 *   - no overlap
 *   - caller controls targetTokens
 */
function minimalChunker(targetTokens: number): SmartChunker {
  return new SmartChunker({
    targetTokens,
    overlapFraction: 0,
    respectBoundaries: false,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SmartChunker — minimal configuration", () => {
  // =========================================================================
  // Basic split
  // =========================================================================

  describe("basic split", () => {
    it("splits text into chunks when it exceeds the target size", () => {
      const chunker = minimalChunker(10); // 10 tokens = 40 chars
      const text = "a".repeat(200);
      const result = chunker.chunkText(text, "src");
      expect(result.length).toBeGreaterThan(1);
    });

    it("returns a single chunk when text fits within target", () => {
      const chunker = minimalChunker(100); // 400 chars
      const result = chunker.chunkText("Hello world.", "src");
      expect(result).toHaveLength(1);
    });

    it("chunk text covers the original content (no data loss)", () => {
      const chunker = minimalChunker(10);
      const text = "abcde".repeat(40);
      const result = chunker.chunkText(text, "src");
      const reconstructed = result.map((c) => c.text).join("");
      // Reconstruction should contain the same characters (trimming allowed)
      expect(reconstructed.replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
    });

    it("chunk IDs are unique across all chunks", () => {
      const chunker = minimalChunker(10);
      const text = "x".repeat(400);
      const result = chunker.chunkText(text, "src");
      const ids = result.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("consecutive chunk indices start at 0", () => {
      const chunker = minimalChunker(10);
      const text = "y".repeat(400);
      const result = chunker.chunkText(text, "src");
      expect(result[0]!.metadata.chunkIndex).toBe(0);
    });

    it("consecutive chunk indices are sequential with no gaps", () => {
      const chunker = minimalChunker(10);
      const text = "y".repeat(400);
      const result = chunker.chunkText(text, "src");
      for (let i = 0; i < result.length; i++) {
        expect(result[i]!.metadata.chunkIndex).toBe(i);
      }
    });
  });

  // =========================================================================
  // Max-chunk size respected
  // =========================================================================

  describe("max-chunk size respected", () => {
    it("no chunk exceeds roughly 2× the target token budget", () => {
      const targetTokens = 20;
      const chunker = minimalChunker(targetTokens);
      const text = "w".repeat(1000);
      const result = chunker.chunkText(text, "src");
      // Allow 2× for trailing-chunk merge, but not 3×
      for (const chunk of result) {
        expect(chunk.tokenCount).toBeLessThanOrEqual(targetTokens * 2);
      }
    });

    it("approximate chunk length matches targetTokens × 4 chars", () => {
      const targetTokens = 50;
      const chunker = minimalChunker(targetTokens);
      const text = "z".repeat(2000);
      const result = chunker.chunkText(text, "src");
      // All chunks except possibly the merged last one should be close to target
      for (const chunk of result.slice(0, -1)) {
        expect(chunk.text.length).toBeGreaterThan(targetTokens * 2); // at least half
      }
    });
  });

  // =========================================================================
  // No trailing empty chunks
  // =========================================================================

  describe("no trailing empty chunks", () => {
    it("does not emit empty-text chunks for any input", () => {
      const chunker = minimalChunker(10);
      const text = "content ".repeat(50);
      const result = chunker.chunkText(text, "src");
      for (const chunk of result) {
        expect(chunk.text.trim().length).toBeGreaterThan(0);
      }
    });

    it("does not emit empty-text chunks for text that is exactly one target size", () => {
      const chunker = minimalChunker(10); // 40 chars exactly
      const text = "a".repeat(40);
      const result = chunker.chunkText(text, "src");
      expect(result).toHaveLength(1);
      expect(result[0]!.text.trim().length).toBeGreaterThan(0);
    });

    it("returns [] rather than a chunk with empty text for whitespace input", () => {
      const chunker = minimalChunker(10);
      const result = chunker.chunkText("   \n   ", "src");
      expect(result).toEqual([]);
    });

    it("does not produce a zero-length trailing chunk after splitting", () => {
      // Use a size that divides evenly to try to produce a zero-length tail
      const chunker = minimalChunker(10); // 40 chars
      const text = "a".repeat(80); // exactly 2 chunks
      const result = chunker.chunkText(text, "src");
      for (const chunk of result) {
        expect(chunk.text.length).toBeGreaterThan(0);
      }
    });
  });

  // =========================================================================
  // Metadata invariants
  // =========================================================================

  describe("metadata invariants", () => {
    it("sourceId on every chunk matches the supplied id argument", () => {
      const chunker = minimalChunker(10);
      const text = "b".repeat(200);
      const result = chunker.chunkText(text, "my-source-id");
      for (const chunk of result) {
        expect(chunk.metadata.sourceId).toBe("my-source-id");
      }
    });

    it("startOffset of first chunk is 0", () => {
      const chunker = minimalChunker(10);
      const text = "c".repeat(200);
      const result = chunker.chunkText(text, "src");
      expect(result[0]!.metadata.startOffset).toBe(0);
    });

    it("endOffset > startOffset for every chunk", () => {
      const chunker = minimalChunker(10);
      const text = "d".repeat(200);
      const result = chunker.chunkText(text, "src");
      for (const chunk of result) {
        expect(chunk.metadata.endOffset).toBeGreaterThan(
          chunk.metadata.startOffset
        );
      }
    });

    it("boundaryType is token for every chunk when respectBoundaries=false", () => {
      const chunker = minimalChunker(10);
      const text = "e".repeat(200);
      const result = chunker.chunkText(text, "src");
      for (const chunk of result) {
        expect(chunk.metadata.boundaryType).toBe("token");
      }
    });

    it("tokenCount equals ceil(text.length / 4)", () => {
      const chunker = minimalChunker(30);
      const text = "f".repeat(600);
      const result = chunker.chunkText(text, "src");
      for (const chunk of result) {
        expect(chunk.tokenCount).toBe(Math.ceil(chunk.text.length / 4));
      }
    });
  });

  // =========================================================================
  // quality field
  // =========================================================================

  describe("quality field", () => {
    it("every chunk has quality in [0, 1]", () => {
      const chunker = minimalChunker(15);
      const text = "word ".repeat(200);
      const result = chunker.chunkText(text, "src");
      for (const chunk of result) {
        expect(chunk.quality).toBeGreaterThanOrEqual(0);
        expect(chunk.quality).toBeLessThanOrEqual(1);
      }
    });

    it("single-chunk documents have quality > 0", () => {
      const chunker = minimalChunker(500);
      const text =
        "A well-formed sentence for testing quality scoring. " +
        "It contains enough words to score above zero on meaningful metrics.";
      const result = chunker.chunkText(text, "src");
      expect(result).toHaveLength(1);
      expect(result[0]!.quality).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Very small targetTokens (extreme)
  // =========================================================================

  describe("extreme target tokens", () => {
    it("targetTokens=1 still produces valid chunks without infinite loops", () => {
      const chunker = minimalChunker(1);
      const text = "Hello world this is a test.";
      const result = chunker.chunkText(text, "src");
      expect(result.length).toBeGreaterThan(0);
      for (const chunk of result) {
        expect(chunk.text.length).toBeGreaterThan(0);
      }
    });

    it("targetTokens=1 progress always advances (no infinite loop)", () => {
      const chunker = minimalChunker(1);
      const text = "a".repeat(50);
      // If the chunker were to loop forever this test would time out.
      const result = chunker.chunkText(text, "src");
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
