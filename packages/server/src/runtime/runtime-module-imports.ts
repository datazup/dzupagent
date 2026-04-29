function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const maybeCode = (error as { code?: unknown }).code
  return typeof maybeCode === 'string' ? maybeCode : undefined
}

function isModuleNotFoundError(error: unknown): boolean {
  const code = getErrorCode(error)
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    return true
  }
  return (
    message.includes('Cannot find module')
    || message.includes('Cannot find package')
    || message.includes('Failed to load url')
  )
}

export async function importFirstAvailable(paths: string[]): Promise<Record<string, unknown> | null> {
  for (const p of paths) {
    try {
      return await import(p)
    } catch (error) {
      if (isModuleNotFoundError(error)) {
        continue
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to import "${p}": ${message}`)
    }
  }
  return null
}
