# 06 — Code Generation Excellence

> **Gaps addressed**: G-06 (git tools), G-07 (multi-format edits), G-09 (repo map/AST), G-25 (sandbox tiers), G-34 (multi-file coherence)

---

## 1. Git Integration (G-06)

### Problem
Every successful coding agent includes git awareness. DzipAgent's `CheckpointManager` uses shadow git repos internally, but there are no user-facing git tools.

### 1.1 Git Tools (LangChain Tools)

```typescript
// codegen/src/git/git-tools.ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function createGitStatusTool(workDir: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'git_status',
    description: 'Show git working tree status (staged, modified, untracked files)',
    schema: z.object({}),
    func: async () => {
      const { stdout } = await exec('git', ['status', '--porcelain=v2'], { cwd: workDir });
      return stdout || '(clean working tree)';
    },
  });
}

export function createGitDiffTool(workDir: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'git_diff',
    description: 'Show git diff. Use staged=true for staged changes, or provide a ref to diff against.',
    schema: z.object({
      staged: z.boolean().optional().describe('Show staged changes only'),
      ref: z.string().optional().describe('Git ref to diff against (e.g., HEAD~1, main)'),
      path: z.string().optional().describe('Limit diff to specific file path'),
    }),
    func: async ({ staged, ref, path }) => {
      const args = ['diff'];
      if (staged) args.push('--cached');
      if (ref) args.push(ref);
      if (path) args.push('--', path);
      const { stdout } = await exec('git', args, { cwd: workDir });
      return stdout || '(no changes)';
    },
  });
}

export function createGitCommitTool(workDir: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'git_commit',
    description: 'Stage and commit changes. If no message provided, auto-generates one.',
    schema: z.object({
      message: z.string().optional().describe('Commit message (auto-generated if omitted)'),
      paths: z.array(z.string()).optional().describe('Specific paths to stage (default: all)'),
    }),
    func: async ({ message, paths }) => {
      // Stage
      const stagePaths = paths ?? ['.'];
      await exec('git', ['add', ...stagePaths], { cwd: workDir });

      // Auto-generate message if not provided
      const commitMsg = message ?? await generateCommitMessage(workDir);

      await exec('git', ['commit', '-m', commitMsg], { cwd: workDir });
      return `Committed: ${commitMsg}`;
    },
  });
}

export function createGitBranchTool(workDir: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'git_branch',
    description: 'Create, switch, or list git branches',
    schema: z.object({
      action: z.enum(['create', 'switch', 'list']),
      name: z.string().optional().describe('Branch name (for create/switch)'),
    }),
    func: async ({ action, name }) => {
      switch (action) {
        case 'list': {
          const { stdout } = await exec('git', ['branch', '-a'], { cwd: workDir });
          return stdout;
        }
        case 'create':
          await exec('git', ['checkout', '-b', name!], { cwd: workDir });
          return `Created and switched to branch: ${name}`;
        case 'switch':
          await exec('git', ['checkout', name!], { cwd: workDir });
          return `Switched to branch: ${name}`;
      }
    },
  });
}
```

### 1.2 Git Middleware

```typescript
// codegen/src/git/git-middleware.ts
/**
 * Middleware that injects git context (current branch, recent commits, dirty files)
 * into the agent's system prompt or messages.
 */
export class GitContextMiddleware implements AgentMiddleware {
  constructor(private workDir: string) {}

  async beforeAgent(state: AgentState): Promise<AgentState> {
    const [branch, status, recentCommits] = await Promise.all([
      this.getCurrentBranch(),
      this.getShortStatus(),
      this.getRecentCommits(5),
    ]);

    const gitContext = [
      `## Git Context`,
      `Branch: ${branch}`,
      status ? `Modified files:\n${status}` : 'Working tree clean',
      `Recent commits:\n${recentCommits}`,
    ].join('\n');

    // Inject as system reminder
    return {
      ...state,
      messages: [
        ...state.messages,
        new SystemMessage(gitContext),
      ],
    };
  }
}
```

### 1.3 LLM-Generated Commit Messages

```typescript
// codegen/src/git/commit-message.ts
export async function generateCommitMessage(
  workDir: string,
  model?: BaseChatModel  // default: cheapest 'chat' tier model
): Promise<string> {
  const { stdout: diff } = await exec('git', ['diff', '--cached', '--stat'], { cwd: workDir });

  const response = await model.invoke([
    new SystemMessage(
      'Generate a concise conventional commit message for these changes. ' +
      'Use format: type(scope): description. Keep under 72 chars.'
    ),
    new HumanMessage(`Staged changes:\n${diff}`),
  ]);

  return response.content.toString().trim();
}
```

### 1.4 Git Worktree Isolation

```typescript
// codegen/src/git/git-worktree.ts
/**
 * Create isolated git worktrees for parallel agent execution.
 * Each worktree gets its own branch and working directory.
 */
