/**
 * AGENTS.md v2 parser — reads YAML front matter + markdown sections.
 *
 * Supports:
 * - YAML front matter (name, description, version, tags)
 * - ## Capabilities section with bullet lists
 * - ## Memory section with key: value pairs
 * - ## Security section with allowed/blocked tool lists
 * - Backward compatibility with v1 AgentsMdConfig via toLegacyConfig()
 */
import type { AgentsMdConfig } from '../skills/agents-md-parser.js'
import type {
  AgentsMdDocument,
  AgentsMdMetadata,
  AgentsMdCapability,
  AgentsMdMemoryConfig,
  AgentsMdSecurityConfig,
} from './agents-md-types.js'

// ---------------------------------------------------------------------------
// YAML front matter parser (lightweight, no external deps)
// ---------------------------------------------------------------------------

interface FrontMatterResult {
  metadata: Record<string, unknown>
  body: string
}

function parseFrontMatter(content: string): FrontMatterResult {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('---')) {
    return { metadata: {}, body: content }
  }

  const endIndex = trimmed.indexOf('---', 3)
  if (endIndex === -1) {
    return { metadata: {}, body: content }
  }

  const yamlBlock = trimmed.slice(3, endIndex).trim()
  const body = trimmed.slice(endIndex + 3).trim()
  const metadata = parseSimpleYaml(yamlBlock)

  return { metadata, body }
}

