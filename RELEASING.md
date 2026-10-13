# Releasing

**Releases happen on merge to `main`**, driven by [semantic-release](https://semantic-release.org). There is no release PR and nothing to click.

## The model

- **Every squash-merge to `main` either releases or doesn't, decided by its Conventional-Commit title.** Squash merges use the PR title as the commit subject and the required `pr-title` check validates it, so the title is the release decision.
- **The git tag is the version.** `vX.Y.Z` tags are created by the release run. `package.json` stays at the placeholder `0.0.0-development` (it is private dev tooling; the field is kept, not removed, so tools that read it don't choke). Nothing is committed back to `main` (it is protected), so there is no changelog commit.
- **GitHub Releases replace a `CHANGELOG.md`.** Notes are generated per release.
- **The moving major tag.** After a release, `release.yml` force-moves `v<major>` (e.g. `v1`) to the released commit and pushes it with `GITHUB_TOKEN`. That is what `uses: Wave-RF/cloudflare-preview@v1` resolves. Exact tags (`v1.2.3`) are never moved. The version comes from semantic-release's programmatic API (`scripts/release.mjs` writes `released`, `version`, `tag`, `major`, `sha` to `$GITHUB_OUTPUT`), not from parsing logs.
- **No secrets.** `GITHUB_TOKEN` only (`contents`, `issues`, `pull-requests`: write). No npm publish, so no `id-token`.
- **One channel.** `main` is always the latest release.

### The reusable workflow runs the actions at `@v1`

`.github/workflows/preview.yml` uses `Wave-RF/cloudflare-preview@v1`, `.../deploy@v1` and `.../deployment@v1`: the **moving** major tag.

- It can't use `./upload` and friends. GitHub's docs state the `./` form "resolves against the runner's workspace rather than the repository of the running workflow" ([workflow syntax, `jobs.<job_id>.steps[*].uses`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)), and in a reusable workflow the workspace is the **caller's** checkout.
- It can't pin each release's own `vX.Y.Z` either: the old setup had release-please rewrite those lines in a release PR, but semantic-release doesn't commit back to protected `main`.

**Trade-off:** a caller that pins the reusable workflow at a SHA or an exact tag still gets whatever `v1` points at *now* for the actions, so the workflow file and the actions can drift by a minor/patch release. Within a major they are compatible by contract; a breaking change moves to `v2`, and workflow callers at `v1` keep `v1` actions. On `main` between releases, `preview.yml` also runs the last released actions, not `main`'s; CI exercises `main`'s actions directly (`uses: ./upload` and the others). Dependabot ignores these references.

(The docs page also describes a `$/path` form that resolves to the called workflow's own repository at its own commit, which would remove the drift. It was seen only through a summarising fetch, is not supported by the pinned actionlint, and is **unverified** here. Revisit when actionlint supports it.)

### What releases what

| PR / commit title | Release |
| ----------------- | ------- |
| `fix:` `perf:` `revert:` | patch |
| `feat:` | minor |
| `feat!:` / any type with `!`, or a `BREAKING CHANGE:` footer | **major** |
| `deps:` `ci:` `chore:` `docs:` `test:` `refactor:` `build:` `style:` | none |

- There is no 0.x shielding: the first breaking change after 1.0.0 releases `2.0.0`. Mark a break deliberately. A breaking marker wins over a "no release" type (`refactor!:` releases a major).
- Only the squash subject matters; bodies are read only for `BREAKING CHANGE:`.
- To force a release with no other change, merge any `fix:` PR. There is no `Release-As:` footer.
- A major bump creates the new `v2` tag; the old `v1` is left where it was.

### The first release

There are no tags yet, so the first push to `main` after the switch analyses the whole history. It contains `feat:` commits and is not breaking, so semantic-release's first-release rule yields **1.0.0** (it always starts at 1.0.0), and `v1` is created at the same commit.

## What a release run does

`release.yml` (push to `main`, serialised by a `release` concurrency group, never cancelled):

1. checkout with full history and tags, `pnpm install`, `node --test`, `check:release` (a red `main` never releases);
2. `node scripts/release.mjs` runs semantic-release: finds the latest `vX.Y.Z` tag reachable from `main`, analyses commits since it, exits quietly if none are releasable, otherwise pushes the tag, creates the GitHub Release with generated notes and comments "released in vX.Y.Z" on the issues and PRs involved;
3. if it released, the `Move the major tag` step runs `git tag -f v<major> <sha>` and force-pushes it.

The release tooling is pinned to **exact** versions in `devDependencies` (`semantic-release`, the two plugins, and `conventional-changelog-conventionalcommits`), so a release never fetches an unpinned latest. The preset must stay on a major compatible with the `conventional-changelog-writer` that the notes plugin bundles: with semantic-release 25 that is preset **9.x** (10.x fails with "requires conventional-changelog-writer@9"). Bump them together. CI's `release-config` job (`pnpm run check:release`) fails a PR that breaks the pair.

### Failures and re-runs

- A failed release opens a **"The automated release is failing"** issue with the error; it closes itself on the next success.
- **Failure before the tag is pushed:** fix and re-run the workflow run. Nothing was released.
- **Failure after `vX.Y.Z` was pushed but before the GitHub Release exists:** a re-run sees "no release". Delete the tag so it is re-derived, then re-run: `git push --delete origin vX.Y.Z && gh run rerun <run-id>`.
- **Release succeeded but the `v1` move failed:** don't re-run (a re-run sees "no release"). Move it by hand: `git tag -f -a v1 -m v1 vX.Y.Z^{commit} && git push -f origin refs/tags/v1`.
- Roll back a bad release: ship a `fix:`, and, if `v1` must go back, force-move it to the previous good `vX.Y.Z` as above. Prefer fixing forward.

### Checking what the next merge would do (dry run, no writes)

```sh
pnpm install
node scripts/release.mjs --dry-run
```

Run it from a clone whose `main` has a reachable remote. It uses the commit analyzer and notes generator with the exact options in `.releaserc.json`, `dryRun: true`, and no `github` plugin, so nothing is tagged or released. It prints the version and the notes.

## One-time setup

None of this exists until someone with admin rights on the org does it.

1. Create the public repo `Wave-RF/cloudflare-preview` and push `main`.
2. Repository settings:
   - squash merges only, with the PR title as the commit subject;
   - auto-delete head branches;
   - a branch ruleset on `main`: PR required, required checks `lint`, `test (node 20)`, `test (node 22)`, `test (node 24)`, `smoke`, `release-config` and `pr-title`, no force-push, no deletion. `main` stays protected, which is why the release never commits to it.
3. Optional: protect `v*.*.*` tags with a tag ruleset (no update, no deletion). **Leave `v1` (the moving tag) updatable** by `GITHUB_TOKEN`; a ruleset that blocks tag updates generally will break the move.
4. Optional: enable GitHub's **immutable releases**, so a published `vX.Y.Z` can't be altered.
5. If a branch ruleset blocks `github-actions[bot]` from creating tags, allow it; the release pushes `vX.Y.Z` and `v1` with `GITHUB_TOKEN`. Tag pushes made with `GITHUB_TOKEN` don't trigger other workflows; nothing here depends on that.

## GitHub Marketplace

A listing is **not** a goal. If one is wanted later:

- Marketplace requires a public repo with a **single `action.yml` at the root**. Actions in subfolders are allowed, but are not listed.
- The current docs, checked 2026-10-09, no longer state the old rule that the repo must contain **no workflow files**. Community reports still mention it.

The root action here is the one that would be listed. Try the publish flow before restructuring anything for it.

## Verifying a release

```sh
git ls-remote --tags origin 'v1*'          # v1 and v1.x.y point at the same commit
gh release view v1.x.y
```

## Troubleshooting

- **A merge didn't release.** Expected if its title was `deps`/`ci`/`chore`/`docs`/`test`/`refactor`/`build`/`style`. The run log says "no releasable commits". Retitle future PRs, or merge a `fix:`.
- **Release notes show the wrong range.** semantic-release uses the latest `vX.Y.Z` tag reachable from `main`. Don't hand-create `vX.Y.Z` tags (the moving `v1` is ignored: it isn't valid semver).

## A merge that didn't release

GitHub starts no workflow for a push made with the built-in `GITHUB_TOKEN` (for example a bot that merges PRs with it; this repo has none today, but sibling repos' Dependabot auto-merge does). So:

- such a merge runs no release job, and
- if it lands while the release job for an earlier `fix:`/`feat:` merge is starting, that job logs **"The local branch main is behind the remote one, therefore a new version won't be published"** and exits green — and no later run comes to pick the commit up.

Either way, run the release by hand from `main`:

```bash
gh workflow run release.yml -R Wave-RF/cloudflare-preview --ref main
```

It is safe to run any time: semantic-release re-reads every commit since the last `vX.Y.Z` tag and releases only if one of them warrants it.
