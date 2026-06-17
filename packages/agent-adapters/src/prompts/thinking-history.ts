/**
 * Thinking-block history hygiene (adapter-DSL study Phase 5.2c / REQ-PREP-3).
 *
 * Some providers (notably Qwen3 in thinking mode) emit a `<think>…</think>`
 * block before the final answer. In multi-turn conversations, historical
 * assistant turns should carry only the FINAL output — the thinking block must
 * be stripped before the turn is replayed as context, otherwise it bloats the
 * history and degrades the model (best-practices §3.4). Claude, by contrast,
 * requires echoing thinking blocks back unchanged on the same model, so this
 * stripping is opt-in per provider/turn — never applied blindly.
 *
 * `stripThinkingBlocks` is a pure utility usable by any history/session layer
 * (e.g. `ConversationCompressor`).
 */

// Matches a `<think>…</think>` block (case-insensitive, multi-line). The lazy
// body and trailing `?` on the close tag also let an UNTERMINATED `<think>` at
// the end of a message be dropped to end-of-string.
const THINK_BLOCK = /<think>[\s\S]*?(?:<\/think>|$)/gi;

/**
 * Remove `<think>…</think>` blocks from an assistant message, returning the
 * cleaned final output. Unterminated blocks are dropped to the end of the
 * string. Surrounding whitespace left by removed blocks is collapsed so the
 * remaining text reads naturally; the result is trimmed.
 *
 * @param text Raw assistant message text.
 * @returns The message with thinking blocks removed.
 */
export function stripThinkingBlocks(text: string): string {
  if (!text.includes("<think") && !text.includes("<THINK")) return text;
  return (
    text
      .replace(THINK_BLOCK, "")
      // Collapse a gap of 3+ newlines (left when a block sat between paragraphs)
      // back to a paragraph break.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
