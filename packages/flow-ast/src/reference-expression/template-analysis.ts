import { createReferenceDiagnostic } from "./internal.js";
import { parseFlowReferenceExpression } from "./parser.js";
import type {
  FlowReferenceAnalysisOptions,
  FlowReferenceDiagnostic,
  FlowTemplateForm,
  FlowTemplateReferenceAnalysis,
  ParsedFlowReference,
} from "./types.js";

export function analyzeFlowTemplateReferences(
  source: string,
  options: FlowReferenceAnalysisOptions = {},
): FlowTemplateReferenceAnalysis {
  const policy = options.policy ?? "compat-v1";
  const useSite = options.useSite ?? "value-interpolation";
  const references: ParsedFlowReference[] = [];
  const diagnostics: FlowReferenceDiagnostic[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf("{{", cursor);
    const strayClose = source.indexOf("}}", cursor);
    if (strayClose >= 0 && (open < 0 || strayClose < open)) {
      diagnostics.push(
        createReferenceDiagnostic(
          "MALFORMED_REFERENCE",
          policy,
          useSite,
          "template expression has a closing delimiter without an opening delimiter",
          strayClose,
          strayClose + 2,
          options.sourcePath,
        ),
      );
      cursor = strayClose + 2;
      continue;
    }
    if (open < 0) break;
    const close = source.indexOf("}}", open + 2);
    if (close < 0) {
      diagnostics.push(
        createReferenceDiagnostic(
          "UNTERMINATED_TEMPLATE",
          policy,
          useSite,
          "template expression is missing a closing delimiter",
          open,
          source.length,
          options.sourcePath,
        ),
      );
      break;
    }

    const parsed = parseFlowReferenceExpression(
      source.slice(open, close + 2),
      { ...options, policy, useSite },
    );
    if (parsed.reference !== undefined) {
      references.push(shiftReference(parsed.reference, open));
    }
    diagnostics.push(
      ...parsed.diagnostics.map((diagnostic) =>
        shiftDiagnostic(diagnostic, open),
      ),
    );
    spans.push({ start: open, end: close + 2 });
    cursor = close + 2;
  }

  const trimmedStart = source.length - source.trimStart().length;
  const trimmedEnd = source.trimEnd().length;
  const whole =
    spans.length === 1 &&
    spans[0]?.start === trimmedStart &&
    spans[0]?.end === trimmedEnd;
  const form: FlowTemplateForm =
    spans.length === 0 ? "literal" : whole ? "whole-value" : "interpolation";

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    form,
    references,
    diagnostics,
  };
}

function shiftReference(
  reference: ParsedFlowReference,
  offset: number,
): ParsedFlowReference {
  return {
    ...reference,
    start: reference.start + offset,
    end: reference.end + offset,
    segments: reference.segments.map((segment) => ({
      ...segment,
      start: segment.start + offset,
      end: segment.end + offset,
    })),
    filters: reference.filters.map((filter) => ({
      ...filter,
      start: filter.start + offset,
      end: filter.end + offset,
    })),
  };
}

function shiftDiagnostic(
  diagnostic: FlowReferenceDiagnostic,
  offset: number,
): FlowReferenceDiagnostic {
  return {
    ...diagnostic,
    start: diagnostic.start + offset,
    end: diagnostic.end + offset,
  };
}
