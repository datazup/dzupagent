/**
 * File merge utilities for sub-agent VFS integration.
 * Handles merging file changes from isolated sub-agents back to the parent.
 */

/**
 * Merge child file changes back into the parent VFS.
 *
 * @param parent - Current parent VFS snapshot
 * @param child - Child agent's file changes
 * @param strategy - 'last-write-wins' (default) or 'conflict-error'
 * @returns Merged VFS snapshot
 */
export function mergeFileChanges(
  parent: Record<string, string>,
  child: Record<string, string>,
  strategy: 'last-write-wins' | 'conflict-error' = 'last-write-wins',
): Record<string, string> {
  if (strategy === 'conflict-error') {
    // Check for conflicts: files that exist in both and have different content
    for (const [path, content] of Object.entries(child)) {
      if (path in parent && parent[path] !== content) {
        throw new Error(`File merge conflict at "${path}" — parent and child have different content`)
      }
    }
  }

  return { ...parent, ...child }
}

/**
 * LangGraph Annotation reducer for concurrent VFS updates.
 * Handles parallel sub-agent file writes with last-write-wins semantics.
 * Null values in the update signal file deletion.
 */
export function fileDataReducer(
  current: Record<string, string>,
  update: Record<string, string | null>,
): Record<string, string> {
  const result = { ...current }

  for (const [path, content] of Object.entries(update)) {
    if (content === null) {
      delete result[path]
    } else {
      result[path] = content
    }
  }

  return result
}
