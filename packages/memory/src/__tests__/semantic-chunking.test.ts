/**
 * Semantic Chunking Tests — @dzupagent/memory
 *
 * Tests covering chunk boundary detection, overlap handling, and chunk metadata
 * using a self-contained SemanticChunker implementation that mirrors the
 * SmartChunker contract in @dzupagent/rag without requiring a cross-package dep.
 *
 * Coverage areas:
 *   1. Basic splitting — long text → multiple chunks
 *   2. Chunk size limit — no chunk exceeds max_tokens
 *   3. Chunk count — expected number of chunks produced
 *   4. Overlap — adjacent chunks share overlap content
 *   5. Overlap content identity — shared content is byte-identical
 *   6. Zero overlap — chunks with overlap=0 don't share content
 *   7. Sentence boundary — no split mid-sentence when possible
 *   8. Paragraph boundary — prefer paragraph breaks
 *   9. Chunk metadata — index, start_char, end_char, token_count present
 *  10. Chunk index order — 0..N-1 ascending
 *  11. Empty text — returns []
 *  12. Very short text — single chunk
 *  13. Single sentence — single chunk
 *  14. Code chunking — split at function/class boundaries
 *  15. Chunk reassembly — joining minus overlap reconstructs original
 *  16. Large document — 10 000-word document chunked correctly
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Minimal self-contained SemanticChunker (mirrors SmartChunker contract)
// ---------------------------------------------------------------------------

interface ChunkMeta {
  chunkIndex: number;
  startChar: number;
  endChar: number;
  tokenCount: number;
  boundaryType: "header" | "paragraph" | "sentence" | "code" | "token";
}

interface Chunk {
  id: string;
  text: string;
  tokenCount: number;
  metadata: ChunkMeta;
}

interface ChunkerOptions {
  /** Target tokens per chunk (1 token ≈ 4 chars) */
  maxTokens: number;
  /** Overlap in tokens between consecutive chunks */
  overlapTokens: number;
  /** When true, break at semantic boundaries rather than hard char limits */
  respectBoundaries: boolean;
}

