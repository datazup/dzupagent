/**
 * Normalized, redacted provider-free captures for WP-M1.4.
 *
 * Each provider/version pair is a complete conformance input: version output,
 * root help, and non-secret config samples. The captures intentionally retain
 * only capability-bearing lines; terminal decoration, wrapping, host paths,
 * and any authentication state are removed before check-in.
 */
export interface ProbeFixturePack {
  providerId: 'claude' | 'codex'
  version: string
  versionOutput: string
  help: string
  configSamples: readonly {
    relativePath: string
    contents: string
  }[]
  normalized: true
  redacted: true
}

export const CLAUDE_2_1_226_FIXTURE: ProbeFixturePack = {
  providerId: 'claude',
  version: '2.1.226',
  versionOutput: '2.1.226 (Claude Code)\n',
  help: `Usage: claude [options] [command] [prompt]

Claude Code - starts an interactive session by default, use -p/--print for non-interactive output

Options:
  -p, --print                       Print response and exit
  --output-format <format>          Output format (text, json, stream-json)
  --allowedTools <tools...>         Tools to allow
  --disallowedTools <tools...>      Tools to deny
  --permission-mode <mode>          Permission mode for the session
  --agents <json>                   Define custom agents
  --include-partial-messages        Include partial stream-json chunks
  -h, --help                        Display help for command

Commands:
  agents                            Manage background agents
  auth                              Manage authentication
  mcp                               Configure and manage MCP servers
  plugin                            Manage Claude Code plugins
  update                            Check for updates
`,
  configSamples: [
    {
      relativePath: '.claude/settings.json',
      contents: '{"permissions":{"defaultMode":"default","allow":["Read"]}}\n',
    },
    {
      relativePath: '.claude/settings.local.json',
      contents: '{"includeCoAuthoredBy":false}\n',
    },
  ],
  normalized: true,
  redacted: true,
}

export const CLAUDE_2_0_14_FIXTURE: ProbeFixturePack = {
  providerId: 'claude',
  version: '2.0.14',
  versionOutput: '2.0.14 (Claude Code)\n',
  help: `Usage: claude [options] [command] [prompt]

Options:
  -p, --print                 Print response and exit
  --output-format <format>    Output format (text, json, stream-json)
  --allowedTools <tools...>   Comma-separated list of allowed tools
  -h, --help                  Display help for command

Commands:
  mcp                         Configure and manage MCP servers
  plugin                      Manage Claude Code plugins
  config                      Manage configuration
  update                      Check for updates
`,
  configSamples: [
    {
      relativePath: '.claude/settings.json',
      contents: '{"permissions":{"allow":["Read"]}}\n',
    },
  ],
  normalized: true,
  redacted: true,
}

export const CODEX_0_147_0_FIXTURE: ProbeFixturePack = {
  providerId: 'codex',
  version: '0.147.0',
  versionOutput: 'codex-cli 0.147.0\n',
  help: `Codex CLI

Usage: codex [OPTIONS] [PROMPT]
       codex [OPTIONS] <COMMAND> [ARGS]

Commands:
  exec            Run Codex non-interactively
  review          Run a code review non-interactively
  login           Manage login
  mcp             Manage external MCP servers for Codex
  plugin          Manage Codex plugins
  update          Update Codex to the latest version
  doctor          Diagnose local Codex installation
  resume          Resume a previous interactive session
  fork            Fork a previous interactive session

Options:
  --json                         Emit events as JSONL
  --ask-for-approval <POLICY>    Configure approval policy
  --sandbox <MODE>               Select the sandbox policy
  --strict-config                Reject unrecognized config fields
  -h, --help                     Print help
`,
  configSamples: [
    {
      relativePath: '.codex/config.toml',
      contents: 'model = "gpt-5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n',
    },
  ],
  normalized: true,
  redacted: true,
}

export const CODEX_0_48_0_FIXTURE: ProbeFixturePack = {
  providerId: 'codex',
  version: '0.48.0',
  versionOutput: 'codex-cli 0.48.0\n',
  help: `Usage: codex [OPTIONS] [PROMPT]

Commands:
  exec                           Run a non-interactive task
  login                          Authenticate
  mcp                            Manage MCP servers

Options:
  --json                         Emit events as JSONL
  --ask-for-approval <POLICY>    Approval policy
  --sandbox <MODE>               Sandbox mode
  -h, --help                     Print help
`,
  configSamples: [
    {
      relativePath: '.codex/config.toml',
      contents: 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n',
    },
  ],
  normalized: true,
  redacted: true,
}

export const M1_FIXTURE_PACKS = [
  CLAUDE_2_1_226_FIXTURE,
  CLAUDE_2_0_14_FIXTURE,
  CODEX_0_147_0_FIXTURE,
  CODEX_0_48_0_FIXTURE,
] as const satisfies readonly ProbeFixturePack[]
