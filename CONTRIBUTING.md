# Contributing

Thanks for contributing to `cloudflare-preview`.

## Setup

Node ≥ 20, [actionlint](https://github.com/rhysd/actionlint) and [shellcheck](https://www.shellcheck.net/) from your package manager. There is no install step. The actions use only Node built-ins at runtime, and the tests use `node:test`.

## Develop

```sh
bash scripts/verify.sh     # actionlint + shellcheck + node --test (what CI runs)
node --test test/*.test.mjs
```

- **Add a test** for any new behaviour. Use `test/unit.test.mjs` for pure functions and `test/scripts.test.mjs` for an entry script end to end (it has a fake wrangler and a fake GitHub API).
- A change to how wrangler output is read needs a fixture in wrangler's exact format (from a CI log or a file wrangler wrote), with neutral values. Describe it in the header of `unit.test.mjs`.
- Changed an input or output? Run `node scripts/reference.mjs --write` to regenerate the README reference. A test fails until you do.
- Tests never call Cloudflare. Use the fake wrangler in `test/helpers/`, not a real one: a logged-in wrangler on your machine would act on your account.
- Keep the invariants in [AGENTS.md](AGENTS.md#key-invariants). The two that matter most: no `${{ }}` inside `run:`, and redact before posting.

## Pull requests

- **The title must be a [Conventional Commit](https://www.conventionalcommits.org/):** `<type>(scope): subject`, at most 72 characters, lowercase subject, no trailing period. Types: `feat fix docs refactor test chore ci deps build perf revert style`. A breaking change (an input removed or renamed, a default changed in a way users would notice) uses `feat!:`. Check the title with `scripts/lint-pr-title.sh "<title>"`.
- Update the `action.yml` descriptions and the README in the same PR as the change.
- PRs merge by **squash**. Don't hand-edit `CHANGELOG.md`; release-please writes it.
