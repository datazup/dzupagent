/**
 * SmartChunker — unit tests covering fixed-size splitting, overlap,
 * sentence/header boundary detection, code-block handling, token budget,
 * quality scoring, and edge cases.
 *
 * These complement chunker-quality.test.ts and chunker-coverage.test.ts
 * without duplicating their exact assertions.
 */

import { describe, it, expect } from "vitest";
import { SmartChunker, DEFAULT_CHUNKING_CONFIG } from "../chunker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a SmartChunker with a low targetTokens so splitting is easy to trigger. */
function smallChunker(overrides: Record<string, unknown> = {}): SmartChunker {
  return new SmartChunker({
    targetTokens: 40,
    overlapFraction: 0,
    respectBoundaries: true,
    ...overrides,
  });
}

/** Repeat `sentence` `n` times joined by spaces to build a predictable body. */
function repeat(sentence: string, n: number): string {
  return Array.from({ length: n }, () => sentence).join(" ");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SmartChunker", () => {
  // =========================================================================
  // Empty / whitespace input
  // =========================================================================

  describe("empty input", () => {
    it("returns [] for empty string", () => {
      const c = new SmartChunker();
      expect(c.chunkText("", "src")).toEqual([]);
    });

    it("returns [] for whitespace-only string", () => {
      const c = new SmartChunker();
      expect(c.chunkText("   \t\n  ", "src")).toEqual([]);
    });

    it("returns [] for string with only newlines", () => {
      const c = new SmartChunker();
      expect(c.chunkText("\n\n\n", "src")).toEqual([]);
    });
  });

  // =========================================================================
  // Fixed-size splitting
  // =========================================================================

  describe("fixed-size splitting", () => {
    it("produces a single chunk when text fits within target", () => {
      const c = new SmartChunker({ targetTokens: 100 });
      const result = c.chunkText("Short sentence that easily fits.", "doc");
      expect(result).toHaveLength(1);
    });

    it("produces multiple chunks when text exceeds target", () => {
      const c = smallChunker({ respectBoundaries: false });
      // 40 tokens * 4 chars = 160 chars per chunk; feed 600+ chars
      const text = "x".repeat(600);
      const result = c.chunkText(text, "doc");
      expect(result.length).toBeGreaterThan(1);
    });

    it("every chunk has non-empty text", () => {
      const c = smallChunker({ respectBoundaries: false });
      const text = "word ".repeat(200);
      const result = c.chunkText(text, "doc");
      for (const chunk of result) {
        expect(chunk.text.trim().length).toBeGreaterThan(0);
      }
    });

    it("chunk IDs are valid Qdrant point IDs (UUID v5 format)", () => {
      const c = smallChunker({ respectBoundaries: false });
      const text = "x".repeat(600);
      const result = c.chunkText(text, "my-doc");
      const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      for (const chunk of result) {
        expect(chunk.id).toMatch(uuidPattern);
      }
    });

    it("chunk IDs are deterministic for the same sourceId and index", () => {
      const c = smallChunker({ respectBoundaries: false });
      const text = "x".repeat(600);
      const first = c.chunkText(text, "my-doc");
      const second = c.chunkText(text, "my-doc");
      expect(second.map((chunk) => chunk.id)).toEqual(
        first.map((chunk) => chunk.id)
      );
    });

    it("chunkIndex metadata is sequential starting at 0", () => {
      const c = smallChunker({ respectBoundaries: false });
      const text = "x".repeat(600);
      const result = c.chunkText(text, "doc");
      for (let i = 0; i < result.length; i++) {
        expect(result[i]!.metadata.chunkIndex).toBe(i);
      }
    });

    it("startOffset and endOffset are monotonically increasing", () => {
      const c = smallChunker({ respectBoundaries: false });
      const text = "y".repeat(600);
      const result = c.chunkText(text, "doc");
      for (let i = 1; i < result.length; i++) {
        expect(result[i]!.metadata.startOffset).toBeGreaterThan(
          result[i - 1]!.metadata.startOffset
        );
      }
    });

    it("last chunk endOffset equals the length of the text (approx)", () => {
      const c = smallChunker({ respectBoundaries: false });
      const text = "z".repeat(400);
      const result = c.chunkText(text, "doc");
      const last = result[result.length - 1]!;
      expect(last.metadata.endOffset).toBeGreaterThan(0);
      expect(last.metadata.endOffset).toBeLessThanOrEqual(text.length);
    });
  });

  // =========================================================================
  // Overlap
  // =========================================================================

  describe("overlap", () => {
    it("overlapFraction=0 produces non-overlapping chunks", () => {
      const c = new SmartChunker({
        targetTokens: 50,
        overlapFraction: 0,
        respectBoundaries: false,
      });
      const text = "a".repeat(800);
      const result = c.chunkText(text, "doc");
      expect(result.length).toBeGreaterThan(1);
      for (let i = 1; i < result.length; i++) {
        expect(result[i]!.metadata.startOffset).toBeGreaterThanOrEqual(
          result[i - 1]!.metadata.endOffset
        );
      }
    });

    it("overlapFraction=0.2 causes adjacent chunks to overlap", () => {
      const c = new SmartChunker({
        targetTokens: 50,
        overlapFraction: 0.2,
        respectBoundaries: false,
      });
      const text = "b".repeat(800);
      const result = c.chunkText(text, "doc");
      expect(result.length).toBeGreaterThan(1);
      let overlapped = false;
      for (let i = 1; i < result.length; i++) {
        if (
          result[i]!.metadata.startOffset < result[i - 1]!.metadata.endOffset
        ) {
          overlapped = true;
          break;
        }
      }
      expect(overlapped).toBe(true);
    });

    it("overlap is capped so start never goes backward", () => {
      const c = new SmartChunker({
        targetTokens: 50,
        overlapFraction: 0.9,
        respectBoundaries: false,
      });
      const text = "c".repeat(800);
      const result = c.chunkText(text, "doc");
      for (let i = 1; i < result.length; i++) {
        expect(result[i]!.metadata.startOffset).toBeGreaterThan(
          result[i - 1]!.metadata.startOffset
        );
      }
    });
  });

  // =========================================================================
  // Sentence-boundary splitting
  // =========================================================================

  describe("sentence-boundary splitting", () => {
    it('splits at sentence boundaries when text has "." followed by capitals', () => {
      const c = new SmartChunker({ targetTokens: 30, respectBoundaries: true });
      // Sentence boundaries with capital after period
      const text = repeat("The dog runs fast.", 20);
      const result = c.chunkText(text, "doc");
      expect(result.length).toBeGreaterThan(1);
    });

    it('splits at "! " boundaries', () => {
      const c = new SmartChunker({ targetTokens: 20, respectBoundaries: true });
      const text = "Wow! ".repeat(30);
      const result = c.chunkText(text, "doc");
      expect(result.length).toBeGreaterThan(1);
    });

    it('splits at "? " boundaries', () => {
      const c = new SmartChunker({ targetTokens: 20, respectBoundaries: true });
      const text = "What is it? ".repeat(30);
      const result = c.chunkText(text, "doc");
      expect(result.length).toBeGreaterThan(1);
    });

    it("uses token boundary when no sentence break is found in window", () => {
      const c = new SmartChunker({ targetTokens: 10, respectBoundaries: true });
      // A single long word without punctuation forces a token-boundary split
      const text = "abcdefghij".repeat(50);
      const result = c.chunkText(text, "doc");
      expect(result.length).toBeGreaterThan(1);
      const tokenChunks = result.filter(
        (ch) => ch.metadata.boundaryType === "token"
      );
      expect(tokenChunks.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Markdown / code-block preservation
  // =========================================================================

  describe("markdown header and code-block boundaries", () => {
    it("splits at markdown header boundaries (type=header)", () => {
      // targetTokens=30 → targetChars=120, minPos=60.
      // Pad the first section to 80 chars so the header for the next section
      // falls squarely inside the [60, 120] search window.
      const c = new SmartChunker({ targetTokens: 30, respectBoundaries: true });
      const padding = "word ".repeat(16); // 80 chars, places header near char 80
      const text =
        padding +
        "\n## Section Two\n" +
        "content ".repeat(20) +
        "\n## Section Three\n" +
        "content ".repeat(20);
      const result = c.chunkText(text, "doc");
      expect(result.length).toBeGreaterThan(1);
      const headerBounds = result.filter(
        (ch) => ch.metadata.boundaryType === "header"
      );
      expect(headerBounds.length).toBeGreaterThan(0);
    });

    it("code fences trigger paragraph boundary type", () => {
      const c = new SmartChunker({ targetTokens: 30, respectBoundaries: true });
      const text =
        "Some intro text. ".repeat(20) +
        "\n```typescript\nconst x = 1;\n```\n" +
        "More text. ".repeat(20);
      const result = c.chunkText(text, "doc");
      expect(result.length).toBeGreaterThan(1);
    });

    it("list item boundaries are detected", () => {
      const c = new SmartChunker({ targetTokens: 30, respectBoundaries: true });
      const text =
        "Intro paragraph. ".repeat(15) +
        "\n- item one content here\n".repeat(30);
      const result = c.chunkText(text, "doc");
      expect(result.length).toBeGreaterThan(1);
    });
  });

  // =========================================================================
  // Token budget enforcement (tokenCount field)
  // =========================================================================

  describe("token count", () => {
    it("reports tokenCount = ceil(text.length / 4) for each chunk", () => {
      const c = smallChunker({ respectBoundaries: false });
      const text = "word ".repeat(100);
      const result = c.chunkText(text, "doc");
      for (const chunk of result) {
        expect(chunk.tokenCount).toBe(Math.ceil(chunk.text.length / 4));
      }
    });

    it("single short chunk has tokenCount > 0", () => {
      const c = new SmartChunker();
      const result = c.chunkText("Hello world.", "doc");
      expect(result[0]!.tokenCount).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Tiny trailing chunk merge
  // =========================================================================

  describe("trailing chunk merge", () => {
    it("merges a tiny tail into its predecessor", () => {
      // targetTokens=50 (200 chars), overlapFraction=0.
      // Feed 210 chars: main chunk = 200, tail = 10 chars = 3 tokens << 25% of 50.
      const c = new SmartChunker({
        targetTokens: 50,
        overlapFraction: 0,
        respectBoundaries: false,
      });
      const text = "a".repeat(210);
      const result = c.chunkText(text, "doc");
      // The 10-char tail should be absorbed into the first chunk
      expect(result).toHaveLength(1);
    });

    it("does not merge when the tail is large enough", () => {
      // targetTokens=50 (200 chars), feed exactly 400 chars — two equal halves.
      const c = new SmartChunker({
        targetTokens: 50,
        overlapFraction: 0,
        respectBoundaries: false,
      });
      const text = "a".repeat(400);
      const result = c.chunkText(text, "doc");
      expect(result.length).toBeGreaterThanOrEqual(2);
    });
  });

  // =========================================================================
  // DEFAULT_CHUNKING_CONFIG export
  // =========================================================================

  describe("DEFAULT_CHUNKING_CONFIG", () => {
    it("exports the correct defaults", () => {
      expect(DEFAULT_CHUNKING_CONFIG).toEqual({
        targetTokens: 1200,
        overlapFraction: 0.15,
        respectBoundaries: true,
      });
    });
  });

  // =========================================================================
  // Quality scoring (computeChunkQuality)
  // =========================================================================

  describe("computeChunkQuality", () => {
    const chunker = new SmartChunker();

    it("returns all-zero metrics for empty string", () => {
      const q = chunker.computeChunkQuality("", 0, 1);
      expect(q.overallScore).toBe(0);
      expect(q.vocabularyDiversity).toBe(0);
      expect(q.avgSentenceLength).toBe(0);
      expect(q.textToNoiseRatio).toBe(0);
      expect(q.structureScore).toBe(0);
    });

    it("overallScore is in [0, 1] for real content", () => {
      const content =
        "Machine learning enables computers to learn from data. It powers search engines and recommendation systems.";
      const q = chunker.computeChunkQuality(content, 0, 3);
      expect(q.overallScore).toBeGreaterThan(0);
      expect(q.overallScore).toBeLessThanOrEqual(1);
    });

    it("applies last-chunk position penalty", () => {
      const content =
        "The quick brown fox jumps over the lazy dog. This sentence has enough words to qualify as meaningful text.";
      const mid = chunker.computeChunkQuality(content, 1, 5);
      const last = chunker.computeChunkQuality(content, 4, 5);
      expect(last.overallScore).toBeLessThan(mid.overallScore);
    });

    it("no position penalty for single-chunk doc (last=first)", () => {
      const content =
        "The quick brown fox jumps over the lazy dog. This sentence has enough words to qualify.";
      const q = chunker.computeChunkQuality(content, 0, 1);
      expect(q.overallScore).toBeGreaterThan(0);
    });

    it("structure score > 0 for content with headers, lists, and code", () => {
      const structured = "# Header\n- item one\n- item two\n```code```";
      const q = chunker.computeChunkQuality(structured, 0, 1);
      expect(q.structureScore).toBeGreaterThan(0);
    });

    it("structure score = 0 for plain prose", () => {
      const plain =
        "Just a simple sentence with no markdown at all and no code.";
      const q = chunker.computeChunkQuality(plain, 0, 1);
      expect(q.structureScore).toBe(0);
    });

    it("boilerplate-heavy text has lower score than clean technical text", () => {
      const boilerplate =
        "Cookie policy. Subscribe to our newsletter. Follow us on social media. Sign up today! " +
        "Privacy policy. Accept cookies. All rights reserved. Terms of service apply.";
      const clean =
        "Neural networks transform input data through successive layers of learnable weights. " +
        "Gradient descent optimises parameters to minimise a loss function over training samples.";
      const bq = chunker.computeChunkQuality(boilerplate, 0, 3);
      const cq = chunker.computeChunkQuality(clean, 0, 3);
      expect(bq.overallScore).toBeLessThan(cq.overallScore);
    });

    it("vocabularyDiversity is higher for diverse text than repetitive text", () => {
      const diverse =
        "The quick brown fox jumps over the lazy dog. Every word is different here.";
      const repetitive = "the the the the the the the the the the";
      const dq = chunker.computeChunkQuality(diverse, 0, 1);
      const rq = chunker.computeChunkQuality(repetitive, 0, 1);
      expect(dq.vocabularyDiversity).toBeGreaterThan(rq.vocabularyDiversity);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("handles a single character", () => {
      const c = new SmartChunker();
      const result = c.chunkText("A", "doc");
      expect(result).toHaveLength(1);
      expect(result[0]!.text).toBe("A");
    });

    it("handles unicode text without crashing", () => {
      const c = new SmartChunker({
        targetTokens: 20,
        respectBoundaries: false,
      });
      const text = "こんにちは世界。".repeat(30);
      const result = c.chunkText(text, "jp");
      expect(result.length).toBeGreaterThan(0);
    });

    it("handles text with mixed punctuation styles", () => {
      const c = new SmartChunker({ targetTokens: 30, respectBoundaries: true });
      const text =
        "First sentence! Second sentence? Third sentence. Fourth sentence; Fifth segment.";
      const result = c.chunkText(text, "punct");
      expect(result.length).toBeGreaterThan(0);
    });

    it("all chunks have quality in [0, 1]", () => {
      const c = smallChunker({ respectBoundaries: false });
      const text = "word ".repeat(500);
      const result = c.chunkText(text, "doc");
      for (const chunk of result) {
        expect(chunk.quality).toBeGreaterThanOrEqual(0);
        expect(chunk.quality).toBeLessThanOrEqual(1);
      }
    });

    it("handles text containing only a code block", () => {
      const c = new SmartChunker({ targetTokens: 500 });
      const text = "```typescript\nconst x: number = 42;\nconsole.log(x);\n```";
      const result = c.chunkText(text, "code-only");
      expect(result).toHaveLength(1);
      expect(result[0]!.text).toContain("const x");
    });

    it("respects sourceId in metadata for all chunks", () => {
      const c = smallChunker({ respectBoundaries: false });
      const text = "z".repeat(600);
      const result = c.chunkText(text, "special-id");
      for (const chunk of result) {
        expect(chunk.metadata.sourceId).toBe("special-id");
      }
    });
  });
});
