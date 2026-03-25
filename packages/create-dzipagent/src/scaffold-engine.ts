import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { ScaffoldOptions, ScaffoldResult } from './types.js'
import { getTemplate } from './templates/index.js'
import { renderTemplate } from './template-renderer.js'

/**
 * ScaffoldEngine generates project files from a template manifest.
 *
 * It resolves a template by id, renders each file with variable
 * interpolation, and writes them to the output directory.
 */
export class ScaffoldEngine {
  /**
   * Generate a new project from a template manifest.
   *
   * Creates the project directory, renders all template files with
   * variable substitution, and returns a list of created files.
   */
  async generate(options: ScaffoldOptions): Promise<ScaffoldResult> {
    const { projectName, template, outputDir } = options

    const manifest = getTemplate(template)
    const projectDir = join(outputDir, projectName)

    const variables: Record<string, string> = {
      projectName,
      template,
    }

    const filesCreated: string[] = []

    for (const file of manifest.files) {
      const renderedContent = renderTemplate(file.templateContent, variables)
      const filePath = join(projectDir, file.path)
      const fileDir = dirname(filePath)

      await mkdir(fileDir, { recursive: true })
      await writeFile(filePath, renderedContent, 'utf-8')
      filesCreated.push(file.path)
    }

    return {
      filesCreated,
      projectDir,
      template,
    }
  }
}
