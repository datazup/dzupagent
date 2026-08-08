/** Provider-free, normalized captures for the partial-tier M1 inspectors. */
export interface PartialProbeFixturePack {
  providerId: 'gemini' | 'qwen'
  version: string
  versionOutput: string
  help: string
  configSamples: readonly { relativePath: string; contents: string }[]
  /** No authenticated run was made, so usage parsing must remain absent. */
  usageTranscript: null
  normalized: true
  redacted: true
}

export const GEMINI_0_35_3_FIXTURE: PartialProbeFixturePack = {
  providerId: 'gemini',
  version: '0.35.3',
  versionOutput: '0.35.3\n',
  help: `Usage: gemini [options] [command]

Gemini CLI - Defaults to interactive mode. Use -p/--prompt for non-interactive mode.

Commands:
  mcp                   Manage MCP servers
  extensions            Manage Gemini CLI extensions
  skills                Manage agent skills
  hooks                 Manage Gemini CLI hooks

Options:
  -p, --prompt                    Run in non-interactive mode
  -s, --sandbox                   Run in sandbox
  -y, --yolo                      Automatically accept all actions
  --approval-mode <mode>          Set the approval mode
  --policy <path>                 Load an additional policy
  --acp                           Start the agent in ACP mode
  --allowed-mcp-server-names      Restrict MCP server names
  -o, --output-format <format>    Output format (text, json, stream-json)
  -h, --help                      Show help
`,
  configSamples: [
    {
      relativePath: '.gemini/settings.json',
      contents: '{"security":{"auth":{"selectedType":"oauth-personal"}},"tools":{"sandbox":true}}\n',
    },
  ],
  usageTranscript: null,
  normalized: true,
  redacted: true,
}

export const QWEN_0_17_1_FIXTURE: PartialProbeFixturePack = {
  providerId: 'qwen',
  version: '0.17.1',
  versionOutput: '0.17.1\n',
  help: `Usage: qwen [options] [command]

Qwen Code - Launch an interactive CLI. Positional prompts default to one-shot.

Commands:
  mcp                   Manage MCP servers
  extensions            Manage Qwen Code extensions
  auth                  Configure authentication
  hooks                 Manage Qwen Code hooks
  channel               Manage messaging channels
  serve                 Run Qwen Code as a local HTTP daemon

Options:
  --telemetry                    Control telemetry; use telemetry.enabled in settings.json
  --telemetry-log-prompts        Control prompt logging for telemetry
  --bare                         Skip implicit startup auto-discovery
  -p, --prompt                   Prompt for non-interactive use
  -s, --sandbox                  Run in sandbox
  -y, --yolo                     Automatically accept all actions
  --approval-mode <mode>         Set the approval mode
  --acp                          Start the agent in ACP mode
  --allowed-tools <tools>        Tools to allow without confirmation
  -o, --output-format <format>   Output format (text, json, stream-json)
  --include-partial-messages     Include partial stream-json messages
  --json-schema <schema>         Constrain final structured output
  -h, --help                     Show help
`,
  configSamples: [
    {
      relativePath: '.qwen/settings.json',
      contents: '{"telemetry":{"enabled":false,"logPrompts":false},"tools":{"sandbox":true}}\n',
    },
  ],
  usageTranscript: null,
  normalized: true,
  redacted: true,
}

export const PARTIAL_FIXTURE_PACKS = [
  GEMINI_0_35_3_FIXTURE,
  QWEN_0_17_1_FIXTURE,
] as const satisfies readonly PartialProbeFixturePack[]
