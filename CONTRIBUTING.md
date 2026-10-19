# Contributing to Pixebot Browser

This is a private fork of AionUi. Humans and AI agents follow the same rules; [AGENTS.md](AGENTS.md) has the full code conventions.

## Commits and PRs

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages and PR titles:

```text
<type>(<scope>): <subject>
```

Allowed types: `feat`, `fix`, `perf`, `refactor`, `docs`, `style`, `chore`, `test`, `ci`, `build`.

Do not add AI signatures (`Co-Authored-By`, "Generated with", etc.).

## Before you push

Push with `just push`, never plain `git push`. It runs lint, format check, typecheck, i18n check and tests, then pushes:

```bash
just push                          # same checks, then git push
just push -u origin feat/branch    # extra git push args
```

You can run the checks by hand:

```bash
bun run lint
bun run format:check
bunx tsc --noEmit
bun run i18n:types && node scripts/check-i18n.js   # when touching renderer, locales or i18n config
bun run test
```

Judge lint by exit code: the project carries many pre-existing warnings.

## Rules in short

- Process boundaries: `process/` has no DOM APIs, `renderer/` has no Node.js APIs; cross them only through the preload IPC bridge.
- User-facing text uses i18n keys in all locales; no hardcoded strings.
- New or changed behavior gets focused tests.
- `docs/superpowers/` is gitignored local working space; never commit it.
