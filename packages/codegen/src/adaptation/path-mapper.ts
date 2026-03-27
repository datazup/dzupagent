/**
 * Maps source file paths to target paths using configurable regex patterns.
 */

interface PathMapping {
  pattern: RegExp
  target: string
}

export class PathMapper {
  private mappings: PathMapping[] = []

  addMapping(pattern: string, target: string): this {
    this.mappings.push({ pattern: new RegExp(pattern), target })
    return this
  }

  map(sourcePath: string): string | null {
    for (const mapping of this.mappings) {
      if (mapping.pattern.test(sourcePath)) {
        return sourcePath.replace(mapping.pattern, mapping.target)
      }
    }
    return null
  }
}
