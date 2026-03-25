/**
 * DocGenerator — generates documentation files for agents, tools, and pipelines.
 *
 * @module docs/doc-generator
 */

import { renderAgentDoc } from './agent-doc.js'
import type { AgentDocInput } from './agent-doc.js'
import { renderToolDoc } from './tool-doc.js'
import type { ToolDocInput } from './tool-doc.js'
import { renderPipelineDoc } from './pipeline-doc.js'
import type { PipelineDocInput } from './pipeline-doc.js'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocGeneratorConfig {
  /** Output format (default: 'markdown'). */
  format?: 'markdown' | 'html'
  /** Directory to write generated docs. Defaults to './docs'. */
  outputDir?: string
  /** If set, only include docs for the listed names. */
  include?: string[]
}

export interface DocGeneratorContext {
  agents?: AgentDocInput[]
  tools?: ToolDocInput[]
  pipelines?: PipelineDocInput[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toHtml(markdown: string): string {
  // Minimal markdown-to-html for headings, paragraphs, code blocks, and tables.
  // For production use a real Markdown parser; this covers the generated output.
  let html = markdown
    // Code blocks (mermaid and regular)
    .replace(/```(\w+)?\n([\s\S]*?)```/g, (_match, lang: string | undefined, code: string) => {
      const langAttr = lang ? ` class="language-${lang}"` : ''
      return `<pre><code${langAttr}>${code.trim()}</code></pre>`
    })
    // Headings
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Table rows (basic — pipe-delimited lines)
    .replace(/^\|(.+)\|$/gm, (line) => {
      const cells = line
        .split('|')
        .filter((c) => c.trim() !== '')
        .map((c) => c.trim())
      // Skip separator rows
      if (cells.every((c) => /^[-:]+$/.test(c))) {
        return ''
      }
      return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`
    })
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // List items
    .replace(/^- (.+)$/gm, '<li>$1</li>')

  // Wrap table rows in <table>
  html = html.replace(/((?:<tr>.*<\/tr>\n?)+)/g, '<table>$1</table>')
  // Wrap list items in <ul>
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')

  return `<!DOCTYPE html>\n<html><body>\n${html}\n</body></html>`
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

// ---------------------------------------------------------------------------
// DocGenerator
// ---------------------------------------------------------------------------

export class DocGenerator {
  private readonly config: Required<Pick<DocGeneratorConfig, 'format' | 'outputDir'>> & { include?: string[] }

  constructor(config?: DocGeneratorConfig) {
    this.config = {
      format: config?.format ?? 'markdown',
      outputDir: config?.outputDir ?? './docs',
      include: config?.include,
    }
  }

  /**
   * Generate documentation files for the provided context.
   * Returns an array of written file paths.
   */
  async generate(context: DocGeneratorContext): Promise<string[]> {
    const paths: string[] = []
    const ext = this.config.format === 'html' ? '.html' : '.md'

    await mkdir(this.config.outputDir, { recursive: true })

    // Agents
    if (context.agents) {
      for (const agent of context.agents) {
        if (this.config.include && !this.config.include.includes(agent.name)) continue
        const content = renderAgentDoc(agent)
        const filePath = join(this.config.outputDir, `agent-${slugify(agent.name)}${ext}`)
        const output = this.config.format === 'html' ? toHtml(content) : content
        await writeFile(filePath, output, 'utf-8')
        paths.push(filePath)
      }
    }

    // Tools
    if (context.tools) {
      for (const tool of context.tools) {
        if (this.config.include && !this.config.include.includes(tool.name)) continue
        const content = renderToolDoc(tool)
        const filePath = join(this.config.outputDir, `tool-${slugify(tool.name)}${ext}`)
        const output = this.config.format === 'html' ? toHtml(content) : content
        await writeFile(filePath, output, 'utf-8')
        paths.push(filePath)
      }
    }

    // Pipelines
    if (context.pipelines) {
      for (const pipeline of context.pipelines) {
        if (this.config.include && !this.config.include.includes(pipeline.name)) continue
        const content = renderPipelineDoc(pipeline)
        const filePath = join(this.config.outputDir, `pipeline-${slugify(pipeline.name)}${ext}`)
        const output = this.config.format === 'html' ? toHtml(content) : content
        await writeFile(filePath, output, 'utf-8')
        paths.push(filePath)
      }
    }

    return paths
  }
}
