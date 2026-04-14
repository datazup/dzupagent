import type { EvalInput } from '../../types.js';
import { clamp01, combinedText, countPatterns } from './helpers.js';

export function sqlCorrectnessDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const issues: string[] = [];
  let score = 1.0;

  // Check for basic SQL structure
  const hasSelect = /\bSELECT\b/i.test(output);
  const hasFrom = /\bFROM\b/i.test(output);
  const hasMutationKeyword = /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(output);

  if (!hasSelect && !hasMutationKeyword) {
    issues.push('No SQL statement keyword found (SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER)');
    score -= 0.4;
  }

  if (hasSelect && !hasFrom) {
    issues.push('SELECT without FROM clause');
    score -= 0.2;
  }

  // Balanced parentheses
  const openParens = (output.match(/\(/g) ?? []).length;
  const closeParens = (output.match(/\)/g) ?? []).length;
  if (openParens !== closeParens) {
    issues.push(`Unbalanced parentheses: ${openParens} open vs ${closeParens} close`);
    score -= 0.3;
  }

  // Trailing comma before FROM/WHERE
  if (/,\s*(FROM|WHERE)\b/i.test(output)) {
    issues.push('Trailing comma before FROM or WHERE');
    score -= 0.2;
  }

  return {
    score: clamp01(score),
    reasoning: issues.length > 0 ? `Issues: ${issues.join('; ')}` : 'SQL syntax checks passed',
  };
}

export function sqlEfficiencyDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const issues: string[] = [];
  let score = 1.0;

  if (/\bSELECT\s+\*/i.test(output)) {
    issues.push('SELECT * used instead of explicit columns');
    score -= 0.25;
  }

  if (/\bDISTINCT\b/i.test(output) && !/--.*distinct/i.test(output)) {
    issues.push('DISTINCT used without documented justification');
    score -= 0.15;
  }

  // Subquery where JOIN might work: detect SELECT in FROM/WHERE subquery
  if (/\bWHERE\b.*\(\s*SELECT\b/i.test(output) || /\bFROM\s*\(\s*SELECT\b/i.test(output)) {
    issues.push('Subquery detected where JOIN might be more efficient');
    score -= 0.2;
  }

  // Missing LIMIT on unbounded query
  if (/\bSELECT\b/i.test(output) && !/\bLIMIT\b/i.test(output) && !/\bTOP\b/i.test(output) && !/\bWHERE\b/i.test(output)) {
    issues.push('Unbounded SELECT without LIMIT or WHERE clause');
    score -= 0.2;
  }

  return {
    score: clamp01(score),
    reasoning: issues.length > 0 ? `Efficiency issues: ${issues.join('; ')}` : 'No efficiency issues detected',
  };
}

export function sqlInjectionSafetyDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const issues: string[] = [];
  let score = 1.0;

  // String concatenation patterns indicating unsafe interpolation
  const concatPatterns = [
    /['"]?\s*\+\s*\w+\s*\+\s*['"]?/,        // "SELECT " + var + " FROM"
    /\$\{[^}]+\}/,                             // ${variable} template literal
    /f['"].*\{[^}]+\}.*['"]/,                 // f-string pattern
    /['"]?\s*\.\s*format\s*\(/,               // .format() calls
    /% *s/,                                     // %s formatting
  ];

  const unsafeCount = countPatterns(output, concatPatterns);
  if (unsafeCount > 0) {
    issues.push(`Found ${unsafeCount} string interpolation/concatenation pattern(s)`);
    score -= 0.4;
  }

  // Check for parameterized query indicators
  const paramPatterns = [
    /\?\s*[,)]/,             // ? placeholders
    /\$\d+/,                 // $1, $2 placeholders
    /:[\w]+/,                // :named placeholders
    /@[\w]+/,                // @named placeholders
  ];

  const hasParams = countPatterns(output, paramPatterns) > 0;
  // Only flag if there is user-input-related context and no parameterization
  const mentionsUserInput = /\b(user[_ ]?input|request\.(body|query|params)|req\.(body|query|params))\b/i.test(
    combinedText(input),
  );
  if (mentionsUserInput && !hasParams && unsafeCount === 0) {
    issues.push('User input referenced but no parameterized query patterns detected');
    score -= 0.3;
  }

  return {
    score: clamp01(score),
    reasoning: issues.length > 0
      ? `Injection safety issues: ${issues.join('; ')}`
      : 'No injection safety issues detected',
  };
}

export function sqlReadabilityDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const issues: string[] = [];
  let score = 1.0;

  // Check keyword casing (should be uppercase)
  const keywords = ['select', 'from', 'where', 'join', 'inner', 'left', 'right', 'outer',
    'group', 'order', 'having', 'limit', 'insert', 'update', 'delete', 'create', 'alter', 'drop'];
  const foundLowerKeywords = keywords.filter((kw) => {
    const regex = new RegExp(`\\b${kw}\\b`);
    const regexUpper = new RegExp(`\\b${kw.toUpperCase()}\\b`);
    return regex.test(output) && !regexUpper.test(output);
  });

  if (foundLowerKeywords.length > 0) {
    issues.push(`Lowercase SQL keywords found: ${foundLowerKeywords.join(', ')}`);
    score -= 0.1 * Math.min(foundLowerKeywords.length, 3);
  }

  // Check for line breaks (multi-line is more readable for non-trivial queries)
  const hasClauses = /\b(FROM|WHERE|JOIN|GROUP|ORDER|HAVING)\b/i.test(output);
  const hasLineBreaks = /\n/.test(output.trim());
  if (hasClauses && !hasLineBreaks && output.length > 80) {
    issues.push('Complex query on a single line without line breaks');
    score -= 0.2;
  }

  return {
    score: clamp01(score),
    reasoning: issues.length > 0
      ? `Readability issues: ${issues.join('; ')}`
      : 'SQL readability checks passed',
  };
}

