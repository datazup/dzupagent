# Agent Memory System

The `dzipagent` memory system provides a multi-layered, persistent, and intelligent storage for autonomous agents. It goes beyond simple key-value storage by incorporating semantic search, automatic consolidation, and forgetting mechanisms.

## Overview

Memory is organized into **namespaces**, which are scoped partitions for different types of information (e.g., `user_preferences`, `past_lessons`, `task_history`).

```ts
const memory = new MemoryService({
  namespaces: [
    { name: 'preferences', scopeKeys: ['userId'] },
    { name: 'lessons', searchable: true, scopeKeys: ['agentId'] }
  ]
});
```

## Key Features

### 1. Scoped Partitions

Memory is always scoped by keys like `tenantId`, `userId`, or `agentId`. This ensures data isolation and easy retrieval of relevant context.

### 2. Semantic Search

Namespaces marked as `searchable` are backed by a vector store (e.g., Postgres with `pgvector` or Qdrant). This allows agents to retrieve memories based on semantic similarity to the current task rather than just exact key matches.

### 3. Semantic Consolidation

Over time, an agent's memory can become cluttered with redundant or slightly conflicting information. The `SemanticConsolidator` uses an LLM to "dream" and organize memory by:

- **Merging**: Combining multiple related memories into a single, richer record.
- **Updating**: Superseding old information with newer, more accurate data.
- **Pruning**: Removing redundant or obsolete records.
- **Flagging Contradictions**: Identifying when two memories contain opposing facts for human review.

### 4. Memory Decay (Ebbinghaus Forgetting Curve)

To mimic human-like cognitive load management, `dzipagent` supports Ebbinghaus-style decay. Memories have a "strength" that decreases over time. Frequently accessed memories are "reinforced," while unused memories eventually fall below a threshold and can be pruned.

### 5. Sanitization and Privacy

The `MemorySanitizer` can be configured to automatically strip PII (Personally Identifiable Information) or other sensitive data before it is stored in the persistent backend.

## Usage Example

```ts
// Store a new memory
await agent.memory.store('lessons', {
  text: 'The user prefers concise summaries for financial reports.',
  tags: ['preference', 'formatting']
});

// Retrieve relevant context during generation
const context = await agent.memory.search('lessons', 'How should I format the report?');
```

## Components

- **`MemoryService`**: The main entry point for storing and retrieving memories.
- **`SemanticConsolidator`**: Handles background optimization of memory records.
- **`DecayEngine`**: Manages the reinforcement and pruning of memories based on access patterns.
- **`StoreFactory`**: Creates adapters for different storage backends (In-Memory, Postgres, Redis).

## Best Practices

1. **Use Specific Namespaces**: Don't dump everything into one namespace. Group by purpose (e.g., `episodes`, `knowledge`, `feedback`).
2. **Schedule Consolidation**: Run semantic consolidation during low-traffic periods to keep the memory high-quality and compact.
3. **Set TTLs for Short-term Memory**: Use `ttlMs` for transient data that doesn't need long-term persistence.
