/**
 * Analyze a codebase to detect coding conventions via regex/heuristics.
 */

export interface DetectedConvention {
  name: string;
  category: 'naming' | 'structure' | 'formatting' | 'imports' | 'patterns';
  description: string;
  examples: string[];
  confidence: number; // 0-1
}

export interface ConventionReport {
  conventions: DetectedConvention[];
  language: string;
  filesAnalyzed: number;
}

function ratio(a: number, b: number): number {
  const total = a + b;
  return total === 0 ? 0.5 : a / total;
}

function detectNaming(lines: string[]): DetectedConvention[] {
  const conventions: DetectedConvention[] = [];
  let camel = 0;
  let snake = 0;
  const pascalExamples: string[] = [];

  for (const line of lines) {
    const vars = line.match(/(?:const|let|var|function)\s+([a-zA-Z_]\w*)/g) ?? [];
    for (const v of vars) {
      const name = v.split(/\s+/).pop() ?? '';
      if (/^[a-z][a-zA-Z0-9]*$/.test(name) && name.length > 1) camel++;
      if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name)) snake++;
    }
    const cls = line.match(/(?:class|interface|type)\s+([A-Z][a-zA-Z0-9]*)/);
    if (cls?.[1] && pascalExamples.length < 3) pascalExamples.push(cls[1]);
  }

  const camelRatio = ratio(camel, snake);
  if (camel + snake > 0) {
    conventions.push({
      name: camelRatio >= 0.7 ? 'camelCase variables' : 'snake_case variables',
      category: 'naming',
      description: camelRatio >= 0.7
        ? 'Variables and functions use camelCase'
        : 'Variables and functions use snake_case',
      examples: [],
      confidence: Math.abs(camelRatio - 0.5) * 2,
    });
  }

  if (pascalExamples.length > 0) {
    conventions.push({
      name: 'PascalCase types',
      category: 'naming',
      description: 'Classes, interfaces, and type aliases use PascalCase',
      examples: pascalExamples,
      confidence: 0.95,
    });
  }

  return conventions;
}

function detectFormatting(lines: string[]): DetectedConvention[] {
  const conventions: DetectedConvention[] = [];
  let tabs = 0;
  let spaces2 = 0;
  let spaces4 = 0;
  let single = 0;
  let double = 0;
  let semi = 0;
  let noSemi = 0;

  for (const line of lines) {
    if (/^\t/.test(line)) tabs++;
    else if (/^  \S/.test(line)) spaces2++;
    else if (/^    \S/.test(line)) spaces4++;

    const quotes = line.match(/(?<!\\)['"][^'"]*(?<!\\)['"]/g) ?? [];
    for (const q of quotes) {
      if (q.startsWith("'")) single++;
      else double++;
    }

    const trimmed = line.trimEnd();
    if (trimmed.length > 0 && /\w/.test(trimmed)) {
      if (trimmed.endsWith(';')) semi++;
      else noSemi++;
    }
  }

  const indentTotal = tabs + spaces2 + spaces4;
  if (indentTotal > 0) {
    const winner = tabs >= spaces2 && tabs >= spaces4 ? 'tabs'
      : spaces2 >= spaces4 ? '2 spaces' : '4 spaces';
    const winnerCount = tabs >= spaces2 && tabs >= spaces4 ? tabs
      : spaces2 >= spaces4 ? spaces2 : spaces4;
    conventions.push({
      name: `indent-${winner.replace(' ', '')}`,
      category: 'formatting',
      description: `Indentation uses ${winner}`,
      examples: [],
      confidence: winnerCount / indentTotal,
    });
  }

  const quoteTotal = single + double;
  if (quoteTotal > 2) {
    const singleRatio = ratio(single, double);
    conventions.push({
      name: singleRatio >= 0.6 ? 'single-quotes' : 'double-quotes',
      category: 'formatting',
      description: singleRatio >= 0.6 ? 'Strings use single quotes' : 'Strings use double quotes',
      examples: [],
      confidence: Math.abs(singleRatio - 0.5) * 2,
    });
  }

  const semiTotal = semi + noSemi;
  if (semiTotal > 2) {
    const semiRatio = ratio(semi, noSemi);
    conventions.push({
      name: semiRatio >= 0.6 ? 'semicolons' : 'no-semicolons',
      category: 'formatting',
      description: semiRatio >= 0.6 ? 'Statements end with semicolons' : 'Statements omit semicolons',
      examples: [],
      confidence: Math.abs(semiRatio - 0.5) * 2,
    });
  }

  return conventions;
}