export function codeTypeCorrectnessDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const issues: string[] = [];
  let score = 1.0;

  // Count `any` type annotations (excluding comments)
  const lines = output.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  const anyCount = lines.filter((l) => /:\s*any\b/.test(l) || /as\s+any\b/.test(l) || /<any>/.test(l)).length;
  if (anyCount > 0) {
    issues.push(`Found ${anyCount} usage(s) of 'any' type`);
    score -= 0.15 * Math.min(anyCount, 4);
  }

  // TypeScript suppression directives (ts-ignore, ts-expect-error)
  const tsIgnoreCount = (output.match(/@ts-ignore/g) ?? []).length;
  if (tsIgnoreCount > 0) {
    issues.push(`Found ${tsIgnoreCount} @ts-ignore directive(s)`);
    score -= 0.15 * Math.min(tsIgnoreCount, 3);
  }

  // ts-expect-error is slightly better than ts-ignore but still a concern
  const tsExpectCount = (output.match(/@ts-expect-error/g) ?? []).length;
  if (tsExpectCount > 0) {
    issues.push(`Found ${tsExpectCount} @ts-expect-error directive(s)`);
    score -= 0.05 * Math.min(tsExpectCount, 3);
  }

  return {
    score: clamp01(score),
    reasoning: issues.length > 0
      ? `Type safety issues: ${issues.join('; ')}`
      : 'No type safety issues detected',
  };
}

