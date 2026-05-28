import type { KnowledgeEnvelope, KnowledgeKind } from "./fleet-types.js";

export interface KnowledgeRef {
  id: string;
  version: number;
}

export interface KnowledgeFilter {
  scope?: string;
  kind?: KnowledgeKind;
  key?: string;
  repo?: string | null;
}

export type Unsubscribe = () => void;

export interface KnowledgeStore {
  append(scope: string, entry: KnowledgeEnvelope): Promise<KnowledgeRef>;
  read<T extends KnowledgeEnvelope = KnowledgeEnvelope>(
    scope: string,
    kind: KnowledgeKind,
    key: string
  ): Promise<T | null>;
  query(filter: KnowledgeFilter): AsyncIterable<KnowledgeEnvelope>;
  subscribe(
    filter: KnowledgeFilter,
    handler: (e: KnowledgeEnvelope) => void
  ): Unsubscribe;
}

export class KnowledgeCollisionError extends Error {
  constructor(
    public readonly scope: string,
    public readonly kind: KnowledgeKind,
    public readonly key: string,
    public readonly version: number
  ) {
    super(`Knowledge collision at ${scope}/${kind}/${key}@${version}`);
    this.name = "KnowledgeCollisionError";
  }
}