/**
 * Parse a simple YAML block (flat key-value pairs + inline arrays).
 * Handles: `key: value`, `key: [a, b, c]`, `key: 123`
 * Does NOT handle nested objects, multi-line strings, or anchors.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = yaml.split('\n')

  for (const line of lines) {
    const trimmedLine = line.trim()
    if (!trimmedLine || trimmedLine.startsWith('#')) continue

    const colonIndex = trimmedLine.indexOf(':')
    if (colonIndex === -1) continue

    const key = trimmedLine.slice(0, colonIndex).trim()
    const rawValue = trimmedLine.slice(colonIndex + 1).trim()

    if (!key) continue

    result[key] = parseYamlValue(rawValue)
  }

  return result
}

function parseYamlValue(raw: string): unknown {
  // Inline array: [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map((item) => parseYamlScalar(item.trim()))
  }

  return parseYamlScalar(raw)
}

function parseYamlScalar(raw: string): unknown {
  if (!raw) return ''

  // Remove surrounding quotes
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }

  // Boolean
  if (raw === 'true') return true
  if (raw === 'false') return false

  // Null
  if (raw === 'null' || raw === '~') return null

  // Number
  const num = Number(raw)
  if (!Number.isNaN(num) && raw !== '') return num

  return raw
}

// ---------------------------------------------------------------------------
// Section parser
// ---------------------------------------------------------------------------

interface MarkdownSection {
  heading: string | null
  body: string
}

function parseMarkdownSections(content: string): MarkdownSection[] {
  const sections: MarkdownSection[] = []
  const lines = content.split('\n')
  let currentHeading: string | null = null
  let currentBody: string[] = []

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentBody.length > 0 || currentHeading !== null) {
        sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() })
      }
      currentHeading = line.slice(3).trim()
      currentBody = []
    } else {
      currentBody.push(line)
    }
  }

  if (currentBody.length > 0 || currentHeading !== null) {
    sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() })
  }

  return sections
}

// ---------------------------------------------------------------------------
// Section extractors
// ---------------------------------------------------------------------------

function parseCapabilitiesSection(body: string): AgentsMdCapability[] {
  const capabilities: AgentsMdCapability[] = []
  const lines = body.split('\n')

  for (const line of lines) {
    const trimmedLine = line.trim()
    if (!trimmedLine.startsWith('-')) continue

    const itemText = trimmedLine.slice(1).trim()
    if (!itemText) continue

    // Format: "Name: Description" or "Name — Description" or just "Name"
    const separatorMatch = itemText.match(/^([^:—]+)[:\u2014]\s*(.+)$/)
    if (separatorMatch) {
      capabilities.push({
        name: separatorMatch[1]!.trim(),
        description: separatorMatch[2]!.trim(),
      })
    } else {
      capabilities.push({
        name: itemText,
        description: itemText,
      })
    }
  }

  return capabilities
}

function parseMemorySection(body: string): AgentsMdMemoryConfig {
  const config: AgentsMdMemoryConfig = {}
  const lines = body.split('\n')

  for (const line of lines) {
    const trimmedLine = line.trim()
    if (!trimmedLine || trimmedLine.startsWith('#')) continue

    // Key-value pairs: "namespaces: [a, b]" or "- namespace_name"
    const colonIndex = trimmedLine.indexOf(':')
    if (colonIndex !== -1) {
      const key = trimmedLine.slice(0, colonIndex).trim().toLowerCase()
      const rawValue = trimmedLine.slice(colonIndex + 1).trim()

      if (key === 'namespaces') {
        const parsed = parseYamlValue(rawValue)
        if (Array.isArray(parsed)) {
          config.namespaces = parsed.map(String)
        }
      } else if (key === 'maxrecords' || key === 'max_records' || key === 'max-records') {
        const num = Number(rawValue)
        if (!Number.isNaN(num)) {
          config.maxRecords = num
        }
      }
    } else if (trimmedLine.startsWith('-')) {
      // Bullet list of namespaces
      const ns = trimmedLine.slice(1).trim()
      if (ns) {
        config.namespaces ??= []
        config.namespaces.push(ns)
      }
    }
  }

  return config
}

function parseSecuritySection(body: string): AgentsMdSecurityConfig {
  const config: AgentsMdSecurityConfig = {}
  const lines = body.split('\n')

  let currentSubSection: 'allowed' | 'blocked' | null = null

  for (const line of lines) {
    const trimmedLine = line.trim()

    // Sub-headings: "### Allowed Tools" or "### Blocked Tools"
    if (trimmedLine.startsWith('### ')) {
      const subHeading = trimmedLine.slice(4).trim().toLowerCase()
      if (subHeading.includes('allowed')) {
        currentSubSection = 'allowed'
      } else if (subHeading.includes('blocked') || subHeading.includes('denied')) {
        currentSubSection = 'blocked'
      } else {
        currentSubSection = null
      }
      continue
    }

    if (!trimmedLine.startsWith('-')) continue

    const tool = trimmedLine.slice(1).trim()
    if (!tool) continue

    // If no sub-section, use ! prefix convention (like v1)
    if (currentSubSection === null) {
      if (tool.startsWith('!')) {
        config.blockedTools ??= []
        config.blockedTools.push(tool.slice(1).trim())
      } else {
        config.allowedTools ??= []
        config.allowedTools.push(tool)
      }
    } else if (currentSubSection === 'allowed') {
      config.allowedTools ??= []
      config.allowedTools.push(tool)
    } else if (currentSubSection === 'blocked') {
      config.blockedTools ??= []
      config.blockedTools.push(tool)
    }
  }

  return config
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an AGENTS.md v2 document with YAML front matter and markdown sections.
 */
export function parseAgentsMdV2(content: string): AgentsMdDocument {
  const { metadata: rawMeta, body } = parseFrontMatter(content)

  const metadata: AgentsMdMetadata = {
    name: String(rawMeta['name'] ?? ''),
  }
  if (rawMeta['description'] !== undefined) {
    metadata.description = String(rawMeta['description'])
  }
  if (rawMeta['version'] !== undefined) {
    metadata.version = String(rawMeta['version'])
  }
  if (Array.isArray(rawMeta['tags'])) {
    metadata.tags = (rawMeta['tags'] as unknown[]).map(String)
  }

  const doc: AgentsMdDocument = {
    metadata,
    rawContent: content,
  }

  // Parse markdown sections
  const sections = parseMarkdownSections(body)

  for (const section of sections) {
    if (!section.heading || !section.body) continue

    const headingLower = section.heading.toLowerCase()

    if (headingLower === 'capabilities') {
      const caps = parseCapabilitiesSection(section.body)
      if (caps.length > 0) {
        doc.capabilities = caps
      }
    } else if (headingLower === 'memory') {
      const mem = parseMemorySection(section.body)
      if (mem.namespaces || mem.maxRecords !== undefined) {
        doc.memory = mem
      }
    } else if (headingLower === 'security' || headingLower === 'tools') {
      const sec = parseSecuritySection(section.body)
      if (sec.allowedTools || sec.blockedTools) {
        doc.security = sec
      }
    }
  }

  return doc
}

