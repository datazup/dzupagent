# @dzipagent/domain-nl2sql

Specialized NL2SQL (Natural Language to SQL) domain module for DzipAgent.

This package provides a comprehensive set of tools, agent definitions, and workflow patterns for building robust pipelines that translate natural language questions into safe, accurate SQL queries and execute them against your databases.

## Installation

```bash
yarn add @dzipagent/domain-nl2sql
# or
npm install @dzipagent/domain-nl2sql
```

## Key Features

- **Tiered Toolkits**
  - `Core`: 6 essential tools for basic NL2SQL (Retrieval, Pruning, Generation, Safety, Structure, Execution).
  - `Extended`: 10 tools adding relevance classification, ambiguity detection, response synthesis, and confidence scoring.
  - `Full`: 14 tools including entity tracking, model routing, multi-agent generation, and result validation.
- **Specialist Agent Definitions**
  - Pre-configured agent blueprints: `SchemaExpert`, `SQLWriter`, and `QueryExecutor`.
- **Workflow Patterns**
  - `DETERMINISTIC_WORKFLOW`: A structured, step-by-step pipeline.
  - `SUPERVISOR_WORKFLOW`: An agentic, supervisor-led approach.
- **Embedding Pipeline**
  - Tools for embedding table schemas and SQL examples for vector-based retrieval.
- **Streaming Support**
  - Event-driven pipeline execution with detailed stage and result streaming.
- **Safety & Validation**
  - Built-in SQL safety checks, structural validation, and result verification.

## Quick Start

```ts
import { 
  createFullToolkit, 
  DETERMINISTIC_WORKFLOW 
} from '@dzipagent/domain-nl2sql'

// 1. Configure the toolkit
const toolkitConfig = {
  chatModel: myChatModel,
  vectorStore: myVectorStore,
  sqlConnector: mySqlConnector,
  tenantId: 'tenant-1',
  dataSourceId: 'ds-1',
  dialect: 'postgresql',
}

// 2. Create the full set of tools
const tools = createFullToolkit(toolkitConfig)

// 3. Use in your DzipAgent or workflow
// (See DzipAgent documentation for tool registration)
```

## Usage Examples

### 1) Embedding your Schema

Prepare your database for natural language queries by embedding your table schemas.

```ts
import { SchemaEmbeddingPipeline } from '@dzipagent/domain-nl2sql'

const pipeline = new SchemaEmbeddingPipeline({
  vectorStore: myVectorStore,
  embeddingProvider: myEmbedder,
})

await pipeline.run({
  tenantId: 'tenant-1',
  dataSourceId: 'ds-1',
  databaseSchema: {
    tables: [
      {
        tableName: 'users',
        schemaName: 'public',
        columns: [
          { 
            columnName: 'id', 
            dataType: 'integer', 
            isNullable: false, 
            isPrimaryKey: true, 
            defaultValue: null, 
            description: 'Primary key', 
            maxLength: null 
          },
          { 
            columnName: 'email', 
            dataType: 'varchar', 
            isNullable: false, 
            isPrimaryKey: false, 
            defaultValue: null, 
            description: 'User email', 
            maxLength: 255 
          }
        ],
        foreignKeys: [],
        rowCountEstimate: 1000,
        description: 'Stores user profile information',
        sampleValues: {}
      }
    ]
  }
})
```

### 2) Creating Specialist Agents

Use the built-in definitions to quickly spin up specialized agents.

```ts
import { createSchemaExpertDef, createSQLWriterDef } from '@dzipagent/domain-nl2sql'
import { DzipAgent } from '@dzipagent/agent'

const config = { /* toolkit config */ }

const schemaExpert = new DzipAgent(createSchemaExpertDef(config))
const sqlWriter = new DzipAgent(createSQLWriterDef(config))
```

### 3) Listening to Pipeline Events

Track the progress of your NL2SQL pipeline in real-time.

```ts
import { PipelineEventEmitter } from '@dzipagent/domain-nl2sql'

const events = new PipelineEventEmitter()

events.on('stage:start', (ev) => {
  console.log(`Starting stage: ${ev.stage}`)
})

events.on('sql:chunk', (ev) => {
  process.stdout.write(ev.chunk)
})

events.on('result:row', (ev) => {
  console.log('Received row:', ev.row)
})
```

## API Reference

### Toolkit Factories
- `createCoreToolkit(config)` — Returns 6 core tools.
- `createExtendedToolkit(config)` — Returns 10 tools.
- `createFullToolkit(config)` — Returns all 14 specialized tools.

### Specialist Agents
- `createSchemaExpertDef(config)`
- `createSQLWriterDef(config)`
- `createQueryExecutorDef(config)`

### Workflows
- `DETERMINISTIC_WORKFLOW`
- `SUPERVISOR_WORKFLOW`

### Embedding
- `SchemaEmbeddingPipeline`
- `embedSQLExamples(input, deps)`

## License

MIT