function detectImports(lines: string[]): DetectedConvention[] {
  const conventions: DetectedConvention[] = [];
  let relative = 0;
  let alias = 0;
  let named = 0;
  let defaultImport = 0;
  let typeImports = 0;
  let valueImports = 0;

  for (const line of lines) {
    if (!/^\s*import\s/.test(line)) continue;

    if (/from\s+['"]\./.test(line)) relative++;
    else if (/from\s+['"][@~]/.test(line)) alias++;

    if (/import\s+type\s/.test(line)) typeImports++;
    else valueImports++;

    if (/import\s+\{/.test(line) || /import\s+type\s+\{/.test(line)) named++;
    if (/import\s+[A-Za-z_]\w*\s+from/.test(line)) defaultImport++;
  }

  const pathTotal = relative + alias;
  if (pathTotal > 2) {
    const relRatio = ratio(relative, alias);
    conventions.push({
      name: relRatio >= 0.7 ? 'relative-imports' : 'alias-imports',
      category: 'imports',
      description: relRatio >= 0.7 ? 'Imports use relative paths' : 'Imports use path aliases (@/~)',
      examples: [],
      confidence: Math.abs(relRatio - 0.5) * 2,
    });
  }

  if (typeImports > 0 && valueImports > 0) {
    conventions.push({
      name: 'type-imports',
      category: 'imports',
      description: 'Separate type imports (import type { ... })',
      examples: [],
      confidence: Math.min(typeImports / (typeImports + valueImports) * 2, 0.95),
    });
  }

  return conventions;
}

function detectPatterns(lines: string[]): DetectedConvention[] {
  const conventions: DetectedConvention[] = [];
  let asyncAwait = 0;
  let thenCatch = 0;
  let classDef = 0;
  let funcDef = 0;
  let namedExport = 0;
  let defaultExport = 0;

  for (const line of lines) {
    if (/\bawait\b/.test(line)) asyncAwait++;
    if (/\.then\s*\(/.test(line)) thenCatch++;
    if (/^\s*(?:export\s+)?class\s/.test(line)) classDef++;
    if (/^\s*(?:export\s+)?(?:async\s+)?function\s/.test(line)) funcDef++;
    if (/^\s*export\s+(?:const|function|class|interface|type|enum|async)\s/.test(line)) namedExport++;
    if (/^\s*export\s+default\s/.test(line)) defaultExport++;
  }

  const asyncTotal = asyncAwait + thenCatch;
  if (asyncTotal > 2) {
    const awaitRatio = ratio(asyncAwait, thenCatch);
    conventions.push({
      name: awaitRatio >= 0.6 ? 'async-await' : 'promise-then',
      category: 'patterns',
      description: awaitRatio >= 0.6 ? 'Prefers async/await over .then()' : 'Uses .then() promise chains',
      examples: [],
      confidence: Math.abs(awaitRatio - 0.5) * 2,
    });
  }

  const stylTotal = classDef + funcDef;
  if (stylTotal > 2) {
    const funcRatio = ratio(funcDef, classDef);
    conventions.push({
      name: funcRatio >= 0.7 ? 'function-style' : 'class-style',
      category: 'patterns',
      description: funcRatio >= 0.7 ? 'Prefers standalone functions over classes' : 'Prefers class-based patterns',
      examples: [],
      confidence: Math.abs(funcRatio - 0.5) * 2,
    });
  }

  const exportTotal = namedExport + defaultExport;
  if (exportTotal > 2) {
    const namedRatio = ratio(namedExport, defaultExport);
    conventions.push({
      name: namedRatio >= 0.7 ? 'named-exports' : 'default-exports',
      category: 'patterns',
      description: namedRatio >= 0.7 ? 'Prefers named exports' : 'Prefers default exports',
      examples: [],
      confidence: Math.abs(namedRatio - 0.5) * 2,
    });
  }

  return conventions;
}

function detectStructure(filePaths: string[]): DetectedConvention[] {
  const conventions: DetectedConvention[] = [];
  const barrels = filePaths.filter((f) => /(?:^|\/)index\.[tj]sx?$/.test(f));

  if (barrels.length > 0 && filePaths.length > 3) {
    conventions.push({
      name: 'barrel-exports',
      category: 'structure',
      description: 'Uses index.ts barrel files for re-exports',
      examples: barrels.slice(0, 3),
      confidence: Math.min(barrels.length / (filePaths.length * 0.2), 0.95),
    });
  }

  const depths = filePaths.map((f) => f.split('/').length);
  const avgDepth = depths.reduce((a, b) => a + b, 0) / Math.max(depths.length, 1);
  if (filePaths.length > 3) {
    conventions.push({
      name: avgDepth <= 3 ? 'flat-structure' : 'nested-structure',
      category: 'structure',
      description: avgDepth <= 3
        ? 'Flat directory structure (avg depth <= 3)'
        : 'Nested directory structure (avg depth > 3)',
      examples: [],
      confidence: Math.min(Math.abs(avgDepth - 3) * 0.3, 0.9),
    });
  }

  return conventions;
}

function detectLanguage(filePaths: string[]): string {
  let ts = 0;
  let js = 0;
  for (const f of filePaths) {
    if (/\.tsx?$/.test(f)) ts++;
    if (/\.jsx?$/.test(f)) js++;
  }
  return ts >= js ? 'typescript' : 'javascript';
}

export function detectConventions(
  files: Record<string, string>,
): ConventionReport {
  const paths = Object.keys(files);
  const allLines = Object.values(files).flatMap((content) => content.split('\n'));

  const conventions: DetectedConvention[] = [
    ...detectNaming(allLines),
    ...detectFormatting(allLines),
    ...detectImports(allLines),
    ...detectPatterns(allLines),
    ...detectStructure(paths),
  ];

  return {
    conventions: conventions.filter((c) => c.confidence >= 0.1),
    language: detectLanguage(paths),
    filesAnalyzed: paths.length,
  };
}
