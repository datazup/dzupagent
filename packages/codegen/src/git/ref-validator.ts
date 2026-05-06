/**
 * Git ref-name validator.
 *
 * Hardens caller-supplied positionals (branch names, commits, tags) against
 * being interpreted by `git` itself as command-line flags or as malicious
 * refspecs. Even though every git invocation goes through `execFile` (no
 * shell), git will still parse a leading `-` argument as an option, allowing
 * payloads such as `--upload-pack=/tmp/x.sh` or `-c core.fsmonitor=...` to
 * silently change git's behaviour.
 *
 * The pattern adopted here is intentionally stricter than
 * `git-check-ref-format` and rejects anything that is not a plain
 * alphanumeric/`._/-` identifier. Refer to the rules of
 * `git-check-ref-format(1)` for the canonical list of forbidden constructs:
 *  - no leading `-`
 *  - no `..`
 *  - no `~`, `^`, `:`, `?`, `*`, `[`, `\\`, space, control chars
 *  - no leading `/`, no trailing `/`, no consecutive `//`
 *  - no `.lock` suffix
 *  - no leading `.`
 *  - no `@{` sequence
 */

/**
 * Branded type for validated git ref names. Construct via `validateRefName`.
 */
export type GitRefName = string & { readonly __gitRefName: unique symbol }

export type GitRefKind = 'branch' | 'commit' | 'tag' | 'ref'

/**
 * Conservative ref pattern. Allows only `[A-Za-z0-9._/-]`, must NOT start with
 * `-`, `/`, `.`, or `_` followed by metacharacters. Rejects anything else.
 *
 * Examples accepted:   `feature/foo-bar`, `refs/heads/main`, `v1.2.3`
 * Examples rejected:   `--upload-pack=/tmp/x.sh`, `-c`, `..`, `foo..bar`,
 *                      `foo~1`, `foo^`, `foo:bar`, `foo?`, `foo*`, `foo[`,
 *                      `foo\\bar`, `/abs`, `trail/`, `foo.lock`, `.hidden`
 */
export const GIT_REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/

export class InvalidGitRefError extends Error {
  override readonly name = 'InvalidGitRefError'

  constructor(
    public readonly refName: string,
    public readonly kind: GitRefKind,
    public readonly reason: string,
  ) {
    super(`Invalid git ${kind} ref ${JSON.stringify(refName)}: ${reason}`)
  }
}

/**
 * Validate a caller-supplied git ref name. Throws `InvalidGitRefError` if the
 * value would be interpreted by git as a flag or violates ref-format rules.
 *
 * Used as an assertion so call sites that pass the value forward can rely on
 * the branded `GitRefName` type without any runtime cost beyond this check.
 */
export function validateRefName(
  name: string,
  kind: GitRefKind,
): asserts name is GitRefName {
  if (typeof name !== 'string') {
    throw new InvalidGitRefError(String(name), kind, 'must be a string')
  }
  if (name.length === 0) {
    throw new InvalidGitRefError(name, kind, 'must not be empty')
  }
  if (name.length > 255) {
    throw new InvalidGitRefError(name, kind, 'exceeds maximum length (255)')
  }

  // Reject leading `-` (would be parsed as a git option).
  if (name.startsWith('-')) {
    throw new InvalidGitRefError(name, kind, 'must not start with "-"')
  }

  // Reject leading `/` and trailing `/`.
  if (name.startsWith('/')) {
    throw new InvalidGitRefError(name, kind, 'must not start with "/"')
  }
  if (name.endsWith('/')) {
    throw new InvalidGitRefError(name, kind, 'must not end with "/"')
  }

  // Reject leading `.`
  if (name.startsWith('.')) {
    throw new InvalidGitRefError(name, kind, 'must not start with "."')
  }

  // Reject `..` anywhere (parent traversal / ref-format rule).
  if (name.includes('..')) {
    throw new InvalidGitRefError(name, kind, 'must not contain ".."')
  }

  // Reject `//` (empty ref component).
  if (name.includes('//')) {
    throw new InvalidGitRefError(name, kind, 'must not contain "//"')
  }

  // Reject `@{` (reflog selector).
  if (name.includes('@{')) {
    throw new InvalidGitRefError(name, kind, 'must not contain "@{"')
  }

  // Reject `.lock` suffix.
  if (name.endsWith('.lock')) {
    throw new InvalidGitRefError(name, kind, 'must not end with ".lock"')
  }

  // Reject git-ref-format metacharacters and shell metacharacters.
  // Set: ~ ^ : ? * [ \ space and control chars (0x00-0x1F, 0x7F).
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) {
    throw new InvalidGitRefError(
      name,
      kind,
      'must not contain whitespace, control chars, or any of: ~ ^ : ? * [ \\',
    )
  }

  // Final whitelist check.
  if (!GIT_REF_PATTERN.test(name)) {
    throw new InvalidGitRefError(
      name,
      kind,
      `does not match ${GIT_REF_PATTERN.source}`,
    )
  }
}

/**
 * Convenience wrapper that returns the branded value rather than asserting.
 */
export function asRefName(name: string, kind: GitRefKind): GitRefName {
  validateRefName(name, kind)
  return name
}