export class GitWorktreeManager {
  async create(baseDir: string, branchName: string): Promise<WorktreeInfo> {
    const worktreeDir = join(baseDir, '.forge-worktrees', branchName);
    await exec('git', ['worktree', 'add', worktreeDir, '-b', branchName], { cwd: baseDir });
    return { dir: worktreeDir, branch: branchName };
  }

  async remove(worktreeDir: string): Promise<void> {
    await exec('git', ['worktree', 'remove', worktreeDir, '--force']);
  }

  async merge(worktreeDir: string, targetBranch: string): Promise<MergeResult> {
    const { stdout: branch } = await exec('git', ['branch', '--show-current'], { cwd: worktreeDir });
    await exec('git', ['checkout', targetBranch]);
    const { stdout, stderr } = await exec('git', ['merge', branch.trim()]);
    return { success: !stderr.includes('CONFLICT'), output: stdout + stderr };
  }
}
```

---

## 2. Multi-Format Edit System (G-07)

### Problem
Current `edit-file.tool.ts` uses `String.replace()` — a single find/replace. Research shows Aider supports 5 edit formats; Claude Code has `MultiEdit`.

### 2.1 Enhanced Edit Tool

```typescript
// codegen/src/tools/edit-file.tool.ts — REWRITE

export function createEditFileTool(vfs: VirtualFS): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'edit_file',
    description: 'Edit a file using search/replace blocks. Supports multiple edits per call.',
    schema: z.object({
      filePath: z.string(),
      edits: z.array(z.object({
        search: z.string().describe('Exact text to find (must match precisely)'),
        replace: z.string().describe('Text to replace with'),
      })).min(1),
    }),
    func: async ({ filePath, edits }) => {
      let content = vfs.readFile(filePath);
      if (content === undefined) return `Error: File not found: ${filePath}`;

      const failures: string[] = [];
      for (const edit of edits) {
        if (!content.includes(edit.search)) {
          failures.push(`Search text not found: "${edit.search.slice(0, 50)}..."`);
          continue;
        }
        content = content.replace(edit.search, edit.replace);
      }

      if (failures.length > 0 && failures.length === edits.length) {
        return `All edits failed:\n${failures.join('\n')}`;
      }

      // Lint validation before applying
      const lintResult = await validateEdit(filePath, content);
      if (lintResult.newErrors.length > 0) {
        return `Edit rejected — would introduce ${lintResult.newErrors.length} new errors:\n` +
          lintResult.newErrors.map(e => `  ${e.line}: ${e.message}`).join('\n');
      }

      vfs.writeFile(filePath, content);

      const applied = edits.length - failures.length;
      return failures.length > 0
        ? `Applied ${applied}/${edits.length} edits. Failures:\n${failures.join('\n')}`
        : `Applied ${applied} edits to ${filePath}`;
    },
  });
}
```

### 2.2 Multi-Edit Tool (Multiple Files)

```typescript
// codegen/src/tools/multi-edit.tool.ts — NEW
export function createMultiEditTool(vfs: VirtualFS): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'multi_edit',
    description: 'Apply edits to multiple files atomically. All edits succeed or none apply.',
    schema: z.object({
      fileEdits: z.array(z.object({
        filePath: z.string(),
        edits: z.array(z.object({
          search: z.string(),
          replace: z.string(),
        })),
      })),
    }),
    func: async ({ fileEdits }) => {
      // Phase 1: Validate all edits
      const snapshots = new Map<string, string>();
      const results: string[] = [];

      for (const { filePath, edits } of fileEdits) {
        const content = vfs.readFile(filePath);
        if (!content) { results.push(`Skip: ${filePath} not found`); continue; }
        snapshots.set(filePath, content);

        let modified = content;
        for (const edit of edits) {
          if (!modified.includes(edit.search)) {
            results.push(`Skip: search text not found in ${filePath}`);
            continue;
          }
          modified = modified.replace(edit.search, edit.replace);
        }
        snapshots.set(`${filePath}__new`, modified);
      }

      // Phase 2: Apply atomically
      for (const { filePath } of fileEdits) {
        const newContent = snapshots.get(`${filePath}__new`);
        if (newContent) vfs.writeFile(filePath, newContent);
      }

      return results.length > 0 ? results.join('\n') : `Applied edits to ${fileEdits.length} files`;
    },
  });
}
```

### 2.3 Lint Validator

```typescript
// codegen/src/tools/lint-validator.ts — NEW
export async function validateEdit(
  filePath: string,
  newContent: string,
  sandbox?: SandboxProtocol
): Promise<{ newErrors: LintError[]; fixedErrors: LintError[] }> {
  if (!sandbox) return { newErrors: [], fixedErrors: [] };

  // Write to sandbox and run linter
  const result = await sandbox.execute({
    command: `echo '${escapeShell(newContent)}' > ${filePath} && npx eslint ${filePath} --format json 2>/dev/null || true`,
    timeout: 10_000,
  });

  try {
    const errors = JSON.parse(result.stdout);
    return {
      newErrors: errors.filter((e: LintError) => e.severity >= 2),
      fixedErrors: [],
    };
  } catch {
    return { newErrors: [], fixedErrors: [] };
  }
}
```

---

## 3. Repository Map via AST (G-09)

### Problem
Current `extractInterfaceSummary()` uses regex. No structural understanding of the codebase, no cross-file relationships, no ranking by importance.

### 3.1 Symbol Extractor

```typescript
// codegen/src/repo-map/symbol-extractor.ts
import { Project, SourceFile, SyntaxKind } from 'ts-morph';

