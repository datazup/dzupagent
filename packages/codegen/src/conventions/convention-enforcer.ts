/**
 * Enforce detected conventions on generated code and build LLM prompt fragments.
 */

import type { DetectedConvention } from './convention-detector.js';

export interface ConventionViolation {
  file: string;
  line: number;
  convention: string;
  expected: string;
  actual: string;
}

export interface EnforcementResult {
  violations: ConventionViolation[];
  score: number; // 0-100, percentage of lines conforming
}

type LineChecker = (line: string, lineNum: number, file: string) => ConventionViolation | undefined;

function buildChecker(convention: DetectedConvention): LineChecker | undefined {
  switch (convention.name) {
    case 'single-quotes':
      return (line, lineNum, file) => {
        // Skip lines that are import/require or contain escaped quotes
        if (/(?<!\\)"(?:[^"\\]|\\.)*(?<!\\)"/.test(line) && !/import\s/.test(line) && !/require\(/.test(line)) {
          return { file, line: lineNum, convention: convention.name, expected: "single quotes (')", actual: 'double quotes (")' };
        }
        return undefined;
      };
    case 'double-quotes':
      return (line, lineNum, file) => {
        if (/(?<!\\)'(?:[^'\\]|\\.)*(?<!\\)'/.test(line) && !/import\s/.test(line) && !/require\(/.test(line)) {
          return { file, line: lineNum, convention: convention.name, expected: 'double quotes (")', actual: "single quotes (')" };
        }
        return undefined;
      };
    case 'semicolons':
      return (line, lineNum, file) => {
        const trimmed = line.trimEnd();
        if (trimmed.length > 0 && /\w/.test(trimmed) && !trimmed.endsWith(';') && !trimmed.endsWith('{') && !trimmed.endsWith(',') && !trimmed.endsWith('(') && !/^\s*\/\//.test(trimmed) && !/^\s*\*/.test(trimmed) && !/^\s*import\s/.test(trimmed)) {
          return { file, line: lineNum, convention: convention.name, expected: 'semicolon at end', actual: 'no semicolon' };
        }
        return undefined;
      };
    case 'no-semicolons':
      return (line, lineNum, file) => {
        const trimmed = line.trimEnd();
        if (trimmed.endsWith(';') && !/^\s*for\s*\(/.test(trimmed)) {
          return { file, line: lineNum, convention: convention.name, expected: 'no semicolon', actual: 'semicolon present' };
        }
        return undefined;
      };
    case 'indent-2spaces':
      return (line, lineNum, file) => {
        if (/^\t/.test(line)) {
          return { file, line: lineNum, convention: convention.name, expected: '2-space indent', actual: 'tab indent' };
        }
        if (/^    \S/.test(line)) {
          return { file, line: lineNum, convention: convention.name, expected: '2-space indent', actual: '4-space indent' };
        }
        return undefined;
      };
    case 'indent-4spaces':
      return (line, lineNum, file) => {
        if (/^\t/.test(line)) {
          return { file, line: lineNum, convention: convention.name, expected: '4-space indent', actual: 'tab indent' };
        }
        return undefined;
      };
    case 'indent-tabs':
      return (line, lineNum, file) => {
        if (/^ {2,}\S/.test(line)) {
          return { file, line: lineNum, convention: convention.name, expected: 'tab indent', actual: 'space indent' };
        }
        return undefined;
      };
    case 'type-imports':
      return (line, lineNum, file) => {
        // Flag import { SomeType } when it should be import type { SomeType }
        if (/^\s*import\s+\{[^}]*\}\s+from/.test(line) && !/import\s+type\s/.test(line)) {
          // Heuristic: names starting with uppercase that look like types
          const names = line.match(/\{\s*([^}]+)\s*\}/)?.[1] ?? '';
          const allUpperStart = names.split(',').every((n) => /^\s*[A-Z]/.test(n.trim()));
          if (allUpperStart && names.trim().length > 0) {
            return { file, line: lineNum, convention: convention.name, expected: 'import type { ... }', actual: 'import { ... } (possible type-only import)' };
          }
        }
        return undefined;
      };
    default:
      return undefined;
  }
}

export function enforceConventions(
  files: Record<string, string>,
  conventions: DetectedConvention[],
): EnforcementResult {
  const checkers: LineChecker[] = [];
  for (const c of conventions) {
    const checker = buildChecker(c);
    if (checker) checkers.push(checker);
  }

  if (checkers.length === 0) {
    return { violations: [], score: 100 };
  }

  const violations: ConventionViolation[] = [];
  let totalLines = 0;

  for (const [filePath, content] of Object.entries(files)) {
    const lines = content.split('\n');
    totalLines += lines.length;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      for (const check of checkers) {
        const violation = check(line, i + 1, filePath);
        if (violation) violations.push(violation);
      }
    }
  }

  const score = totalLines === 0
    ? 100
    : Math.max(0, Math.round((1 - violations.length / totalLines) * 100));

  return { violations, score };
}

export function conventionsToPrompt(conventions: DetectedConvention[]): string {
  if (conventions.length === 0) return '';

  const grouped = new Map<string, DetectedConvention[]>();
  for (const c of conventions) {
    const list = grouped.get(c.category) ?? [];
    list.push(c);
    grouped.set(c.category, list);
  }

  const sections: string[] = ['Follow these coding conventions:'];
  for (const [category, items] of grouped) {
    const strong = items.filter((i) => i.confidence >= 0.5);
    if (strong.length === 0) continue;
    sections.push(`\n${category.toUpperCase()}:`);
    for (const item of strong) {
      const exStr = item.examples.length > 0 ? ` (e.g. ${item.examples.join(', ')})` : '';
      sections.push(`- ${item.description}${exStr}`);
    }
  }

  return sections.length <= 1 ? '' : sections.join('\n');
}
