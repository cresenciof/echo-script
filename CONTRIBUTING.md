# Contributing

Thanks for your interest. This is a small, personal-first project — one maintainer, limited bandwidth — so a little coordination saves us both time.

## Before you start

- For non-trivial changes (new features, refactors, dependency swaps), **open an issue first** describing the problem and the proposed approach. A 5-minute conversation can avoid a 5-hour PR rewrite.
- For typos, doc fixes, and obvious bug fixes, a direct PR is fine.

## Dev environment

See the [README](./README.md#build-from-source-for-developers) for full setup. Short version:

```bash
git clone https://github.com/cresenciof/echo-script.git
cd echo-script
pnpm install
cd python-sidecar && uv sync && cd ..
pnpm tauri dev
```

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/) are required:

- `feat:` — user-visible new behavior
- `fix:` — user-visible bug fix
- `refactor:` — internal change with no behavior delta
- `chore:` — tooling, deps, build, repo housekeeping
- `docs:` — documentation only
- `test:` — adding or refactoring tests
- `perf:` — performance improvement

Scope is optional but appreciated: `fix(sidecar): handle empty stdout line`.

## Pull requests

- Write a clear PR description: what changed, why, and how to test.
- Do **not** submit AI-generated commit messages that describe the diff verbatim. Explain the intent.
- One logical change per PR. Smaller is faster to review.
- Update or add tests for behavior changes.

## Pre-flight checks

Run these before opening a PR — CI will run them too, but local feedback is faster:

```bash
pnpm exec tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
cd python-sidecar && uv run pytest -q
```

## Tone

Be kind. Assume the other person has context you don't. If a review comment feels harsh, ask for clarification before reacting.