export function codeTestCoverageDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const text = combinedText(input);
  const testPatterns = [
    /\bdescribe\s*\(/,
    /\bit\s*\(/,
    /\btest\s*\(/,
    /\bexpect\s*\(/,
    /\bassert\b/,
    /\bbeforeEach\s*\(/,
    /\bafterEach\s*\(/,
  ];

  const foundCount = countPatterns(text, testPatterns);

  if (foundCount === 0) {
    return { score: 0.0, reasoning: 'No test patterns found (describe, it, test, expect, assert)' };
  }

  const score = clamp01(foundCount / 4); // 4+ patterns = full score
  return {
    score,
    reasoning: `Found ${foundCount} test pattern(s): ${score >= 0.75 ? 'good coverage indicators' : 'some test patterns present'}`,
  };
}

export function codeSecurityDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const issues: string[] = [];
  let score = 1.0;

  // Hardcoded secrets
  const secretPatterns = [
    /(?:password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    /(?:AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/,  // AWS keys
  ];
  if (countPatterns(output, secretPatterns) > 0) {
    issues.push('Possible hardcoded secret detected');
    score -= 0.4;
  }

  // eval()
  if (/\beval\s*\(/.test(output)) {
    issues.push('eval() usage detected');
    score -= 0.3;
  }

  // innerHTML
  if (/\.innerHTML\s*=/.test(output)) {
    issues.push('innerHTML assignment detected (XSS risk)');
    score -= 0.2;
  }

  // dangerouslySetInnerHTML
  if (/dangerouslySetInnerHTML/.test(output)) {
    issues.push('dangerouslySetInnerHTML usage detected');
    score -= 0.15;
  }

  return {
    score: clamp01(score),
    reasoning: issues.length > 0
      ? `Security issues: ${issues.join('; ')}`
      : 'No security issues detected',
  };
}

export function codeErrorHandlingDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const indicators: string[] = [];
  let score = 0.5; // Start neutral

  // Presence of try/catch
  const tryCatchCount = (output.match(/\btry\s*\{/g) ?? []).length;
  if (tryCatchCount > 0) {
    indicators.push(`${tryCatchCount} try/catch block(s) found`);
    score += 0.2;
  }

  // Empty catch blocks (bad)
  if (/catch\s*\([^)]*\)\s*\{\s*\}/g.test(output)) {
    indicators.push('Empty catch block detected (swallowed error)');
    score -= 0.3;
  }

  // Typed errors
  if (/\binstanceof\s+\w*Error\b/.test(output) || /\bextends\s+Error\b/.test(output)) {
    indicators.push('Typed error handling detected');
    score += 0.15;
  }

  // .catch on promises
  if (/\.catch\s*\(/.test(output)) {
    indicators.push('Promise .catch() handling detected');
    score += 0.1;
  }

  return {
    score: clamp01(score),
    reasoning: indicators.length > 0
      ? `Error handling: ${indicators.join('; ')}`
      : 'No specific error handling patterns detected',
  };
}

export function analysisCitationDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const indicators: string[] = [];
  let score = 0.0;

  // Reference patterns
  const refPatterns = [
    /\[[\d,\s-]+\]/,                  // [1], [1,2], [1-3]
    /\(\w+[^)]{0,30}\d{4}\)/,                // (Author, 2024) / (Author et al., 2024)
    /\bsource\s*:/i,                  // Source:
    /\breference\s*:/i,               // Reference:
    /\bcf\.\s/i,                      // cf.
    /\bsee\s/i,                       // see ...
    /https?:\/\/\S+/,                 // URLs
    /\baccording\s+to\b/i,            // according to
    /\bdata\s+shows?\b/i,             // data shows
    /\bfigure\s+\d/i,                 // Figure 1
    /\btable\s+\d/i,                 // Table 1
  ];

  const found = countPatterns(output, refPatterns);
  if (found > 0) {
    score = clamp01(found / 3); // 3+ reference indicators = full score
    indicators.push(`Found ${found} citation/reference pattern(s)`);
  } else {
    indicators.push('No citation or reference patterns found');
  }

  return {
    score,
    reasoning: indicators.join('; '),
  };
}

export function opsIdempotencyDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const text = combinedText(input);
  const patterns = [
    /\bIF\s+NOT\s+EXISTS\b/i,
    /\bCREATE\s+OR\s+REPLACE\b/i,
    /\bupsert\b/i,
    /\bON\s+CONFLICT\b/i,
    /\bINSERT\s+.*\bOR\s+IGNORE\b/i,
    /\bmerge\b/i,
    /\bidempoten/i,
    /\b--create-namespace\b/i,
    /\bapply\b/i,   // kubectl apply is idempotent
  ];

  const found = countPatterns(text, patterns);
  const score = clamp01(found / 2);
  return {
    score,
    reasoning: found > 0
      ? `Found ${found} idempotency pattern(s)`
      : 'No idempotency patterns detected',
  };
}

export function opsRollbackSafetyDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const text = combinedText(input);
  const patterns = [
    /\bBEGIN\b.*\b(COMMIT|ROLLBACK)\b/is,
    /\btransaction\b/i,
    /\brollback\b/i,
    /\bbackup\b/i,
    /\brevert\b/i,
    /\bundo\b/i,
    /\bmigration.*down\b/i,
    /\bdown\s*\(\s*\)/i,           // down() migration method
    /\bsnapshot\b/i,
  ];

  const found = countPatterns(text, patterns);
  const score = clamp01(found / 2);
  return {
    score,
    reasoning: found > 0
      ? `Found ${found} rollback/safety pattern(s)`
      : 'No rollback safety patterns detected',
  };
}

export function opsPermissionScopeDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const text = combinedText(input);
  const issues: string[] = [];
  let score = 1.0;

  if (/\bsudo\b/.test(text) && !/\bjustif/i.test(text) && !/\breason/i.test(text)) {
    issues.push('sudo used without documented justification');
    score -= 0.3;
  }

  if (/\bchmod\s+777\b/.test(text)) {
    issues.push('chmod 777 detected (overly permissive)');
    score -= 0.3;
  }

  if (/["']?\*["']?\s*$|:\s*["']\*["']/m.test(text) && /\b(iam|policy|role|permission)\b/i.test(text)) {
    issues.push('Wildcard (*) IAM/permission pattern detected');
    score -= 0.3;
  }

  if (/\broot\b/i.test(text) && /\b(container|docker|pod)\b/i.test(text) && !/\bnon-root\b/i.test(text)) {
    issues.push('Running as root in container context');
    score -= 0.2;
  }

  return {
    score: clamp01(score),
    reasoning: issues.length > 0
      ? `Permission issues: ${issues.join('; ')}`
      : 'No permission scope issues detected',
  };
}

export function opsMonitoringDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const text = combinedText(input);
  const patterns = [
    /\blog(ger|ging)?\b/i,
    /\bconsole\.(log|warn|error|info)\b/,
    /\bhealth[_-]?check\b/i,
    /\b\/health\b/i,
    /\balert(s|ing)?\b/i,
    /\bmetric(s)?\b/i,
    /\bmonitor(ing)?\b/i,
    /\bprometheus\b/i,
    /\bgrafana\b/i,
    /\bdatadog\b/i,
    /\bsentry\b/i,
    /\btracing?\b/i,
    /\bopentelemetry\b/i,
  ];

  const found = countPatterns(text, patterns);
  const score = clamp01(found / 3);
  return {
    score,
    reasoning: found > 0
      ? `Found ${found} monitoring/observability pattern(s)`
      : 'No monitoring or observability patterns detected',
  };
}
