/**
 * Watcher-registration projector.
 *
 * Builds a deduplicated list of filesystem paths the runtime should watch in
 * order to support the active rule set. For each active rule, the projector
 * emits project-local and user-home watch paths specific to the providers the
 * rule targets (Claude, Codex, Gemini, Qwen, Goose, Crush). A `.dzupagent/`
 * watcher is always included so DzupAgent-level metadata (capabilities,
 * memories, skills) is observed regardless of provider.
 *
 * The projector is pure: it never touches the filesystem and never mutates
 * its inputs. `context.workspaceDir`, when provided, is used as the base for
 * relative project-local paths; `~/` is retained verbatim so the runtime can
 * expand it against the current user's home directory.
 */

import type { AdapterRule, CompileContext, WatcherRegistration } from '../types.js'

type ProviderWatcherSpec = {
  project: string[]
  home: string[]
}

/**
 * Per-provider watch paths. `project` entries are resolved against
 * `context.workspaceDir`; `home` entries start with `~/` and are expanded by
 * the runtime.
 */
const PROVIDER_WATCHERS: Record<string, ProviderWatcherSpec> = {
  claude: {
    project: ['.claude/'],
    home: ['~/.claude/'],
  },
  codex: {
    project: ['.codex/'],
    home: ['~/.codex/'],
  },
  gemini: {
    project: ['.gemini/'],
    home: ['~/.gemini/'],
  },
  'gemini-sdk': {
    project: ['.gemini/'],
    home: ['~/.gemini/'],
  },
  qwen: {
    project: ['.qwen/'],
    home: ['~/.qwen/'],
  },
  goose: {
    project: ['.goosehints'],
    home: ['~/.config/goose/', '~/.local/share/goose/'],
  },
  crush: {
    project: ['.crush/'],
    home: ['~/.config/crush/', '~/.local/share/crush/'],
  },
}

const DZUPAGENT_WATCHER: WatcherRegistration = {
  path: '.dzupagent/',
  provider: 'dzupagent',
  watchClass: 'dzupagent',
  description: 'DzupAgent workspace metadata (capabilities, memories, skills)',
}

export function buildWatcherRegistrations(
  rules: AdapterRule[],
  context: CompileContext,
): WatcherRegistration[] {
  const registrations: WatcherRegistration[] = []
  const seen = new Set<string>()

  const push = (registration: WatcherRegistration): void => {
    if (seen.has(registration.path)) return
    seen.add(registration.path)
    registrations.push(registration)
  }

  // Always watch .dzupagent/ (resolved against workspaceDir when available).
  push({
    ...DZUPAGENT_WATCHER,
    path: resolveProjectPath(DZUPAGENT_WATCHER.path, context),
  })

  for (const rule of rules) {
    for (const provider of rule.appliesToProviders) {
      const spec = PROVIDER_WATCHERS[provider]
      if (spec === undefined) continue

      for (const projectPath of spec.project) {
        push({
          path: resolveProjectPath(projectPath, context),
          provider,
          watchClass: 'project',
          description: `${provider} project-local configuration`,
        })
      }
      for (const homePath of spec.home) {
        push({
          path: homePath,
          provider,
          watchClass: 'home',
          description: `${provider} user-home configuration`,
        })
      }
    }
  }

  return registrations
}

function resolveProjectPath(relative: string, context: CompileContext): string {
  if (context.workspaceDir === undefined || context.workspaceDir.length === 0) {
    return relative
  }
  const base = context.workspaceDir.endsWith('/')
    ? context.workspaceDir
    : `${context.workspaceDir}/`
  return `${base}${relative}`
}
