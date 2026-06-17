export interface FlowArtifact {
  artifactRef: string;
  contentDigest: string;
  contentType: string;
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
