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
- Tests live under `test/*.test.js` and run with `node --test`.
- Use conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`).
- Local Moonshine sidecar binaries under `packages/*/bin/` are generated artifacts (built by `npm run build:moonshine-sidecars` on macOS). Don't check them in.

## Questions

Open an issue.
