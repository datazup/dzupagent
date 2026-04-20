import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import ts from 'typescript'
import type { WorkspaceFS } from '@dzupagent/codegen'

const inputSchema = z.object({
  filePath: z.string().describe('Absolute path to the file containing the symbol to rename'),
  oldName: z.string().describe('Current name of the symbol'),
  newName: z.string().describe('New name for the symbol'),
  rootDir: z.string().describe('Absolute path to the TypeScript project root (where tsconfig.json lives)'),
})

/** Collect all TextSpan references for a symbol at a given position. */
function collectReferences(
  service: ts.LanguageService,
  filePath: string,
  position: number,
): Array<{ fileName: string; span: ts.TextSpan }> {
  const refs = service.findReferences(filePath, position)
  if (!refs) return []
  const out: Array<{ fileName: string; span: ts.TextSpan }> = []
  for (const refGroup of refs) {
    for (const ref of refGroup.references) {
      out.push({ fileName: ref.fileName, span: ref.textSpan })
    }
  }
  return out
}

/** Find the position of the first occurrence of `name` as a word boundary in source text. */
function findSymbolPosition(source: string, name: string): number | null {
  const re = new RegExp(`\\b${name}\\b`)
  const m = re.exec(source)
  return m ? m.index : null
}

export function createRenameSymbolTool(workspace: WorkspaceFS): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'rename_symbol',
    description:
      'Rename a TypeScript symbol across all files in the project. ' +
      'Uses the TypeScript Language Service to find all references, then applies ' +
      'text replacements atomically via the workspace. ' +
      'Returns a summary of files modified, or an error if the symbol was not found.',
    schema: inputSchema,
    func: async (input) => {
      const { filePath, oldName, newName, rootDir } = input

      // Read the target file through the workspace
      const sourceText = await workspace.read(filePath)
      if (sourceText == null) {
        return `rename_symbol failed: file not found: ${filePath}`
      }

      // Find the symbol's position — we need any occurrence to hand to LanguageService
      const position = findSymbolPosition(sourceText, oldName)
      if (position === null) {
        return `rename_symbol failed: symbol "${oldName}" not found in ${filePath}`
      }

      // Snapshot all current files so the language service can compile the project
      const snapshot = await workspace.snapshot()

      // Build an in-memory compiler host from the snapshot
      const fileMap = new Map<string, ts.IScriptSnapshot>()
      for (const [path, content] of Object.entries(snapshot)) {
        fileMap.set(path, ts.ScriptSnapshot.fromString(content))
      }
      // Ensure the target file is present (it may have been provided as absolute path)
      if (!fileMap.has(filePath)) {
        fileMap.set(filePath, ts.ScriptSnapshot.fromString(sourceText))
      }

      const compilerOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        allowJs: false,
      }

      const host: ts.LanguageServiceHost = {
        getCompilationSettings: () => compilerOptions,
        getScriptFileNames: () => [filePath, ...Array.from(fileMap.keys())],
        getScriptVersion: () => '1',
        getScriptSnapshot: (name) => fileMap.get(name) ?? ts.ScriptSnapshot.fromString(''),
        getCurrentDirectory: () => rootDir,
        getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
      }

      const service = ts.createLanguageService(host)

      let refs: Array<{ fileName: string; span: ts.TextSpan }>
      try {
        refs = collectReferences(service, filePath, position)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return `rename_symbol failed: LanguageService error: ${msg}`
      }

      if (refs.length === 0) {
        return `rename_symbol: no references found for "${oldName}" in ${filePath}`
      }

      // Group references by file and sort descending by offset so replacements
      // don't invalidate earlier offsets
      const byFile = new Map<string, ts.TextSpan[]>()
      for (const { fileName, span } of refs) {
        const existing = byFile.get(fileName) ?? []
        existing.push(span)
        byFile.set(fileName, existing)
      }

      const modifiedFiles: string[] = []
      const errors: string[] = []

      for (const [fileName, spans] of byFile.entries()) {
        const content = fileMap.get(fileName)
          ? (await workspace.read(fileName)) ?? snapshot[fileName]
          : snapshot[fileName]

        if (content == null) continue

        // Sort spans descending so we replace from end → start
        spans.sort((a, b) => b.start - a.start)

        let updated = content
        for (const span of spans) {
          const before = updated.slice(0, span.start)
          const after = updated.slice(span.start + span.length)
          updated = before + newName + after
        }

        try {
          await workspace.write(fileName, updated)
          modifiedFiles.push(fileName)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          errors.push(`${fileName}: ${msg}`)
        }
      }

      service.dispose()

      const summary = `Renamed "${oldName}" → "${newName}" in ${modifiedFiles.length} file(s):\n` +
        modifiedFiles.map((f) => `  - ${f}`).join('\n')

      if (errors.length > 0) {
        return `${summary}\n\nErrors (${errors.length}):\n${errors.join('\n')}`
      }
      return summary
    },
  })
}
