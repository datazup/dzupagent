/**
 * rename_symbol LangChain tool — AST-aware TypeScript symbol rename.
 *
 * Uses `ts-morph` (optional peer) to load a TypeScript project via its
 * tsconfig, locate all declarations of a symbol in a given file, and rename
 * them. ts-morph propagates the rename to every cross-file reference that
 * the project graph knows about, then the tool saves the updated sources.
 *
 * If `ts-morph` is not installed, the tool throws an error stating so —
 * callers that do not need AST refactors can omit the optional peer dep.
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'

/**
 * Minimal interface for an MCP client instance.
 * Typed structurally so that callers can pass any conforming object without
 * importing the MCP SDK directly.
 */
export interface McpClient {
  call(method: string, params: unknown): Promise<unknown>
  close(): void
}

const inputSchema = z.object({
  tsconfigPath: z.string().describe('Absolute path to tsconfig.json for the TypeScript project'),
  filePath: z.string().describe('Absolute path to the file containing the symbol to rename'),
  symbolName: z.string().describe('Current name of the symbol to rename'),
  newName: z.string().describe('New name for the symbol'),
})

export interface RenameSymbolInput {
  tsconfigPath: string
  filePath: string
  symbolName: string
  newName: string
}

export interface RenameSymbolResult {
  renamedCount: number
  affectedFiles: string[]
}

/**
 * Load ts-morph dynamically so the peer dep stays optional.
 * Throws the canonical error message when ts-morph is not installed.
 */
async function loadTsMorph(): Promise<typeof import('ts-morph')> {
  try {
    // Using a dynamic import keeps this an optional peer.
    return (await import('ts-morph')) as typeof import('ts-morph')
  } catch {
    throw new Error('ts-morph is required for rename-symbol tool')
  }
}

type Declaration = {
  /** Rename this declaration (and propagate to references via ts-morph). */
  rename(newName: string): void
  /** Source file owning the declaration. */
  getSourceFile(): { getFilePath(): string }
}

/**
 * Core implementation, separated from the tool wrapper for direct testing.
 * Throws when the symbol cannot be found; the wrapper converts thrown errors
 * into structured error strings when running inside LangChain.
 */
export async function renameSymbol(input: RenameSymbolInput): Promise<RenameSymbolResult> {
  const { tsconfigPath, filePath, symbolName, newName } = input
  const tsMorph = await loadTsMorph()
  const { Project } = tsMorph

  const project = new Project({ tsConfigFilePath: tsconfigPath })

  // Make sure the target file is part of the project (ts-morph normally
  // picks it up via tsconfig, but we add it defensively for the case where
  // it isn't included in the tsconfig's file glob).
  const sourceFile =
    project.getSourceFile(filePath) ?? project.addSourceFileAtPathIfExists(filePath)

  if (!sourceFile) {
    throw new Error(`rename_symbol: file not found in project: ${filePath}`)
  }

  // Collect every top-level-ish declaration whose name matches `symbolName`.
  // We cover functions, classes, interfaces, type aliases, enums, and
  // variable declarations — the common refactor targets.
  const declarations: Declaration[] = []

  const fn = sourceFile.getFunction(symbolName)
  if (fn) declarations.push(fn as unknown as Declaration)

  const cls = sourceFile.getClass(symbolName)
  if (cls) declarations.push(cls as unknown as Declaration)

  const iface = sourceFile.getInterface(symbolName)
  if (iface) declarations.push(iface as unknown as Declaration)

  const typeAlias = sourceFile.getTypeAlias(symbolName)
  if (typeAlias) declarations.push(typeAlias as unknown as Declaration)

  const en = sourceFile.getEnum(symbolName)
  if (en) declarations.push(en as unknown as Declaration)

  const variable = sourceFile.getVariableDeclaration(symbolName)
  if (variable) declarations.push(variable as unknown as Declaration)

  if (declarations.length === 0) {
    throw new Error(
      `rename_symbol: symbol "${symbolName}" not found in ${filePath}`,
    )
  }

  // Rename — ts-morph updates every reference across the project graph.
  for (const decl of declarations) {
    decl.rename(newName)
  }

  // Collect affected files before saving so we report accurately even for
  // projects configured to emit on save.
  const affected = project
    .getSourceFiles()
    .filter((sf) => !sf.isSaved())
    .map((sf) => sf.getFilePath())

  await project.save()

  return {
    renamedCount: declarations.length,
    affectedFiles: affected,
  }
}

/**
 * Create the `rename_symbol` LangChain tool. Throws synchronously at call
 * time when ts-morph is not installed. On success the tool returns a
 * JSON-encoded {@link RenameSymbolResult}.
 *
 * @param mcpClient - Optional MCP client instance. When provided it is stored
 *   on the returned tool instance for downstream callers that need to forward
 *   MCP context (e.g. for delegating edits to an MCP-aware code-editing
 *   server). Typed as {@link McpClient} for structural safety; any object with
 *   a `call` method and a `close` method satisfies the interface.
 */
export function createRenameSymbolTool(mcpClient?: McpClient): DynamicStructuredTool & { mcpClient?: McpClient } {
  const tool: DynamicStructuredTool & { mcpClient?: McpClient } = new DynamicStructuredTool({
    name: 'rename_symbol',
    description:
      'Rename a TypeScript symbol (function, class, interface, type alias, enum, or const) ' +
      'across the whole project, using ts-morph to propagate the rename to every cross-file ' +
      'reference. Requires ts-morph as an optional peer. Returns JSON with the count of ' +
      'renamed declarations and the list of affected files.',
    schema: inputSchema,
    func: async (input) => {
      try {
        const result = await renameSymbol(input as RenameSymbolInput)
        return JSON.stringify(result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return `rename_symbol failed: ${msg}`
      }
    },
  })
  if (mcpClient !== undefined) {
    tool.mcpClient = mcpClient
  }
  return tool
}
