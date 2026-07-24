import type {
  FlowReferenceBindings,
  ParsedFlowReference,
} from "@dzupagent/flow-ast/expressions";

import type { SemanticRelativeQuickFix } from "./semantic-diagnostic.js";

/** Emit only exact legacy-root repairs backed by an existing canonical name. */
export function canonicalReferenceRootFixes(
  diagnostic: Readonly<{
    code: string;
    start: number;
    end: number;
  }>,
  references: readonly ParsedFlowReference[],
  bindings: FlowReferenceBindings | undefined,
): readonly SemanticRelativeQuickFix[] | undefined {
  if (diagnostic.code !== "DISALLOWED_REFERENCE_ROOT") return undefined;
  const reference = references.find(
    (candidate) =>
      candidate.start <= diagnostic.start && candidate.end >= diagnostic.end,
  );
  if (reference === undefined) return undefined;
  const canonicalRoot =
    reference.root === "input"
      ? "inputs"
      : reference.root === "ctx"
        ? "context"
        : undefined;
  if (canonicalRoot === undefined) return undefined;
  const first = reference.segments[0];
  if (
    first?.kind !== "property" ||
    bindings?.[canonicalRoot]?.includes(first.key) !== true
  ) {
    return undefined;
  }
  return Object.freeze([
    Object.freeze({
      id: "canonical-reference-root",
      title: `Replace ${reference.root} with ${canonicalRoot}`,
      start: diagnostic.start,
      end: diagnostic.end,
      expectedText: reference.root,
      newText: canonicalRoot,
    }),
  ]);
}
