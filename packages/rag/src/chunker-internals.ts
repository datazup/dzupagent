/**
 * Internal helpers, constants, and boundary definitions for {@link SmartChunker}.
 *
 * Extracted from chunker.ts to keep that module under the per-file LOC ceiling
 * (MC-5 / DZUPAGENT-CODE-L-04). These symbols are implementation detail and are
 * NOT part of the @dzupagent/rag public surface — only SmartChunker and
 * DEFAULT_CHUNKING_CONFIG are re-exported from the package barrel.
 */

import { createHash } from "node:crypto";
import type { ChunkMetadata } from "./types.js";

/** Conservative token estimate: 4 chars per token (ceiling). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Deterministic UUID v5-shaped point ID derived from a seed string.
 * Qdrant requires point IDs to be a UUID or an unsigned 64-bit integer —
 * a bare "sourceId:index" string is rejected.
 */
export function uuidFromSeed(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, "0");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Boundary Definitions (priority-ordered)
// ---------------------------------------------------------------------------

export interface BoundaryDef {
  pattern: RegExp;
  name: string;
  type: ChunkMetadata["boundaryType"];
}

export const BOUNDARY_PRIORITIES: BoundaryDef[] = [
  { pattern: /\n#{1,6}\s/, name: "markdown_header", type: "header" },
  { pattern: /\n\n/, name: "double_newline", type: "paragraph" },
  { pattern: /\.\s+(?=[A-Z])/, name: "sentence_capital", type: "sentence" },
  { pattern: /\.\n/, name: "sentence_newline", type: "sentence" },
  { pattern: /[!?]\s/, name: "excl_question", type: "sentence" },
  { pattern: /\n[-*]\s/, name: "list_item", type: "paragraph" },
  { pattern: /\n\d+\.\s/, name: "numbered_list", type: "paragraph" },
  { pattern: /\n```/, name: "code_fence", type: "paragraph" },
];

// ---------------------------------------------------------------------------
// Boilerplate Patterns (for quality scoring)
// ---------------------------------------------------------------------------

export const BOILERPLATE_PATTERNS: RegExp[] = [
  /cookie/i,
  /subscribe/i,
  /newsletter/i,
  /share\s+(this|on)/i,
  /follow\s+us/i,
  /copyright\s*©?/i,
  /all\s+rights\s+reserved/i,
  /terms\s+(?:of\s)?(?:service|use)/i,
  /privacy\s+policy/i,
  /sign\s+(up|in)/i,
  /log\s*(in|out)/i,
  /accept\s+cookies/i,
  /we\s+use\s+cookies/i,
  /navigation/i,
  /breadcrumb/i,
  /skip\s+to\s+(content|main)/i,
  /advertisement/i,
  /sponsored/i,
];

/** Minimum tokens for a standalone chunk; smaller ones get merged */
export const MIN_CHUNK_TOKENS = 50;

export const DEFAULT_MAX_SECTION_LINES = 120;
export const DEFAULT_WINDOW_OVERLAP_LINES = 12;
export const DEFAULT_MAX_CHUNK_CHARS = 7_000;

export interface HeadingSection {
  heading: string | null;
  lines: HeadingSectionLine[];
}

export interface HeadingSectionLine {
  text: string;
  number: number;
}

/** Split markdown into sections at ATX headings (#, ##, ...). */
export function splitByHeadings(content: string): HeadingSection[] {
  const lines = content.split("\n");
  const sections: HeadingSection[] = [];
  let current: HeadingSection = { heading: null, lines: [] };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineNumber = index + 1;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      if (current.lines.length > 0 || current.heading !== null) {
        sections.push(current);
      }
      current = { heading: m[2]!.trim(), lines: [] };
    } else {
      current.lines.push({ text: line, number: lineNumber });
    }
  }
  if (current.lines.length > 0 || current.heading !== null) {
    sections.push(current);
  }
  return sections.length > 0 ? sections : [{ heading: null, lines: [] }];
}
