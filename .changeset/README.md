# Changesets

This directory contains changesets for versioning and publishing `@dzupagent/*` packages.

## Adding a changeset

```bash
yarn changeset
```

Select the packages affected, choose the semver bump type, and write a summary.

## Releasing

```bash
# Version all changed packages
yarn changeset version

# Publish to npm
yarn changeset publish
```

The GitHub Actions `publish.yml` workflow runs this automatically on merge to `main`
when changesets are present.