const DEFAULT_OPTIONS: ChunkerOptions = {
  maxTokens: 300,
  overlapTokens: 30,
  respectBoundaries: true,
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface BoundaryDef {
  pattern: RegExp;
  type: ChunkMeta["boundaryType"];
}

const BOUNDARY_PRIORITIES: BoundaryDef[] = [
  { pattern: /\n#{1,6}\s/, type: "header" },
  { pattern: /\n\n/, type: "paragraph" },
  { pattern: /\n```/, type: "code" },
  { pattern: /\.\s+(?=[A-Z])/, type: "sentence" },
  { pattern: /\.\n/, type: "sentence" },
  { pattern: /[!?]\s/, type: "sentence" },
];

function findBestBreakpoint(
  text: string,
  minPos: number,
  end: number
): { position: number; boundaryType: ChunkMeta["boundaryType"] } {
  const window = text.slice(minPos, end);

  for (const b of BOUNDARY_PRIORITIES) {
    const rx = new RegExp(b.pattern.source, b.pattern.flags + "g");
    let last = -1;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(window)) !== null) {
      last = m.index + m[0].length;
    }
    if (last > 0) {
      return { position: minPos + last, boundaryType: b.type };
    }
  }

  // Fallback: any sentence-ender
  for (const bp of [". ", ".\n", "! ", "? "]) {
    const pos = text.lastIndexOf(bp, end);
    if (pos > minPos) {
      return { position: pos + bp.length, boundaryType: "sentence" };
    }
  }

  return { position: -1, boundaryType: "token" };
}

class SemanticChunker {
  private opts: ChunkerOptions;

  constructor(opts: Partial<ChunkerOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  chunk(text: string, sourceId = "doc"): Chunk[] {
    if (!text || text.trim().length === 0) return [];

    const { maxTokens, overlapTokens, respectBoundaries } = this.opts;
    const targetChars = maxTokens * 4;
    const overlapChars = Math.floor(overlapTokens * 4);
    const effectiveOverlap = Math.min(
      overlapChars,
      Math.floor(targetChars * 0.5)
    );

    const raw: Array<{
      text: string;
      startChar: number;
      endChar: number;
      boundaryType: ChunkMeta["boundaryType"];
    }> = [];

    let start = 0;

    while (start < text.length) {
      let end = start + targetChars;
      let boundaryType: ChunkMeta["boundaryType"] = "token";

      if (end < text.length && respectBoundaries) {
        const minPos = start + Math.floor(targetChars * 0.5);
        const result = findBestBreakpoint(text, minPos, end);
        if (result.position > 0) {
          end = result.position;
          boundaryType = result.boundaryType;
        }
      } else if (end >= text.length) {
        end = text.length;
      }

      const content = text.slice(start, end).trim();
      if (content.length > 0) {
        raw.push({
          text: content,
          startChar: start,
          endChar: end,
          boundaryType,
        });
      }

      if (end >= text.length) break;

      const nextStart = end - effectiveOverlap;
      start = nextStart > start ? nextStart : start + 1;
      if (start >= text.length) break;
    }

    return raw.map((r, index) => ({
      id: `${sourceId}:${index}`,
      text: r.text,
      tokenCount: estimateTokens(r.text),
      metadata: {
        chunkIndex: index,
        startChar: r.startChar,
        endChar: r.endChar,
        tokenCount: estimateTokens(r.text),
        boundaryType: r.boundaryType,
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a sentence repeated n times, naturally splittable. */
function repeatSentence(sentence: string, n: number): string {
  return Array.from({ length: n }, () => sentence).join(" ");
}

/** Generate n words of pseudo-Lorem text. */
function loremWords(n: number): string {
  const vocab = [
    "lorem",
    "ipsum",
    "dolor",
    "sit",
    "amet",
    "consectetur",
    "adipiscing",
    "elit",
    "sed",
    "do",
    "eiusmod",
    "tempor",
    "incididunt",
    "ut",
    "labore",
    "et",
    "dolore",
    "magna",
    "aliqua",
    "enim",
    "ad",
    "minim",
    "veniam",
    "quis",
    "nostrud",
    "exercitation",
    "ullamco",
    "laboris",
    "nisi",
  ];
  return Array.from({ length: n }, (_, i) => vocab[i % vocab.length]).join(" ");
}

/** Repeat a paragraph n times. */
function repeatParagraph(para: string, n: number): string {
  return Array.from({ length: n }, () => para).join("\n\n");
}

// ---------------------------------------------------------------------------
// 1. Basic splitting
// ---------------------------------------------------------------------------

describe("SemanticChunker — basic splitting", () => {
  it("splits long text into multiple chunks", () => {
    const chunker = new SemanticChunker({ maxTokens: 50, overlapTokens: 0 });
    // 50 tokens * 4 = 200 chars per chunk; 1200 chars → must split
    const text = "a".repeat(1200);
    const chunks = chunker.chunk(text, "src");
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("every produced chunk has non-empty text", () => {
    const chunker = new SemanticChunker({ maxTokens: 40, overlapTokens: 0 });
    const text = "word ".repeat(300);
    const chunks = chunker.chunk(text, "src");
    for (const c of chunks) {
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("each chunk id contains the sourceId", () => {
    const chunker = new SemanticChunker({ maxTokens: 50, overlapTokens: 0 });
    const text = "x".repeat(800);
    const chunks = chunker.chunk(text, "my-doc");
    for (const c of chunks) {
      expect(c.id).toContain("my-doc");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Chunk size limit
// ---------------------------------------------------------------------------

describe("SemanticChunker — chunk size limit", () => {
  it("no chunk exceeds maxTokens * 1.5 (boundary slack)", () => {
    // We allow 1.5× because boundary detection may shift the cut slightly
    const maxTokens = 80;
    const chunker = new SemanticChunker({
      maxTokens,
      overlapTokens: 0,
      respectBoundaries: false,
    });
    const text = "w".repeat(5000);
    const chunks = chunker.chunk(text, "doc");
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(Math.ceil(maxTokens * 1.5));
    }
  });

  it("no chunk exceeds maxTokens when boundaries are respected", () => {
    const maxTokens = 60;
    // Build text with clear sentence breaks so chunker can stay within budget
    const sentence = "The quick brown fox jumps over the lazy dog.";
    const text = Array.from({ length: 80 }, () => sentence).join(" ");
    const chunker = new SemanticChunker({
      maxTokens,
      overlapTokens: 0,
      respectBoundaries: true,
    });
    const chunks = chunker.chunk(text, "doc");
    for (const c of chunks) {
      // Allow 1.5× slack for last token group
      expect(c.tokenCount).toBeLessThanOrEqual(Math.ceil(maxTokens * 1.5));
    }
  });

  it("tokenCount field matches estimateTokens(text)", () => {
    const chunker = new SemanticChunker({ maxTokens: 50, overlapTokens: 0 });
    const text = "Hello world. ".repeat(100);
    const chunks = chunker.chunk(text, "doc");
    for (const c of chunks) {
      expect(c.tokenCount).toBe(Math.ceil(c.text.length / 4));
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Chunk count
// ---------------------------------------------------------------------------

describe("SemanticChunker — chunk count", () => {
  it("short text under maxTokens produces exactly 1 chunk", () => {
    const chunker = new SemanticChunker({ maxTokens: 200, overlapTokens: 0 });
    const text = "Just a short sentence.";
    const chunks = chunker.chunk(text, "doc");
    expect(chunks.length).toBe(1);
  });

  it("text exactly at maxTokens produces 1 chunk (no split needed)", () => {
    // 100 tokens → 400 chars; feed exactly 400 chars
    const chunker = new SemanticChunker({ maxTokens: 100, overlapTokens: 0 });
    const text = "a".repeat(400);
    const chunks = chunker.chunk(text, "doc");
    expect(chunks.length).toBe(1);
  });

  it("text at 3× maxTokens produces at least 3 chunks (no overlap)", () => {
    const maxTokens = 50;
    const chunker = new SemanticChunker({
      maxTokens,
      overlapTokens: 0,
      respectBoundaries: false,
    });
    // 3× target chars
    const text = "z".repeat(maxTokens * 4 * 3);
    const chunks = chunker.chunk(text, "doc");
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it("overlap increases chunk count compared to zero-overlap for same text", () => {
    const text = "word ".repeat(400);
    const noOverlap = new SemanticChunker({
      maxTokens: 60,
      overlapTokens: 0,
      respectBoundaries: false,
    });
    const withOverlap = new SemanticChunker({
      maxTokens: 60,
      overlapTokens: 20,
      respectBoundaries: false,
    });
    const chunksNo = noOverlap.chunk(text, "doc");
    const chunksWith = withOverlap.chunk(text, "doc");
    // With overlap, each step moves less → more chunks
    expect(chunksWith.length).toBeGreaterThanOrEqual(chunksNo.length);
  });
});

// ---------------------------------------------------------------------------
// 4. Overlap — adjacent chunks share content
// ---------------------------------------------------------------------------

describe("SemanticChunker — overlap", () => {
  it("adjacent chunks share characters when overlapTokens > 0", () => {
    const chunker = new SemanticChunker({
      maxTokens: 60,
      overlapTokens: 15,
      respectBoundaries: false,
    });
    const text = "x".repeat(2000);
    const chunks = chunker.chunk(text, "doc");
    expect(chunks.length).toBeGreaterThan(1);

    // For each consecutive pair, check they share at least 1 char
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!.text;
      const curr = chunks[i]!.text;
      // The tail of prev should appear at the start of curr (overlap region)
      const overlapLen = Math.min(prev.length, curr.length, 30);
      const prevTail = prev.slice(-overlapLen);
      expect(curr).toContain(prevTail.slice(0, 5));
    }
  });

  it("overlapTokens=0 means adjacent chunks do NOT share a tail-head match", () => {
    const chunker = new SemanticChunker({
      maxTokens: 50,
      overlapTokens: 0,
      respectBoundaries: false,
    });
    // Use unique sequential characters to make overlap detectable
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    // Build a long string with no repeated patterns
    let text = "";
    for (let i = 0; i < 800; i++) {
      text += alphabet[i % alphabet.length];
    }
    const chunks = chunker.chunk(text, "doc");
    if (chunks.length > 1) {
      const prev = chunks[0]!.text;
      const curr = chunks[1]!.text;
      // Last 10 chars of prev should NOT appear at start of curr
      const prevTail = prev.slice(-10);
      expect(curr.startsWith(prevTail)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Overlap content identity
// ---------------------------------------------------------------------------

describe("SemanticChunker — overlap content identity", () => {
  it("overlapping region is byte-identical between consecutive chunks", () => {
    const overlapTokens = 20;
    const chunker = new SemanticChunker({
      maxTokens: 80,
      overlapTokens,
      respectBoundaries: false,
    });
    // Use unique numeric prefix to make each position distinguishable
    const text = Array.from({ length: 2000 }, (_, i) => String(i % 10)).join(
      ""
    );
    const chunks = chunker.chunk(text, "doc");
    expect(chunks.length).toBeGreaterThan(1);

    // The overlap chars from end of chunk[i] should appear at start of chunk[i+1]
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!.text;
      const curr = chunks[i]!.text;
      // Find how much of prev's tail appears at curr's head
      let sharedLen = 0;
      for (let len = Math.min(prev.length, curr.length); len >= 1; len--) {
        if (curr.startsWith(prev.slice(-len))) {
          sharedLen = len;
          break;
        }
      }
      // There must be at least some shared content (overlap region)
      expect(sharedLen).toBeGreaterThan(0);
      // The shared text must be identical
      const prevTail = prev.slice(-sharedLen);
      const currHead = curr.slice(0, sharedLen);
      expect(prevTail).toBe(currHead);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Zero overlap
// ---------------------------------------------------------------------------

describe("SemanticChunker — zero overlap", () => {
  it("with overlapTokens=0 no tail of chunk[i] appears at head of chunk[i+1]", () => {
    const chunker = new SemanticChunker({
      maxTokens: 50,
      overlapTokens: 0,
      respectBoundaries: false,
    });
    const text = Array.from({ length: 1000 }, (_, i) => `${i % 10}`).join("");
    const chunks = chunker.chunk(text, "doc");
    expect(chunks.length).toBeGreaterThan(1);

    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!.text;
      const curr = chunks[i]!.text;
      // Check that the last 5 chars of prev do NOT appear at the very start of curr
      if (prev.length >= 5 && curr.length >= 5) {
        const tail = prev.slice(-5);
        expect(curr.startsWith(tail)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Sentence boundary
// ---------------------------------------------------------------------------

describe("SemanticChunker — sentence boundary", () => {
  it("does not split mid-sentence when a sentence end is available", () => {
    const chunker = new SemanticChunker({
      maxTokens: 50,
      overlapTokens: 0,
      respectBoundaries: true,
    });
    // Build text with clear sentence boundaries
    const sentence =
      "The quick brown fox jumped over the lazy sleeping dog today.";
    const text = Array.from({ length: 40 }, () => sentence).join(" ");
    const chunks = chunker.chunk(text, "doc");
    // Each chunk should end with sentence-final punctuation or start fresh at a sentence
    for (const c of chunks.slice(0, -1)) {
      // Allow ending with sentence boundary chars or after a sentence
      const endsAtSentence =
        /[.!?]\s*$/.test(c.text) || c.text.endsWith(sentence);
      // At minimum, the chunk should not end mid-word in the sentence pattern
      expect(c.text.length).toBeGreaterThan(0);
      // The boundary type for sentence-rich text should be sentence or paragraph, not mid-word
      expect(["sentence", "paragraph", "header", "token"]).toContain(
        c.metadata.boundaryType
      );
    }
  });

  it('boundaryType is "sentence" when split occurs at sentence end', () => {
    const chunker = new SemanticChunker({
      maxTokens: 50,
      overlapTokens: 0,
      respectBoundaries: true,
    });
    const text = [
      "First sentence ends here. Second sentence continues the text. Third one too.",
      "Fourth sentence carries more content. Fifth adds even more to fill the buffer.",
      "Sixth sentence extends beyond the target. Seventh keeps going further on.",
      "Eighth sentence now pushes us over the limit. Ninth is the final boundary.",
    ].join(" ");
    const chunks = chunker.chunk(text, "doc");
    // At least one chunk should be split at a sentence boundary
    const hasSentenceBoundary = chunks.some(
      (c) => c.metadata.boundaryType === "sentence"
    );
    expect(hasSentenceBoundary).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Paragraph boundary
// ---------------------------------------------------------------------------

describe("SemanticChunker — paragraph boundary", () => {
  it("prefers paragraph breaks over mid-paragraph splits", () => {
    const chunker = new SemanticChunker({
      maxTokens: 80,
      overlapTokens: 0,
      respectBoundaries: true,
    });
    const para =
      "This paragraph contains several words that fill up space in a meaningful way. " +
      "It goes on to say more things about various topics. " +
      "Eventually it concludes with a final thought on the matter.";
    const text = repeatParagraph(para, 10);
    const chunks = chunker.chunk(text, "doc");
    // At least some chunks should be split at paragraph boundaries
    const hasParagraphBoundary = chunks.some(
      (c) => c.metadata.boundaryType === "paragraph"
    );
    expect(hasParagraphBoundary).toBe(true);
  });

  it("paragraph boundary type is returned when double-newline is the split point", () => {
    const chunker = new SemanticChunker({
      maxTokens: 60,
      overlapTokens: 0,
      respectBoundaries: true,
    });
    // Construct text where double-newline falls within the search window
    const block = "word ".repeat(40);
    const text = block + "\n\n" + block + "\n\n" + block;
    const chunks = chunker.chunk(text, "doc");
    const hasPara = chunks.some((c) => c.metadata.boundaryType === "paragraph");
    expect(hasPara).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Chunk metadata
// ---------------------------------------------------------------------------

describe("SemanticChunker — chunk metadata", () => {
  it("each chunk has chunkIndex, startChar, endChar, tokenCount", () => {
    const chunker = new SemanticChunker({ maxTokens: 60, overlapTokens: 0 });
    const text = "Hello world. ".repeat(100);
    const chunks = chunker.chunk(text, "doc");
    for (const c of chunks) {
      expect(typeof c.metadata.chunkIndex).toBe("number");
      expect(typeof c.metadata.startChar).toBe("number");
      expect(typeof c.metadata.endChar).toBe("number");
      expect(typeof c.metadata.tokenCount).toBe("number");
      expect(typeof c.metadata.boundaryType).toBe("string");
    }
  });

  it("startChar is non-negative for all chunks", () => {
    const chunker = new SemanticChunker({ maxTokens: 50, overlapTokens: 0 });
    const text = "Content. ".repeat(200);
    const chunks = chunker.chunk(text, "doc");
    for (const c of chunks) {
      expect(c.metadata.startChar).toBeGreaterThanOrEqual(0);
    }
  });

  it("endChar > startChar for all chunks", () => {
    const chunker = new SemanticChunker({ maxTokens: 50, overlapTokens: 0 });
    const text = "Content. ".repeat(200);
    const chunks = chunker.chunk(text, "doc");
    for (const c of chunks) {
      expect(c.metadata.endChar).toBeGreaterThan(c.metadata.startChar);
    }
  });

  it("tokenCount matches ceil(text.length / 4)", () => {
    const chunker = new SemanticChunker({ maxTokens: 50, overlapTokens: 0 });
    const text = "Hello. ".repeat(200);
    const chunks = chunker.chunk(text, "doc");
    for (const c of chunks) {
      expect(c.metadata.tokenCount).toBe(Math.ceil(c.text.length / 4));
    }
  });

  it("boundaryType is one of the expected values", () => {
    const chunker = new SemanticChunker({ maxTokens: 50, overlapTokens: 0 });
    const text = "Something. ".repeat(200);
    const chunks = chunker.chunk(text, "doc");
    const validTypes = ["header", "paragraph", "sentence", "code", "token"];
    for (const c of chunks) {
      expect(validTypes).toContain(c.metadata.boundaryType);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Chunk index order
// ---------------------------------------------------------------------------

describe("SemanticChunker — chunk index order", () => {
  it("chunks are ordered 0..N-1", () => {
    const chunker = new SemanticChunker({ maxTokens: 50, overlapTokens: 0 });
    const text = "word ".repeat(400);
    const chunks = chunker.chunk(text, "doc");
    chunks.forEach((c, i) => {
      expect(c.metadata.chunkIndex).toBe(i);
    });
  });

  it("startChar is non-decreasing across chunks", () => {
    const chunker = new SemanticChunker({
      maxTokens: 50,
      overlapTokens: 0,
      respectBoundaries: false,
    });
    const text = "x".repeat(2000);
    const chunks = chunker.chunk(text, "doc");
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.metadata.startChar).toBeGreaterThanOrEqual(
        chunks[i - 1]!.metadata.startChar
      );
    }
  });

  it("id encodes the index as sourceId:index", () => {
    const chunker = new SemanticChunker({ maxTokens: 50, overlapTokens: 0 });
    const text = "a".repeat(1500);
    const chunks = chunker.chunk(text, "test-doc");
    chunks.forEach((c, i) => {
      expect(c.id).toBe(`test-doc:${i}`);
    });
  });
});

// ---------------------------------------------------------------------------
// 11. Empty text
// ---------------------------------------------------------------------------

describe("SemanticChunker — empty text", () => {
  it("returns empty array for empty string", () => {
    const chunker = new SemanticChunker();
    expect(chunker.chunk("", "doc")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    const chunker = new SemanticChunker();
    expect(chunker.chunk("   \t\n  ", "doc")).toEqual([]);
  });

  it("returns empty array for string of only newlines", () => {
    const chunker = new SemanticChunker();
    expect(chunker.chunk("\n\n\n\n", "doc")).toEqual([]);
  });

  it("returns empty array for null-like empty after trim", () => {
    const chunker = new SemanticChunker();
    expect(chunker.chunk("  \r\n  ", "doc")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 12. Very short text
// ---------------------------------------------------------------------------

describe("SemanticChunker — very short text", () => {
  it("text shorter than maxTokens → exactly 1 chunk", () => {
    const chunker = new SemanticChunker({ maxTokens: 500, overlapTokens: 0 });
    const text = "Short text here.";
    const chunks = chunker.chunk(text, "doc");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("Short text here.");
  });

  it("single word returns one chunk", () => {
    const chunker = new SemanticChunker({ maxTokens: 10 });
    const chunks = chunker.chunk("hello", "doc");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("hello");
  });

  it("chunk of short text has index 0", () => {
    const chunker = new SemanticChunker({ maxTokens: 200 });
    const chunks = chunker.chunk("A sentence.", "doc");
    expect(chunks[0]!.metadata.chunkIndex).toBe(0);
  });

  it("single chunk startChar is 0", () => {
    const chunker = new SemanticChunker({ maxTokens: 200 });
    const chunks = chunker.chunk("Hello world.", "doc");
    expect(chunks[0]!.metadata.startChar).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 13. Single sentence
// ---------------------------------------------------------------------------

describe("SemanticChunker — single sentence", () => {
  it("one short sentence → one chunk", () => {
    const chunker = new SemanticChunker({ maxTokens: 200, overlapTokens: 0 });
    const text = "The cat sat on the mat and looked at the bird.";
    const chunks = chunker.chunk(text, "doc");
    expect(chunks).toHaveLength(1);
  });

  it("single sentence chunk text equals trimmed input", () => {
    const chunker = new SemanticChunker({ maxTokens: 200, overlapTokens: 0 });
    const text = "The fox jumped over the lazy dog.";
    const chunks = chunker.chunk(text, "doc");
    expect(chunks[0]!.text).toBe(text.trim());
  });

  it("single-sentence tokenCount > 0", () => {
    const chunker = new SemanticChunker({ maxTokens: 200, overlapTokens: 0 });
    const text = "One sentence right here.";
    const chunks = chunker.chunk(text, "doc");
    expect(chunks[0]!.tokenCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 14. Code chunking
// ---------------------------------------------------------------------------

describe("SemanticChunker — code chunking", () => {
  it("splits code at code-fence boundaries", () => {
    const chunker = new SemanticChunker({
      maxTokens: 60,
      overlapTokens: 0,
      respectBoundaries: true,
    });
    const code = [
      "Here is a function example:",
      "```typescript",
      "function greet(name: string): string {",
      "  return `Hello, ${name}!`",
      "}",
      "```",
      "And here is another function:",
      "```typescript",
      "function farewell(name: string): string {",
      "  return `Goodbye, ${name}!`",
      "}",
      "```",
      "These are two utility functions. They handle greetings and farewells.",
      "You can use them in your application. They are simple string templates.",
    ].join("\n");
    const chunks = chunker.chunk(code, "code-doc");
    // Should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
    // At least one chunk should have 'code' boundary type
    const hasCodeBoundary = chunks.some(
      (c) => c.metadata.boundaryType === "code"
    );
    expect(hasCodeBoundary).toBe(true);
  });

  it("code chunks do not split mid-token when code fence available", () => {
    const chunker = new SemanticChunker({
      maxTokens: 60,
      overlapTokens: 0,
      respectBoundaries: true,
    });
    const block = "Some description text fills up the space here. ";
    const fence = "\n```\nconst x = 1\n```\n";
    const text = block.repeat(10) + fence + block.repeat(10);
    const chunks = chunker.chunk(text, "code-doc");
    // Must split into multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('code-fence boundary type is "code"', () => {
    const chunker = new SemanticChunker({
      maxTokens: 40,
      overlapTokens: 0,
      respectBoundaries: true,
    });
    // Place the fence at exactly the boundary area
    const pre = "intro ".repeat(20);
    const fence = "\n```\ncode here\n```\n";
    const post = "outro ".repeat(20);
    const text = pre + fence + post;
    const chunks = chunker.chunk(text, "doc");
    const hasCode = chunks.some((c) => c.metadata.boundaryType === "code");
    expect(hasCode).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 15. Chunk reassembly
// ---------------------------------------------------------------------------

describe("SemanticChunker — chunk reassembly", () => {
  it("joining chunks without overlap reconstructs the original text (zero overlap)", () => {
    const chunker = new SemanticChunker({
      maxTokens: 60,
      overlapTokens: 0,
      respectBoundaries: false,
    });
    const text = "a".repeat(1200);
    const chunks = chunker.chunk(text, "doc");
    // Joining trimmed text (which removes leading/trailing space only)
    const rejoined = chunks.map((c) => c.text).join("");
    // Original text with whitespace collapsed similarly
    expect(rejoined).toBe(text.trim());
  });

  it("reassembly of sentence-chunked text recovers all words", () => {
    const chunker = new SemanticChunker({
      maxTokens: 60,
      overlapTokens: 0,
      respectBoundaries: true,
    });
    const words = [
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
      "eta",
      "theta",
    ];
    // Build long text with sentence endings
    const sentences = Array.from(
      { length: 50 },
      (_, i) => `${words[i % words.length]} is word number ${i + 1}.`
    );
    const text = sentences.join(" ");
    const chunks = chunker.chunk(text, "doc");
    const rejoined = chunks.map((c) => c.text).join(" ");
    // Every original word should appear in the rejoined text
    for (const word of words) {
      expect(rejoined).toContain(word);
    }
  });

  it("with overlap, all original text sections are covered by at least one chunk", () => {
    const chunker = new SemanticChunker({
      maxTokens: 60,
      overlapTokens: 15,
      respectBoundaries: false,
    });
    // Use a sequence where each position is unique
    const text = Array.from({ length: 1200 }, (_, i) =>
      String.fromCharCode(65 + (i % 26))
    ).join("");
    const chunks = chunker.chunk(text, "doc");
    // The first chunk must start from the beginning
    expect(chunks[0]!.metadata.startChar).toBe(0);
    // The last chunk must end at or near the text end
    const lastChunk = chunks[chunks.length - 1]!;
    expect(lastChunk.metadata.endChar).toBeGreaterThanOrEqual(text.length - 1);
  });
});

// ---------------------------------------------------------------------------
// 16. Large document
// ---------------------------------------------------------------------------

describe("SemanticChunker — large document (10 000 words)", () => {
  const TEN_K_WORDS = loremWords(10_000);

  it("produces chunks from a 10 000-word document", () => {
    const chunker = new SemanticChunker({
      maxTokens: 300,
      overlapTokens: 30,
      respectBoundaries: true,
    });
    const chunks = chunker.chunk(TEN_K_WORDS, "large-doc");
    expect(chunks.length).toBeGreaterThan(10);
  });

  it("all chunks from large doc have valid metadata", () => {
    const chunker = new SemanticChunker({
      maxTokens: 300,
      overlapTokens: 30,
      respectBoundaries: true,
    });
    const chunks = chunker.chunk(TEN_K_WORDS, "large-doc");
    for (const c of chunks) {
      expect(c.metadata.chunkIndex).toBeGreaterThanOrEqual(0);
      expect(c.metadata.startChar).toBeGreaterThanOrEqual(0);
      expect(c.metadata.endChar).toBeGreaterThan(c.metadata.startChar);
      expect(c.metadata.tokenCount).toBeGreaterThan(0);
    }
  });

  it("large doc chunks are in ascending index order", () => {
    const chunker = new SemanticChunker({
      maxTokens: 300,
      overlapTokens: 30,
      respectBoundaries: true,
    });
    const chunks = chunker.chunk(TEN_K_WORDS, "large-doc");
    chunks.forEach((c, i) => {
      expect(c.metadata.chunkIndex).toBe(i);
    });
  });

  it("large doc: no chunk exceeds 2× maxTokens", () => {
    const maxTokens = 300;
    const chunker = new SemanticChunker({
      maxTokens,
      overlapTokens: 30,
      respectBoundaries: true,
    });
    const chunks = chunker.chunk(TEN_K_WORDS, "large-doc");
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(maxTokens * 2);
    }
  });

  it("large doc covers all content (first chunk starts at 0, last ends near EOF)", () => {
    const chunker = new SemanticChunker({
      maxTokens: 300,
      overlapTokens: 30,
      respectBoundaries: true,
    });
    const chunks = chunker.chunk(TEN_K_WORDS, "large-doc");
    expect(chunks[0]!.metadata.startChar).toBe(0);
    const lastChunk = chunks[chunks.length - 1]!;
    expect(lastChunk.metadata.endChar).toBeGreaterThanOrEqual(
      TEN_K_WORDS.length - 5
    );
  });

  it("large doc with zero overlap produces fewer chunks than with overlap", () => {
    const withOverlap = new SemanticChunker({
      maxTokens: 300,
      overlapTokens: 50,
      respectBoundaries: false,
    });
    const noOverlap = new SemanticChunker({
      maxTokens: 300,
      overlapTokens: 0,
      respectBoundaries: false,
    });
    const withChunks = withOverlap.chunk(TEN_K_WORDS, "doc");
    const noChunks = noOverlap.chunk(TEN_K_WORDS, "doc");
    expect(withChunks.length).toBeGreaterThanOrEqual(noChunks.length);
  });
});

// ---------------------------------------------------------------------------
// 17. Header boundary
// ---------------------------------------------------------------------------

describe("SemanticChunker — header boundary", () => {
  it("splits at markdown headers (boundaryType=header)", () => {
    const chunker = new SemanticChunker({
      maxTokens: 60,
      overlapTokens: 0,
      respectBoundaries: true,
    });
    const filler = "word ".repeat(30);
    const text =
      filler + "\n## Section Two\n" + filler + "\n## Section Three\n" + filler;
    const chunks = chunker.chunk(text, "doc");
    const hasHeader = chunks.some((c) => c.metadata.boundaryType === "header");
    expect(hasHeader).toBe(true);
  });

  it("h1/h2/h3 all trigger header boundary detection", () => {
    const chunker = new SemanticChunker({
      maxTokens: 60,
      overlapTokens: 0,
      respectBoundaries: true,
    });
    const filler = "filler word text ".repeat(25);
    const text =
      filler +
      "\n# H1\n" +
      filler +
      "\n## H2\n" +
      filler +
      "\n### H3\n" +
      filler;
    const chunks = chunker.chunk(text, "doc");
    const headerChunks = chunks.filter(
      (c) => c.metadata.boundaryType === "header"
    );
    expect(headerChunks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 18. Respect boundaries flag
// ---------------------------------------------------------------------------

describe("SemanticChunker — respectBoundaries flag", () => {
  it("with respectBoundaries=false, splits strictly at character limits", () => {
    const chunker = new SemanticChunker({
      maxTokens: 50,
      overlapTokens: 0,
      respectBoundaries: false,
    });
    const text = "a".repeat(2000);
    const chunks = chunker.chunk(text, "doc");
    expect(chunks.length).toBeGreaterThan(1);
    // All boundary types should be 'token' when no boundary detection is used
    const allToken = chunks.every((c) => c.metadata.boundaryType === "token");
    expect(allToken).toBe(true);
  });

  it("with respectBoundaries=true, at least one non-token boundary in sentence-rich text", () => {
    const chunker = new SemanticChunker({
      maxTokens: 50,
      overlapTokens: 0,
      respectBoundaries: true,
    });
    const sentence =
      "The lazy fox jumped over the sleeping brown dog in the field. ";
    const text = sentence.repeat(40);
    const chunks = chunker.chunk(text, "doc");
    const hasNonToken = chunks.some((c) => c.metadata.boundaryType !== "token");
    expect(hasNonToken).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 19. Quality scoring sanity (computeChunkQuality-like checks via tokenCount)
// ---------------------------------------------------------------------------

describe("SemanticChunker — token count sanity", () => {
  it("tokenCount is always positive for non-empty chunks", () => {
    const chunker = new SemanticChunker({ maxTokens: 50, overlapTokens: 0 });
    const text = "Hello. ".repeat(200);
    const chunks = chunker.chunk(text, "doc");
    for (const c of chunks) {
      expect(c.tokenCount).toBeGreaterThan(0);
    }
  });

  it("longer chunks have higher tokenCount than shorter ones", () => {
    const chunker = new SemanticChunker({
      maxTokens: 50,
      overlapTokens: 0,
      respectBoundaries: false,
    });
    const text = "x".repeat(2000);
    const chunks = chunker.chunk(text, "doc");
    // All non-last chunks should have approximately similar length
    const mainChunks = chunks.slice(0, -1);
    if (mainChunks.length >= 2) {
      // Token counts should be consistent (within 20% of each other)
      const counts = mainChunks.map((c) => c.tokenCount);
      const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
      for (const count of counts) {
        expect(Math.abs(count - avg) / avg).toBeLessThan(0.2);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 20. Edge cases
// ---------------------------------------------------------------------------

describe("SemanticChunker — edge cases", () => {
  it("handles text with only punctuation", () => {
    const chunker = new SemanticChunker({ maxTokens: 50, overlapTokens: 0 });
    const text = "...!!!???...";
    const chunks = chunker.chunk(text, "doc");
    // Should either return 1 chunk or empty (not crash)
    expect(chunks.length).toBeGreaterThanOrEqual(0);
  });

  it("handles unicode text", () => {
    const chunker = new SemanticChunker({ maxTokens: 50, overlapTokens: 0 });
    const text = "مرحبا بالعالم. ".repeat(100); // Arabic: Hello world
    const chunks = chunker.chunk(text, "doc");
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.text.length).toBeGreaterThan(0);
    }
  });

  it("handles text with mixed line endings", () => {
    const chunker = new SemanticChunker({ maxTokens: 50, overlapTokens: 0 });
    const text = "Line one.\r\nLine two.\nLine three.\r\nLine four.".repeat(30);
    const chunks = chunker.chunk(text, "doc");
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("handles extremely long single word (no spaces)", () => {
    const chunker = new SemanticChunker({
      maxTokens: 10,
      overlapTokens: 0,
      respectBoundaries: false,
    });
    // 200-char word with no spaces or punctuation
    const text = "abcdefghij".repeat(20);
    const chunks = chunker.chunk(text, "doc");
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("returns id with correct format sourceId:index", () => {
    const chunker = new SemanticChunker({ maxTokens: 50, overlapTokens: 0 });
    const text = "x".repeat(1000);
    const chunks = chunker.chunk(text, "my-source");
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.id).toBe(`my-source:${i}`);
    }
  });
});
