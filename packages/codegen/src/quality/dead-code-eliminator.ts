export interface DeadCodeSourceFile {
  path: string
  source: string
}

export type DeadCodeSymbolKind = 'function' | 'class' | 'variable'

export interface DeadCodeReference {
  filePath: string
  line?: number
  column?: number
  text?: string
}

export interface DeadCodeSymbol {
  kind: DeadCodeSymbolKind
  name: string
  filePath: string
  reason: string
  removable: boolean
  references: DeadCodeReference[]
}

export interface DeadCodePatch {
  filePath: string
  start: number
  end: number
  replacement: string
  symbolName: string
}

export interface DeadCodeAnalysisResult {
  unused: DeadCodeSymbol[]
  removable: DeadCodeSymbol[]
  retained: DeadCodeSymbol[]
  patches: DeadCodePatch[]
  warnings: string[]
}

export interface DeadCodeEliminatorOptions {
  entrypoints?: string[]
  preserveExports?: boolean
}

export class DeadCodeEliminator {
  constructor(public readonly options: DeadCodeEliminatorOptions = {}) {}

  async analyze(_files: DeadCodeSourceFile[]): Promise<DeadCodeAnalysisResult> {
    throw new Error('DeadCodeEliminator.analyze is not implemented')
  }

  createRemovalPlan(_result: DeadCodeAnalysisResult): DeadCodePatch[] {
    throw new Error('DeadCodeEliminator.createRemovalPlan is not implemented')
  }

  applyRemovals(_files: DeadCodeSourceFile[], _patches: DeadCodePatch[]): DeadCodeSourceFile[] {
    throw new Error('DeadCodeEliminator.applyRemovals is not implemented')
  }
}
