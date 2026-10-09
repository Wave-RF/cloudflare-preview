# Releasing

## The model

- **Versions come from [release-please](https://github.com/googleapis/release-please)** and Conventional Commits:
  - `fix:` → patch
  - `feat:` → minor
  - `feat!:` or a `BREAKING CHANGE:` footer → major

  `release-please-config.json` uses the `simple` release type, tags `vX.Y.Z`, and starts at `1.0.0` (`initial-version`).
- **The moving major tag.** After each release, `.github/workflows/release.yml` force-moves `vMAJOR` (e.g. `v1`) to the release commit. That is what `uses: Wave-RF/cloudflare-preview@v1` resolves to. Exact tags (`v1.2.3`) are never moved.
- **The reusable workflow pins its own actions.** `.github/workflows/preview.yml` uses `Wave-RF/cloudflare-preview@vX.Y.Z` on lines marked `# x-release-please-version`. release-please rewrites those lines in each release PR, so the workflow at `vX.Y.Z` runs the actions at `vX.Y.Z`.

  A consequence: on `main` between releases, `preview.yml` points at the **last** release, not at `main`. CI exercises the actions directly (`uses: ./upload` and the others) to cover that gap.
- **No secrets.** release-please uses `GITHUB_TOKEN` (`contents: write`, `pull-requests: write`).

## One-time setup (not done yet)

None of this exists until someone with admin rights on the org does it.

1. Create the public repo `Wave-RF/cloudflare-preview` and push `main`.
2. Repository settings:
   - squash merges only, with the PR title as the commit subject;
   - auto-delete head branches;
   - a branch ruleset on `main`: PR required, required checks `lint`, `test (node 20)`, `test (node 22)`, `test (node 24)`, `smoke` and `pr-title`, no force-push, no deletion.
3. Optional: protect `v*.*.*` tags with a tag ruleset (no update, no deletion). Leave `v1` (the moving tag) updatable by the release workflow.
4. Optional: enable GitHub's **immutable releases** for the repo, so a published `vX.Y.Z` can't be altered.

On a `GITHUB_TOKEN`-opened release PR, `pull_request` workflows don't run, so its required checks never report. Two ways to merge it:

- merge it with an admin bypass;
- or add a fine-grained PAT as `RELEASE_PLEASE_TOKEN` (Contents and Pull requests: write) and pass it as `token:` in `release.yml`.

## Cutting a release

1. Land Conventional-Commit PRs on `main`.
2. release-please keeps a release PR (`chore(main): release X.Y.Z`) up to date.
3. Merge it. That creates the tag `vX.Y.Z` and the GitHub Release, and the same run moves `vX`.

To force a version, land a commit whose body contains `Release-As: X.Y.Z`.

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
