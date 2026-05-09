# Publish Runbook

The `Publish` workflow publishes all unpublished `@dzupagent/*` workspace packages and `create-dzupagent` from pushes to `main`.

## Workflow Gates

The workflow currently runs these repo-side gates before invoking Changesets:

1. `yarn install --frozen-lockfile`
2. `yarn build --filter=@dzupagent/scraper... --concurrency=4 --output-logs=full`
3. `yarn build --concurrency=4 --output-logs=full`
4. `yarn check:publish-metadata`
5. Report whether the workflow will use `NPM_TOKEN` or npm trusted publishing.
6. `yarn release:publish`

`yarn check:publish-metadata` verifies that every publishable package points at this GitHub repository through `repository.url`, records its monorepo `repository.directory`, and keeps CLI `bin` targets in the npm-normalized form used by current npm publish.

## npm Authentication

The preferred path is npm trusted publishing. Configure each publishable package on npm with:

- Organization or user: `datazup`
- Repository: `dzupagent`
- Workflow filename: `publish.yml`
- Environment name: unset unless the workflow is changed to use a GitHub Environment

The workflow already grants `id-token: write`, uses Node 24, configures `registry-url: https://registry.npmjs.org`, and uses Node 24-compatible official GitHub actions.

Fallback path: add a GitHub Actions secret named `NPM_TOKEN` with publish rights for the package set. The workflow maps that secret to `NODE_AUTH_TOKEN` for `changesets/action`.

## Expected Failure Mode

If neither trusted publishing nor `NPM_TOKEN` is configured, the build gates can pass and the final Changesets step will fail with `ENEEDAUTH`. In the log, `NODE_AUTH_TOKEN:` will be empty and Changesets will say it is attempting npm trusted publishing.

After npm auth is configured, rerun the latest failed `Publish` workflow. If a new failure appears after authentication succeeds, treat it as the next packaging issue and keep it separate from Verify Strict or Coverage failures.
