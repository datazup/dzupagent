declare module 'web-tree-sitter' {
  class Parser {
    static init(options?: Record<string, unknown>): Promise<void>;
    setLanguage(lang: unknown): void;
    parse(input: string): Parser.Tree;
    delete(): void;
    static Language: {
      load(path: string): Promise<unknown>;
    };
  }

  namespace Parser {
    interface Tree {
      rootNode: SyntaxNode;
      delete(): void;
    }

    interface SyntaxNode {
      type: string;
      text: string;
      startPosition: { row: number; column: number };
      endPosition: { row: number; column: number };
      startIndex: number;
      endIndex: number;
      children: SyntaxNode[];
      childCount: number;
      namedChildren: SyntaxNode[];
      namedChildCount: number;
      parent: SyntaxNode | null;
      firstChild: SyntaxNode | null;
      lastChild: SyntaxNode | null;
      nextSibling: SyntaxNode | null;
      previousSibling: SyntaxNode | null;
      isNamed: boolean;
      childForFieldName(name: string): SyntaxNode | null;
    }
  }

  export default Parser;
}