export interface Symbol {
  name: string;
  kind: 'class' | 'interface' | 'function' | 'type' | 'enum' | 'const' | 'variable';
  filePath: string;
  line: number;
  exported: boolean;
  signature?: string;  // e.g., "(input: string) => Promise<Result>"
}

export function extractSymbols(project: Project): Symbol[] {
  const symbols: Symbol[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();

    // Classes
    for (const cls of sourceFile.getClasses()) {
      symbols.push({
        name: cls.getName() ?? '<anonymous>',
        kind: 'class',
        filePath,
        line: cls.getStartLineNumber(),
        exported: cls.isExported(),
        signature: cls.getMethods().map(m => m.getName()).join(', '),
      });
    }

    // Interfaces
    for (const iface of sourceFile.getInterfaces()) {
      symbols.push({
        name: iface.getName(),
        kind: 'interface',
        filePath,
        line: iface.getStartLineNumber(),
        exported: iface.isExported(),
      });
    }

    // Functions
    for (const fn of sourceFile.getFunctions()) {
      symbols.push({
        name: fn.getName() ?? '<anonymous>',
        kind: 'function',
        filePath,
        line: fn.getStartLineNumber(),
        exported: fn.isExported(),
        signature: fn.getSignature()?.getDeclaration()?.getText(),
      });
    }

    // Type aliases
    for (const ta of sourceFile.getTypeAliases()) {
      symbols.push({
        name: ta.getName(),
        kind: 'type',
        filePath,
        line: ta.getStartLineNumber(),
        exported: ta.isExported(),
      });
    }
  }

  return symbols;
}
```

### 3.2 Import Graph

```typescript
// codegen/src/repo-map/import-graph.ts
export interface ImportEdge {
  from: string;   // importing file
  to: string;     // imported file
  symbols: string[]; // imported symbols
}

export function buildImportGraph(project: Project): ImportEdge[] {
  const edges: ImportEdge[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    for (const decl of sourceFile.getImportDeclarations()) {
      const moduleSpecifier = decl.getModuleSpecifierValue();
      const resolvedFile = decl.getModuleSpecifierSourceFile();
      if (!resolvedFile) continue;

      const importedSymbols = decl.getNamedImports().map(n => n.getName());
      edges.push({
        from: sourceFile.getFilePath(),
        to: resolvedFile.getFilePath(),
        symbols: importedSymbols,
      });
    }
  }

  return edges;
}
```

### 3.3 Repo Map Builder

```typescript
// codegen/src/repo-map/repo-map-builder.ts
/**
 * Build a condensed repository map within a token budget.
 * Inspired by Aider's PageRank-based repo map.
 */
