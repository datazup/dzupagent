import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { flowArtifacts } from "./drizzle-schema.js";

export interface FlowArtifact {
  artifactRef: string;
  tenantId?: string | null;
  contentDigest: string;
  contentType: string;
  content?: unknown;
  storageUri?: string | null;
  schemaRef?: string | null;
  createdAt: Date;
}

export interface FlowArtifactStore {
  put(artifact: Omit<FlowArtifact, "createdAt">): Promise<FlowArtifact>;
  get(artifactRef: string): Promise<FlowArtifact | undefined>;
  findByDigest(contentDigest: string): Promise<FlowArtifact | undefined>;
}

export class InMemoryFlowArtifactStore implements FlowArtifactStore {
  private readonly store = new Map<string, FlowArtifact>();

  async put(artifact: Omit<FlowArtifact, "createdAt">): Promise<FlowArtifact> {
    const existing = this.store.get(artifact.artifactRef);
    if (existing) {
      if (existing.contentDigest !== artifact.contentDigest) {
        throw new Error(
          `FlowArtifact digest mismatch for ref: ${artifact.artifactRef}`,
        );
      }
      return existing;
    }
    const record: FlowArtifact = { ...artifact, createdAt: new Date() };
    this.store.set(artifact.artifactRef, record);
    return record;
  }

  async get(artifactRef: string): Promise<FlowArtifact | undefined> {
    return this.store.get(artifactRef);
  }

  async findByDigest(contentDigest: string): Promise<FlowArtifact | undefined> {
    for (const artifact of this.store.values()) {
      if (artifact.contentDigest === contentDigest) return artifact;
    }
    return undefined;
  }
}

type DB = PostgresJsDatabase<Record<string, never>>;

interface FlowArtifactRow {
  artifactRef: string;
  tenantId: string;
  contentDigest: string;
  contentType: string;
  content: unknown | null;
  storageUri: string | null;
  schemaRef: string | null;
  createdAt: Date;
}

function rowToArtifact(row: FlowArtifactRow): FlowArtifact {
  return {
    artifactRef: row.artifactRef,
    tenantId: row.tenantId,
    contentDigest: row.contentDigest,
    contentType: row.contentType,
    content: row.content ?? undefined,
    storageUri: row.storageUri,
    schemaRef: row.schemaRef,
    createdAt: row.createdAt,
  };
}

export class PostgresFlowArtifactStore implements FlowArtifactStore {
  constructor(private readonly db: DB) {}

  async put(artifact: Omit<FlowArtifact, "createdAt">): Promise<FlowArtifact> {
    const createdAt = new Date();
    const rows = (await this.db
      .insert(flowArtifacts)
      .values({
        artifactRef: artifact.artifactRef,
        tenantId: artifact.tenantId ?? "default",
        contentDigest: artifact.contentDigest,
        contentType: artifact.contentType,
        content: artifact.content ?? null,
        storageUri: artifact.storageUri ?? null,
        schemaRef: artifact.schemaRef ?? null,
        createdAt,
      })
      .onConflictDoUpdate({
        target: flowArtifacts.artifactRef,
        // No-op update: return the already durable artifact for idempotent puts.
        set: { artifactRef: artifact.artifactRef },
      })
      .returning()) as FlowArtifactRow[];
    const row = rows[0];
    if (!row) throw new Error(`FlowArtifact insert failed: ${artifact.artifactRef}`);
    if (row.contentDigest !== artifact.contentDigest) {
      throw new Error(
        `FlowArtifact digest mismatch for ref: ${artifact.artifactRef}`,
      );
    }
    return rowToArtifact(row);
  }

  async get(artifactRef: string): Promise<FlowArtifact | undefined> {
    const rows = (await this.db
      .select()
      .from(flowArtifacts)
      .where(eq(flowArtifacts.artifactRef, artifactRef))
      .limit(1)) as FlowArtifactRow[];
    const row = rows[0];
    return row ? rowToArtifact(row) : undefined;
  }

  async findByDigest(contentDigest: string): Promise<FlowArtifact | undefined> {
    const rows = (await this.db
      .select()
      .from(flowArtifacts)
      .where(eq(flowArtifacts.contentDigest, contentDigest))
      .limit(1)) as FlowArtifactRow[];
    const row = rows[0];
    return row ? rowToArtifact(row) : undefined;
  }
}
