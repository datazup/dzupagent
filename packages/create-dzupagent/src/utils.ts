import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, mkdir } from 'node:fs/promises'
import type { PackageManagerType } from './types.js'

const execFileAsync = promisify(execFile)

/**
 * Validate a project name is a valid npm package name.
 * Returns null if valid, or an error message string.
 */
export function validateProjectName(name: string): string | null {
  if (!name || name.trim().length === 0) {
    return 'Project name cannot be empty'
  }

  if (name.startsWith('.') || name.startsWith('_')) {
    return 'Project name cannot start with . or _'
  }

  if (name !== name.toLowerCase()) {
    return 'Project name must be lowercase'
  }

  if (name.length > 214) {
    return 'Project name must be 214 characters or fewer'
  }

  // Only allow URL-safe characters (npm scoped or unscoped package names)
  const scopedNameRegex = /^@[a-z0-9~-][a-z0-9._~-]*\/[a-z0-9~-][a-z0-9._~-]*$/
  const unscopedNameRegex = /^[a-z0-9~-][a-z0-9._~-]*$/
  if (!unscopedNameRegex.test(name) && !scopedNameRegex.test(name)) {
    return 'Project name contains invalid characters. Use lowercase letters, numbers, hyphens, dots, or tildes'
  }

  return null
}

/**
 * Detect the preferred package manager based on lockfiles
 * in the current working directory.
 */
export function detectPackageManager(cwd?: string): PackageManagerType {
  const dir = cwd ?? process.cwd()

  if (existsSync(join(dir, 'pnpm-lock.yaml'))) {
    return 'pnpm'
  }
  if (existsSync(join(dir, 'yarn.lock'))) {
    return 'yarn'
  }
  // Default to npm
  return 'npm'
}

/**
 * Run a shell command and return its output.
 * Throws on non-zero exit code.
 */
export async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd,
    timeout: 120_000,
    env: { ...process.env },
  })
  return { stdout, stderr }
}

/**
 * Install dependencies using the specified package manager.
 */
export async function installDependencies(
  cwd: string,
  packageManager: PackageManagerType,
): Promise<void> {
  const args = packageManager === 'yarn' ? [] : ['install']
  await runCommand(packageManager, args, cwd)
}

/**
 * Initialize a git repository in the given directory.
 */
export async function initGitRepo(cwd: string): Promise<void> {
  await runCommand('git', ['init'], cwd)
  await runCommand('git', ['add', '.'], cwd)
  await runCommand('git', ['commit', '-m', 'Initial commit from create-dzupagent'], cwd)
}

/**
 * Apply an overlay (set of files) on top of an existing project directory.
 */
export async function applyOverlay(
  basePath: string,
  overlayFiles: Array<{ path: string; content: string }>,
): Promise<string[]> {
  const created: string[] = []

  for (const file of overlayFiles) {
    const fullPath = join(basePath, file.path)
    const dir = join(fullPath, '..')
    await mkdir(dir, { recursive: true })
    await writeFile(fullPath, file.content, 'utf-8')
    created.push(file.path)
  }

  return created
}

/**
 * Fetch templates from the marketplace API.
 * Returns null if the API is unreachable.
 */
export async function fetchMarketplaceTemplates(
  baseUrl: string,
): Promise<Array<{ slug: string; name: string; description: string; features: string[] }> | null> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)

    const response = await fetch(`${baseUrl}/api/marketplace/templates`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      return null
    }

    const data = (await response.json()) as {
      templates?: Array<{ slug: string; name: string; description: string; features: string[] }>
    }
    return data.templates ?? null
  } catch {
    // API unreachable — fall back to built-in templates
    return null
  }
}

/**
 * Get the install command string for display purposes.
 */
export function getInstallCommand(pm: PackageManagerType): string {
  switch (pm) {
    case 'yarn':
      return 'yarn'
    case 'pnpm':
      return 'pnpm install'
    case 'npm':
      return 'npm install'
  }
}

/**
 * Get the dev command string for display purposes.
 */
export function getDevCommand(pm: PackageManagerType): string {
  switch (pm) {
    case 'yarn':
      return 'yarn dev'
    case 'pnpm':
      return 'pnpm dev'
    case 'npm':
      return 'npm run dev'
  }
}