export function buildRepoMap(
  symbols: Symbol[],
  importGraph: ImportEdge[],
  tokenBudget: number,
  options?: { focusFiles?: string[] }
): string {
  // 1. Score symbols by importance (exported > internal, referenced > orphan)
  const scores = scoreSymbols(symbols, importGraph, options?.focusFiles);

  // 2. Sort by score descending
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);

  // 3. Build map within token budget
  const lines: string[] = ['# Repository Map\n'];
  let tokenCount = 0;

  for (const [symbol, score] of ranked) {
    const line = formatSymbol(symbol);
    const lineTokens = estimateTokens(line);
    if (tokenCount + lineTokens > tokenBudget) break;
    lines.push(line);
    tokenCount += lineTokens;
  }

  return lines.join('\n');
}

function scoreSymbols(
  symbols: Symbol[],
  graph: ImportEdge[],
  focusFiles?: string[]
): Map<Symbol, number> {
  const scores = new Map<Symbol, number>();

  // Base score: exported symbols worth more
  for (const s of symbols) {
    let score = s.exported ? 10 : 1;

    // Boost: referenced by other files
    const refs = graph.filter(e => e.symbols.includes(s.name));
    score += refs.length * 5;

    // Boost: in focus files
    if (focusFiles?.some(f => s.filePath.includes(f))) {
      score *= 3;
    }

    scores.set(s, score);
  }

  return scores;
}
```

---

## 4. Tiered Sandbox Permissions (G-25)

```typescript
// codegen/src/sandbox/permission-tiers.ts
export type PermissionTier = 'read-only' | 'workspace-write' | 'full-access';

export interface TierConfig {
  network: boolean;
  filesystem: 'read-only' | 'workspace-only' | 'full';
  processes: boolean;
  maxMemoryMb: number;
  maxCpus: number;
  timeoutMs: number;
}

export const TIER_DEFAULTS: Record<PermissionTier, TierConfig> = {
  'read-only': {
    network: false,
    filesystem: 'read-only',
    processes: false,
    maxMemoryMb: 256,
    maxCpus: 1,
    timeoutMs: 30_000,
  },
  'workspace-write': {
    network: false,
    filesystem: 'workspace-only',
    processes: true,
    maxMemoryMb: 512,
    maxCpus: 2,
    timeoutMs: 60_000,
  },
  'full-access': {
    network: true,
    filesystem: 'full',
    processes: true,
    maxMemoryMb: 1024,
    maxCpus: 4,
    timeoutMs: 120_000,
  },
};
```

---

## 5. Multi-File Coherence Validation (G-34)

```typescript
// codegen/src/validation/import-validator.ts
export function validateImports(vfs: VirtualFS): ValidationResult {
  const errors: string[] = [];

  for (const [filePath, content] of vfs.entries()) {
    if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) continue;

    const importRegex = /import\s+.*from\s+['"](\.[^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];
      const resolved = resolveImport(filePath, importPath);
      if (!vfs.exists(resolved) && !vfs.exists(resolved + '.ts') && !vfs.exists(resolved + '/index.ts')) {
        errors.push(`${filePath}: unresolved import "${importPath}" → ${resolved}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
```

---

## 6. Implementation Estimates

| Component | Files | ~LOC | Priority |
|-----------|-------|------|----------|
| Git tools (status, diff, commit, branch) | 1 | 200 | P0 |
| Git middleware | 1 | 80 | P1 |
| Git commit message generator | 1 | 50 | P1 |
| Git worktree manager | 1 | 100 | P2 |
| Enhanced edit tool | 1 (rewrite) | 80 | P0 |
| Multi-edit tool | 1 | 80 | P0 |
| Lint validator | 1 | 60 | P1 |
| Symbol extractor (ts-morph) | 1 | 120 | P1 |
| Import graph builder | 1 | 80 | P1 |
| Repo map builder | 1 | 100 | P1 |
| Permission tiers | 1 | 50 | P2 |
| Import validator | 1 | 60 | P2 |
| Type checker | 1 | 80 | P2 |
| **Total** | **~13 files** | **~1,140 LOC** | |

### New Dependencies for `@dzipagent/codegen`

```json
{
  "peerDependencies": {
    "ts-morph": ">=20.0.0"  // for AST analysis (optional)
  }
}
```