/**
 * Generate an AGENTS.md v2 document string from a structured document.
 */
export function generateAgentsMd(doc: AgentsMdDocument): string {
  const parts: string[] = []

  // YAML front matter
  const frontMatterLines: string[] = []
  frontMatterLines.push(`name: ${doc.metadata.name}`)
  if (doc.metadata.description) {
    frontMatterLines.push(`description: ${doc.metadata.description}`)
  }
  if (doc.metadata.version) {
    frontMatterLines.push(`version: ${doc.metadata.version}`)
  }
  if (doc.metadata.tags && doc.metadata.tags.length > 0) {
    frontMatterLines.push(`tags: [${doc.metadata.tags.join(', ')}]`)
  }

  parts.push(`---\n${frontMatterLines.join('\n')}\n---`)

  // Capabilities section
  if (doc.capabilities && doc.capabilities.length > 0) {
    const capLines = doc.capabilities.map(
      (cap) => `- ${cap.name}: ${cap.description}`,
    )
    parts.push(`\n## Capabilities\n${capLines.join('\n')}`)
  }

  // Memory section
  if (doc.memory) {
    const memLines: string[] = []
    if (doc.memory.namespaces && doc.memory.namespaces.length > 0) {
      memLines.push(`namespaces: [${doc.memory.namespaces.join(', ')}]`)
    }
    if (doc.memory.maxRecords !== undefined) {
      memLines.push(`maxRecords: ${doc.memory.maxRecords}`)
    }
    if (memLines.length > 0) {
      parts.push(`\n## Memory\n${memLines.join('\n')}`)
    }
  }

  // Security section
  if (doc.security) {
    const secLines: string[] = []
    if (doc.security.allowedTools && doc.security.allowedTools.length > 0) {
      secLines.push('### Allowed Tools')
      for (const tool of doc.security.allowedTools) {
        secLines.push(`- ${tool}`)
      }
    }
    if (doc.security.blockedTools && doc.security.blockedTools.length > 0) {
      secLines.push('### Blocked Tools')
      for (const tool of doc.security.blockedTools) {
        secLines.push(`- ${tool}`)
      }
    }
    if (secLines.length > 0) {
      parts.push(`\n## Security\n${secLines.join('\n')}`)
    }
  }

  return parts.join('\n')
}

/**
 * Convert an AgentsMdDocument (v2) to the legacy AgentsMdConfig format
 * for backward compatibility with existing code.
 */
export function toLegacyConfig(doc: AgentsMdDocument): AgentsMdConfig {
  const config: AgentsMdConfig = {
    instructions: [],
    rules: [],
  }

  // Add metadata as instruction if there's a description
  if (doc.metadata.description) {
    config.instructions.push(doc.metadata.description)
  }

  // Add capabilities as instructions
  if (doc.capabilities) {
    for (const cap of doc.capabilities) {
      config.instructions.push(`${cap.name}: ${cap.description}`)
    }
  }

  // Map security to tool lists
  if (doc.security?.allowedTools) {
    config.allowedTools = [...doc.security.allowedTools]
  }
  if (doc.security?.blockedTools) {
    config.blockedTools = [...doc.security.blockedTools]
  }

  return config
}
