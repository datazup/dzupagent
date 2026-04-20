export class PathSecurityError extends Error {
  constructor(
    public readonly attemptedPath: string,
    public readonly workspaceRoot: string,
  ) {
    super(`Path traversal rejected: "${attemptedPath}" is outside workspace root "${workspaceRoot}"`)
    this.name = 'PathSecurityError'
  }
}
