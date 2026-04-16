/**
 * Bridge between create-dzupagent scaffold output and the agent-adapters
 * importer runtime.
 *
 * When the `--wire` flag is set, this module dynamically imports
 * `@dzupagent/agent-adapters` and runs `DzupAgentImporter.executeImport()`
 * against the freshly scaffolded project directory so it can immediately
 * use the adapter system.
 *
 * The import is dynamic so that `create-dzupagent` does NOT hard-depend
 * on agent-adapters — the package remains an optional peer dependency.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WireBridgeOptions {
  /** Absolute path to the scaffolded project directory. */
  projectDir: string
}

export interface WireBridgeResult {
  /** Whether the wiring completed successfully. */
  success: boolean
  /** Number of files imported into .dzupagent/. */
  filesImported: number
  /** Number of files skipped (already existed). */
  filesSkipped: number
  /** Human-readable summaries for each imported/skipped file. */
  summaries: string[]
  /** If wiring failed, the error message. */
  error?: string
}

// ---------------------------------------------------------------------------
// Internal types (mirroring agent-adapters shapes without importing them)
// ---------------------------------------------------------------------------

/** Mirrors @dzupagent/adapter-types DzupAgentPaths */
interface DzupAgentPathsLike {
  globalDir: string
  workspaceDir: string | undefined
  projectDir: string
  stateFile: string
  projectConfig: string
}

/** Mirrors ImportResult from agent-adapters */
interface ImportResultLike {
  written: boolean
  skipped: boolean
  summary: string
}

/** Mirrors ImportPlan from agent-adapters */
interface ImportPlanLike {
  toImport: Array<{ source: unknown; targetPath: string }>
  toSkip: Array<{ source: unknown; targetPath: string; reason: string }>
}

/** Shape of the dynamically loaded module */
interface AgentAdaptersModule {
  WorkspaceResolver: new () => { resolve(projectRoot: string): Promise<DzupAgentPathsLike> }
  DzupAgentImporter: new (opts: { paths: DzupAgentPathsLike; projectRoot: string }) => {
    planImport(): Promise<ImportPlanLike>
    executeImport(plan: ImportPlanLike): Promise<ImportResultLike[]>
  }
}

// ---------------------------------------------------------------------------
// Bridge implementation
// ---------------------------------------------------------------------------

/**
 * Wire a scaffolded project into the agent-adapters runtime by running
 * the DzupAgentImporter pipeline (plan + execute).
 *
 * This function is **non-fatal**: if `@dzupagent/agent-adapters` is not
 * installed or the import fails for any reason, it returns a result with
 * `success: false` and a descriptive error message rather than throwing.
 */
export async function wireProject(
  options: WireBridgeOptions,
): Promise<WireBridgeResult> {
  const { projectDir } = options

  try {
    // Dynamic import — keeps agent-adapters as an optional peer dep.
    const adapters = await loadAgentAdapters()

    // Resolve .dzupagent/ paths for the project.
    const resolver = new adapters.WorkspaceResolver()
    const paths = await resolver.resolve(projectDir)

    // Create importer and run plan + execute.
    const importer = new adapters.DzupAgentImporter({
      paths,
      projectRoot: projectDir,
    })

    const plan = await importer.planImport()
    const results = await importer.executeImport(plan)

    const filesImported = results.filter((r) => r.written).length
    const filesSkipped = results.filter((r) => r.skipped).length
    const summaries = results.map((r) => r.summary)

    return {
      success: true,
      filesImported,
      filesSkipped,
      summaries,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      filesImported: 0,
      filesSkipped: 0,
      summaries: [],
      error: message,
    }
  }
}

// ---------------------------------------------------------------------------
// Dynamic loader
// ---------------------------------------------------------------------------

/**
 * Dynamically load the agent-adapters package.
 * Throws a descriptive error when the package is not installed.
 */
async function loadAgentAdapters(): Promise<AgentAdaptersModule> {
  try {
    const mod: unknown = await import('@dzupagent/agent-adapters')
    return mod as AgentAdaptersModule
  } catch {
    throw new Error(
      'Cannot wire project: @dzupagent/agent-adapters is not installed. ' +
        'Install it as a dependency to use the --wire flag.',
    )
  }
}
