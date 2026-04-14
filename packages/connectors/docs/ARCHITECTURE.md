# @dzupagent/connectors Architecture

## Purpose
`@dzupagent/connectors` packages external system integrations as LangChain-compatible structured tools. It is the integration edge that converts service APIs into agent-callable tool contracts.

## Main Responsibilities
- Provide ready-to-use connector factories for common integrations.
- Normalize connector outputs into `DynamicStructuredTool[]`.
- Keep connector creation lightweight and composable.
- Offer utility filtering to reduce tool exposure per agent role.

## Module Structure
Top-level modules under `src/`:
- `connector-types.ts`: connector interfaces and shared helper utilities.
- `github/`: GitHub connector factory and related config.
- `http/`: generic HTTP connector.
- `slack/`: Slack connector.
- `database/`: SQL/database connector.
- `index.ts`: package export hub and version constant.

## How It Works
1. Consumer calls connector factory (for example `createGitHubConnector`).
2. Factory builds one or more `DynamicStructuredTool` instances with schemas.
3. Consumer combines tools from one or more connectors.
4. Optional `filterTools()` narrows allowed tool names by role/use case.
5. Resulting tool set is passed to `DzupAgent`.

## Main Features
- Rapid connector bootstrap with minimal integration boilerplate.
- Compatible with existing DzupAgent tool loop and guardrails.
- Connector-level configuration for auth and defaults (repo/base URL/channel, etc.).
- Straightforward tool filtering for principle-of-least-privilege setups.

## Integration Boundaries
- Depends on `@dzupagent/core` types and patterns.
- Exposes tool objects consumed directly by `@dzupagent/agent`.
- Uses peer dependencies (`@langchain/core`, `zod`) for schema/tool typing.

## Extensibility Points
- Add new connector folders following current factory pattern.
- Extend existing connectors with additional tool operations.
- Add connector composition helpers (for policy-based tool bundles).

## Quality and Test Posture
- Includes focused connector tests (GitHub/HTTP/Slack/Database + filtering behavior) for stable adapter contracts.
