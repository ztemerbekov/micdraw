# Contributing

Thanks for wanting to contribute.

## Workflow

1. Fork the repo and clone your fork.
2. Create a branch and make your changes.
3. Run `npm run typecheck` and `npm test`.
4. Open a pull request against `main`. CI runs the same checks.

For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Repo conventions

- Node 24+, plain JavaScript, ESM-only. See `AGENTS.md` for agent instructions and architecture notes.
- Tests live under `test/*.test.js` and run with `npm test`; shared helpers live in `test/helpers/`.
- Add user-facing changes to `## Unreleased` in `CHANGELOG.md`; that section becomes the release notes.
- Local Moonshine sidecar binaries under `packages/*/bin/` are generated artifacts (built by `npm run build:moonshine-sidecars` on macOS). Don't check them in.

## Releases

Maintainers release in two steps:

1. A pull request runs `npm version X.Y.Z --no-git-tag-version` and renames `## Unreleased` in `CHANGELOG.md` to `## X.Y.Z (YYYY-MM-DD)`.
2. After it merges, publish a GitHub Release with the tag `vX.Y.Z` on `main` and that changelog section as its notes. `.github/workflows/release.yml` checks the tag against `package.json`, runs the checks and publishes the package to npm. Then it installs the published version with `npx` on Linux, macOS and Windows and runs `micdraw --help` (`.github/workflows/check-published-package.yml`).

### Moonshine sidecars

The macOS Moonshine sidecars are separate npm packages, `@micdraw/moonshine-darwin-arm64` and `@micdraw/moonshine-darwin-x64`, with one version of their own:

1. A pull request sets the new version in both `packages/moonshine-darwin-*/package.json`.
2. After it merges, run the Moonshine sidecars workflow on `main` (Actions → Moonshine sidecars → Run workflow). `.github/workflows/moonshine-sidecars.yml` builds both binaries, checks that each loads the medium English model, and publishes the packages whose version npm does not have yet.
3. A pull request points `optionalDependencies` in `package.json` at the new version. npm can lock only a version it already serves, so this comes after the publish.

## Questions

Open an issue.
