# cloudflare-preview

GitHub Actions for Cloudflare Worker previews built in GitHub Actions:

- uploads a preview version of your Worker (`wrangler versions upload --preview-alias pr-N`) with retries;
- keeps **one** sticky PR comment with the stable per-PR URL and this commit's own URL;
- records a **GitHub Deployment**, so the PR shows a "View deployment" button;
- deploys to production (`wrangler deploy`) on the default branch;
- cleans up when the PR closes.

> [!IMPORTANT]
> **If Cloudflare [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) can build your site, use it.**
> It already gives you preview URLs and PR comments, with no workflow code to maintain.
>
> This repo is for when the build **must** run in GitHub Actions because Workers Builds can't run it. For example:
>
> - the build needs **headless Chromium** (e.g. rendering Mermaid diagrams to SVG at build time);
> - it needs **secrets injected from a secrets manager**;
> - it must run on **self-hosted runners**;
> - it has a **mock build mode** for previews;
> - the artifact is **built in another job**.

## Quick start

**1. Prepare Cloudflare (once):**

- **Deploy the Worker once.** Run `wrangler deploy`. `versions upload` refuses a Worker that has never been deployed.
- **Turn on preview URLs.** Set `"preview_urls": true` in the wrangler config. When it is unset, preview URLs follow `workers_dev`.
- **Create an API token.** The **Edit Cloudflare Workers** token template works.
- **Add repository secrets.** Store the token as `CLOUDFLARE_API_TOKEN` and your account id as `CLOUDFLARE_ACCOUNT_ID`.
- **Install wrangler in the project** as a devDependency. This action never downloads it (see [How wrangler is found](#how-wrangler-is-found)).

**2. Add a workflow:**

```yaml
# .github/workflows/preview.yml
name: Preview
on: pull_request
permissions:
  contents: read
  pull-requests: write
  deployments: write
jobs:
  preview:
    # Fork PRs and Dependabot runs get no repository secrets: skip them.
    if: ${{ github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          persist-credentials: false
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with: { node-version: "22", cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - uses: Wave-RF/cloudflare-preview@v1 # or pin a commit SHA
        with:
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          cloudflare-account-id: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

That's all. The next push to a PR gets a comment, a Deployment, and a job summary line.

More complete workflows are in [`examples/`](examples/):

| Example | Shows |
| --- | --- |
| [`simple.yml`](examples/simple.yml) | Build and preview in one job (the quick start). |
| [`trusted-checkout.yml`](examples/trusted-checkout.yml) | **Recommended when the token matters.** The build runs the PR's code without secrets. The job that holds the token runs only default-branch code. Includes the production deploy. |
| [`composite-pieces.yml`](examples/composite-pieces.yml) | The pieces wired separately: secrets injected by a wrapper script, a mock build mode, two apps on one PR, and a custom comment template. |
| [`reusable.yml`](examples/reusable.yml) | Calling the reusable workflow: build, preview, production and cleanup with no steps of your own. |
| [`sticky-comment.yml`](examples/sticky-comment.yml) | The comment action for something that is not a preview. |

## The two URLs

The comment shows two links on purpose:

```markdown
### docs preview

✅ **Live:** https://pr-12-docs.example.workers.dev (follows this PR)
**This commit** ([`b41c0de`](…)): https://0b9e8d7c-docs.example.workers.dev (exactly this commit; open it if the link above looks stale)

- **Commit:** [`b41c0de`](…) feat: add the glossary
- **Author:** [@ada](…), [@cy](…)
- **Committed:** 2026-10-09 13:01 UTC
- **Uploaded:** 2026-10-09 13:04 UTC ([run](…))

▸ Earlier commits (3)          ← collapsed table: each earlier commit, its own URL, when
```

- **Alias URL** (`<alias>-<worker>.<subdomain>.workers.dev`, alias `pr-N` by default): the same for the whole PR, and always serves the latest successful upload. It is the link to share, and the GitHub Deployment's URL.
- **Version URL** (`<first 8 of the version id>-<worker>.<subdomain>.workers.dev`): belongs to one upload and never changes, so it shows exactly that commit. Use it when a cache serves a stale page on the alias.

When an upload fails, the comment says so and names the commit the alias still serves. It never keeps saying "live" about an older commit. Earlier commits' version URLs are kept in a collapsed history, trimmed to `history-limit`.

## How wrangler is found

When `wrangler-command` is empty (the default), the action runs **the wrangler your repo already has installed**, through your own package manager. It **never downloads** wrangler.

It walks up from `working-directory` to the repository root. The first directory with a lockfile decides the command:

| Lockfile | Command | Why it can't download |
| --- | --- | --- |
| `pnpm-lock.yaml` | `pnpm exec wrangler` | Runs `node_modules/.bin`, including a workspace root's, then `PATH`. It never fetches. |
| `yarn.lock` | `yarn wrangler` | Runs a dependency's binary. Only `yarn dlx` downloads. |
| `bun.lock`, `bun.lockb` | `bunx --no-install wrangler` | Plain `bunx` installs a missing package into a global cache; `--no-install` stops it. |
| `package-lock.json`, `npm-shrinkwrap.json`, or none | `<dir>/node_modules/.bin/wrangler`, found by walking up | Run directly. `npx --no` still queries the registry, and can run a copy from npm's npx cache instead of the repo's install. |

- **Workspaces:** a pnpm workspace with the lockfile at the repo root and `working-directory: packages/site` resolves to `pnpm exec wrangler`, and pnpm finds wrangler in the package's or the workspace root's `node_modules/.bin`.
- **The repository root** is `GITHUB_WORKSPACE`, or the nearest directory with `.git`. The search never looks above it.
- **No local wrangler:** with npm (or no lockfile), the step fails and tells you to add wrangler as a devDependency. It does not silently download one.
- **Override:** set `wrangler-command` to anything. It is split like a shell would split it, but never run through a shell, so it can't expand variables or run substitutions. Examples:
  - `wrangler-command: pnpm --filter site exec wrangler`
  - `wrangler-command: ./scripts/with-secrets.sh pnpm exec wrangler`, for a wrapper that injects credentials. Pair it with `missing-secrets: ignore`.
- **Windows runners:** the auto-detected commands are untested there (`pnpm`, `yarn` and `bunx` are `.cmd` shims). Set `wrangler-command: node node_modules/wrangler/bin/wrangler.js`.

## The pieces

Every piece is a **composite action**. It runs on your runner, in your job and your workspace. Each one is a small Node script with no npm dependencies. It needs Node ≥ 20 on `PATH`, which wrangler needs anyway. Nothing is bundled and there is no `dist/`.

| Action | Does | Minimal `permissions:` |
| --- | --- | --- |
| `Wave-RF/cloudflare-preview@v1` | Upload, Deployment and preview comment in one step. | `contents: read`, `pull-requests: write`, `deployments: write` (drop `deployments` with `deployment: false`, and `pull-requests` with `comment: false`) |
| `…/upload@v1` | `wrangler versions upload` with retries and a per-PR alias. | none (Cloudflare token only) |
| `…/deploy@v1` | `wrangler deploy` to production. | none; `deployments: write` with `github-deployment: true` |
| `…/deployment@v1` | A GitHub Deployment and its status: create, start then finish, or clean up a closed PR. | `deployments: write` |
| `…/preview-comment@v1` | The sticky preview comment. | `pull-requests: write`, `contents: read` (it reads the commit) |
| `…/comment@v1` | A **generic** sticky comment: any body, any marker. | `pull-requests: write` on a PR; `issues: write` on an issue |

About comment permissions: GitHub's [fine-grained permission table](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) lists the issue-comment endpoints under both Issues and Pull requests, so `pull-requests: write` should be enough on a PR. If comments fail with HTTP 403, add `issues: write` and please open an issue.

Every input and output of every piece is listed in the [Reference](#reference) below.

### The reusable workflow

[`.github/workflows/preview.yml`](.github/workflows/preview.yml) is built only from the actions above. It has four jobs:

- **build:** runs your build command, with no secrets, and uploads the output as an artifact.
- **preview:** on PRs.
- **production:** on pushes to the default branch, when `production: true`.
- **cleanup:** when a PR closes.

It skips fork PRs and Dependabot runs. See [`examples/reusable.yml`](examples/reusable.yml).

## Cleaning up when a PR closes

Each preview leaves three things behind. Here is what happens to each.

**1. The GitHub Deployment records.** Previews use one environment per label (`preview/<label>`), not one per PR. One per PR would leave a new environment on the repo's Environments page for every PR ever opened.

- **Default: deactivate.** `deployment` with `state: inactive` marks every deployment of the closed PR inactive. GitHub shows a transient environment that has gone inactive as destroyed. The reusable workflow's `cleanup` job does this.
- **Opt-in: delete.** Add `delete: true` (reusable workflow: `delete-closed-deployments: true`) to also **delete** the PR's deployment records, so the environment's history doesn't grow without bound.
  - Deletion needs the same `deployments: write`.
  - Records are always deactivated first, because [GitHub only deletes an inactive deployment](https://docs.github.com/en/rest/deployments/deployments#delete-a-deployment) when the repo has more than one.
  - The trade-off: the PR timeline loses its deployment entries. Leave it off if you want them as a record.

**2. The preview alias (`pr-N-<worker>…`).** It **can't be deleted**. wrangler has no command for it. The Cloudflare API's Worker versions endpoints are list, get and upload only. [Cloudflare's docs](https://developers.cloudflare.com/workers/configuration/previews/) say:

- aliases can only be *created*, during an upload;
- "only the 1000 most recently deployed aliases are retained";
- when a new alias goes past that, "the least recently deployed alias is deleted".

In practice:

- Every push to an open PR re-uploads its alias, so live PRs stay among the most recent.
- Aliases that drop off are those of PRs that haven't been pushed to for the longest, normally long-closed ones. Their alias URL then stops resolving.
- Version URLs are separate from aliases, and the comment's history keeps them.
- The only bulk off-switch is disabling preview URLs for the Worker (`"preview_urls": false`), which turns off *all* of them.

**3. The uploaded versions.** They stay in the Worker's version history. Cloudflare has no API to delete a version, and they don't serve production traffic unless deployed.

## Security model

- **Untrusted code never runs next to the token, if you use the trusted checkout.** In [`trusted-checkout.yml`](examples/trusted-checkout.yml), the PR's build runs with **no** Cloudflare secrets and uploads only the built output as an artifact. The job that holds the token checks out the **default branch**, so wrangler, the Worker source, the wrangler config and the lockfile all come from there. A PR's dependency change then can't execute with the token: a compromised package, a `postinstall` script, or a `build.command` in the wrangler config.
  - Limit: on `pull_request` the workflow file itself comes from the PR, so pair this with branch protection and a CODEOWNERS rule on `.github/`.
  - Cost: a PR's changes to the Worker or its config preview through the default branch's Worker and config, and take effect on merge.
- **Fork PRs and Dependabot** get no repository secrets. The actions warn and skip when the token is empty (`missing-secrets: skip`), and the examples and the reusable workflow skip those runs outright. Never use `pull_request_target` to give a fork PR's build your token.
- **Redaction before posting.** Every comment body is checked in this order:
  1. The tokens the action holds are masked as exact values.
  2. Known credential formats are masked: GitHub, AWS, Slack, JWT and PEM private keys.
  3. Secret-named `key=value` pairs are masked.

  If something credential-shaped is present in a form it can't mask (a torn PEM block, or a high-entropy value under a secret-named key), the step **fails and posts nothing**. It never prints the body.
- **No injection paths:**
  - There is no `${{ }}` inside any `run:` script; values travel through `env:`, and a test enforces it.
  - wrangler is spawned with an argument array, never through a shell, so a `$(…)` in a commit message or an input stays literal.
  - Commit subjects and author names are HTML-escaped and markdown-escaped before they reach the comment, and `@` is neutralised so they can't ping anyone.
- **Sticky comments are author-filtered.** Anyone can post a comment that starts with the marker. Only one written by `comment-author` (default `github-actions[bot]`) is edited, and only that comment's hidden history is read back. Every history field is re-validated.
- **Pinning.** Third-party actions in this repo are pinned by commit SHA. `@v1` is a moving tag, so pin `Wave-RF/cloudflare-preview` by SHA if your policy requires it.

## Limitations

- Cloudflare generates **no preview URLs for Workers that use Durable Objects** (including Containers), or for Workers for Platforms user Workers ([docs](https://developers.cloudflare.com/workers/configuration/previews/)).
- `alias` + `-` + the Worker name must fit one 63-character DNS label. Longer aliases are truncated with a short hash, as wrangler does.
- Cloudflare's newer [Worker Previews](https://developers.cloudflare.com/workers/previews/) (`wrangler preview`, wrangler ≥ 4.135) are a separate feature: a Preview resource with its own bindings. This repo uses version preview URLs (`versions upload`).
- Tested on Linux and macOS runners. See the Windows note in [How wrangler is found](#how-wrangler-is-found).

## How the URLs are read

The action sets `WRANGLER_OUTPUT_FILE_PATH`, and wrangler appends ND-JSON there:

- `version-upload` (`version_id`, `preview_url`, `preview_alias_url`);
- or `deploy` (`targets`);
- or, on failure, `command-failed`.

The types are in workers-sdk's [`packages/workers-utils/src/output.ts`](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-utils/src/output.ts). If no entry is written (an older wrangler, or a wrapper that drops the variable), it falls back to wrangler's human-readable lines: `Worker Version ID:`, `Version Preview URL:` and `Version Preview Alias URL:`.

Retries skip the failures a retry can't fix: an authentication error, or a Worker that has never been deployed.

## Reference

`{…}` patterns accept `{pr}`, `{sha}`, `{sha7}`, `{branch}`, `{label}` and `{run}`. An unknown placeholder fails the step, so a typo can't ship silently. All action inputs are strings.

<!-- reference:start (generated by scripts/reference.mjs; do not edit by hand) -->

### `Wave-RF/cloudflare-preview@v1`

Upload + Deployment + preview comment in one step. Source: [`action.yml`](action.yml).

| Input | Default | Description |
| --- | --- | --- |
| `cloudflare-api-token` | `""` | Cloudflare API token with Workers edit permission. Pass a secret. Empty → skipped (see missing-secrets). |
| `cloudflare-account-id` | `""` | Cloudflare account id. |
| `github-token` | `${{ github.token }}` | Token for the comment and the deployment record. |
| `missing-secrets` | `skip` | `skip` (warn and do nothing) or `fail` when the Cloudflare token or account id is empty. `ignore` skips the check, for a wrangler-command that injects its own credentials (a secrets-manager wrapper). |
| `working-directory` | `.` | Directory wrangler runs in. |
| `wrangler-command` | `""` | How to invoke wrangler. Empty → the repo's own install, found from the nearest lockfile at or above working-directory: pnpm-lock.yaml → `pnpm exec wrangler`, yarn.lock → `yarn wrangler`, bun.lock(b) → `bunx --no-install wrangler`, package-lock.json or none → node_modules/.bin/wrangler. None of these downloads anything. Set it to override, e.g. a wrapper that injects secrets (`./scripts/with-secrets.sh pnpm exec wrangler`). Split like a shell would, never run through one. |
| `wrangler-config` | `""` | Path to the wrangler config, relative to working-directory. Empty → wrangler's own lookup. |
| `wrangler-args` | `""` | Extra arguments for `wrangler versions upload`. |
| `label` | `preview` | Name of this preview (`docs`, `app`). One comment and one environment per label, so a PR can carry several. |
| `alias` | `pr-{pr}` | --preview-alias pattern. Placeholders {pr} {sha} {sha7} {branch} {label} {run}. Empty → no alias. |
| `tag` | `pr-{pr}` | --tag pattern for the version. Empty → omitted. |
| `message` | `Preview of #{pr} at {sha7}` | --message pattern for the version. Empty → omitted. |
| `retries` | `3` | Total upload attempts (1-10). |
| `retry-delay` | `10` | Seconds between attempts. |
| `fail-on-error` | `true` | Fail the job when the upload fails (after the comment and the deployment record are updated). |
| `comment` | `true` | Post/update the sticky PR comment. |
| `comment-marker` | `<!-- preview:{label} -->` | Marker pattern for the sticky comment. |
| `comment-title` | `""` | Heading pattern. Empty → "Preview" or "<label> preview". |
| `comment-template` | `""` | Markdown body template (see preview-comment/ for the placeholders). Empty → the default layout. |
| `comment-author` | `github-actions[bot]` | Only adopt an existing marker comment by this login. `*` = any. |
| `history-limit` | `10` | Earlier commits kept in the comment's collapsed history. |
| `timezone` | `UTC` | IANA time zone for the comment's timestamps. |
| `deployment` | `true` | Record a GitHub Deployment (in_progress → success/failure) with the alias URL. |
| `environment` | `""` | Deployment environment pattern. Empty → `preview/{label}` (`preview` for the default label). |
| `pr` | `""` | Pull request number. Empty → from the event. |
| `sha` | `""` | Commit being previewed. Empty → the PR head. |
| `summary` | `true` | Write a job-summary section. |

| Output | Description |
| --- | --- |
| `outcome` | success, failure, or skipped. |
| `alias-url` | Stable per-PR URL. |
| `version-url` | This commit's URL. |
| `version-id` | The uploaded version's id. |
| `url` | alias-url when present, else version-url. |
| `deployment-id` | The GitHub deployment id. |
| `comment-url` | The sticky comment's URL. |

### `Wave-RF/cloudflare-preview/upload@v1`

`wrangler versions upload` with retries and a per-PR alias. Source: [`upload/action.yml`](upload/action.yml).

| Input | Default | Description |
| --- | --- | --- |
| `cloudflare-api-token` | `""` | Cloudflare API token (pass a secret). Empty → skipped with a warning, or failed with missing-secrets=fail. |
| `cloudflare-account-id` | `""` | Cloudflare account id (pass a secret or variable). |
| `missing-secrets` | `skip` | `skip` (warn, set outcome=skipped) or `fail` when the token or account id is empty. Fork PRs and Dependabot runs get no secrets. `ignore` skips the check, for a wrangler-command that injects its own credentials (a secrets-manager wrapper). |
| `working-directory` | `.` | Directory wrangler runs in (where its config and node_modules live). |
| `wrangler-command` | `""` | How to invoke wrangler. Empty → the repo's own install, found from the nearest lockfile at or above working-directory: pnpm-lock.yaml → `pnpm exec wrangler`, yarn.lock → `yarn wrangler`, bun.lock(b) → `bunx --no-install wrangler`, package-lock.json or none → node_modules/.bin/wrangler. None of these downloads anything. Set it to override, e.g. a wrapper that injects secrets (`./scripts/with-secrets.sh pnpm exec wrangler`). Split like a shell would, never run through one. |
| `wrangler-config` | `""` | Path to the wrangler config, relative to working-directory. Empty → wrangler's own lookup. |
| `wrangler-args` | `""` | Extra arguments for `wrangler versions upload`, e.g. `--env staging`. |
| `label` | `preview` | Short name for this preview (`docs`, `app`). Used in {label} placeholders. |
| `alias` | `pr-{pr}` | --preview-alias pattern. Placeholders: {pr} {sha} {sha7} {branch} {label} {run}. Sanitised to Cloudflare's rules (lowercase, digits, dashes, starts with a letter). With no PR, {pr} falls back to the branch name. Empty → no alias. |
| `tag` | `pr-{pr}` | --tag pattern for the version (same placeholders). Empty → omitted. |
| `message` | `Preview of #{pr} at {sha7}` | --message pattern for the version (same placeholders). Empty → omitted. |
| `retries` | `3` | Total attempts (1-10). Cloudflare authentication errors (code 10000) are not retried. |
| `retry-delay` | `10` | Seconds between attempts (wrangler's retry_after_ms wins when larger). |
| `fail-on-error` | `true` | Fail the step when the upload fails. `false` → outcome=failure and an error annotation only. |
| `pr` | `""` | Pull request number. Empty → from the event. |
| `sha` | `""` | Commit being previewed. Empty → the PR head (pull_request) or GITHUB_SHA. |
| `summary` | `true` | Write a job-summary section. |

| Output | Description |
| --- | --- |
| `outcome` | success, failure, or skipped (missing secrets). |
| `alias-url` | Stable per-PR URL (follows the latest upload with this alias). Empty when no alias was set or reported. |
| `version-url` | Per-commit URL (this exact version, never changes). |
| `version-id` | The uploaded version's id. |
| `url` | alias-url when present, else version-url. |
| `alias` | The sanitised alias that was passed to --preview-alias. |
| `worker-name` | Worker name as wrangler reported it. |
| `attempts` | How many attempts were made. |

### `Wave-RF/cloudflare-preview/deploy@v1`

`wrangler deploy` to production, with an optional Deployment record. Source: [`deploy/action.yml`](deploy/action.yml).

| Input | Default | Description |
| --- | --- | --- |
| `cloudflare-api-token` | `""` | Cloudflare API token (pass a secret). |
| `cloudflare-account-id` | `""` | Cloudflare account id. |
| `missing-secrets` | `skip` | `skip` (warn, outcome=skipped) or `fail` when the token or account id is empty. On a default-branch deploy `fail` is usually what you want. `ignore` skips the check, for a wrangler-command that injects its own credentials (a secrets-manager wrapper). |
| `working-directory` | `.` | Directory wrangler runs in. |
| `wrangler-command` | `""` | How to invoke wrangler. Empty → the repo's own install, found from the nearest lockfile at or above working-directory: pnpm-lock.yaml → `pnpm exec wrangler`, yarn.lock → `yarn wrangler`, bun.lock(b) → `bunx --no-install wrangler`, package-lock.json or none → node_modules/.bin/wrangler. None of these downloads anything. Set it to override, e.g. a wrapper that injects secrets (`./scripts/with-secrets.sh pnpm exec wrangler`). Split like a shell would, never run through one. |
| `wrangler-config` | `""` | Path to the wrangler config, relative to working-directory. |
| `wrangler-args` | `""` | Extra arguments for `wrangler deploy`. |
| `tag` | `""` | --tag pattern ({sha} {sha7} {branch} {label} {run}). Empty → omitted. |
| `message` | `Deploy {sha7}` | --message pattern. Empty → omitted. |
| `url` | `""` | The public URL to report. Empty → derived from the deploy's triggers (custom domain, then route, then workers.dev). |
| `retries` | `3` | Total attempts (1-10). |
| `retry-delay` | `10` | Seconds between attempts. |
| `fail-on-error` | `true` | Fail the step when the deploy fails. |
| `github-deployment` | `false` | Record a GitHub Deployment (in_progress, then success/failure) in `environment`. |
| `environment` | `production` | GitHub environment name for the deployment record. |
| `github-token` | `${{ github.token }}` | Token for the deployment record (needs deployments write). |
| `label` | `production` | Name used in the job summary and the {label} placeholder. |
| `summary` | `true` | Write a job-summary section. |

| Output | Description |
| --- | --- |
| `outcome` | success, failure, or skipped. |
| `url` | The production URL. |
| `version-id` | The deployed version's id. |
| `targets` | JSON array of the trigger targets wrangler reported. |
| `deployment-id` | GitHub deployment id, when github-deployment is true. |

### `Wave-RF/cloudflare-preview/deployment@v1`

A GitHub Deployment and its status; PR-close cleanup. Source: [`deployment/action.yml`](deployment/action.yml).

| Input | Default | Description |
| --- | --- | --- |
| `github-token` | `${{ github.token }}` | Token with deployments write. |
| `state` | `success` | queued, in_progress, pending, success, failure, error or inactive. inactive with no deployment-id deactivates every deployment of this PR in the environment. |
| `deployment-id` | `""` | Post the status on this existing deployment instead of creating one. |
| `environment` | `""` | Environment name pattern ({pr} {sha7} {branch} {label} {run}). Empty → `preview/{label}` (or `preview` for the default label). One shared name per app keeps the Environments page short. |
| `label` | `preview` | Used by {label} and the default environment. |
| `environment-url` | `""` | The URL people should open (the alias URL for a preview). Set on success only. |
| `log-url` | `""` | Link for "View logs". Empty → this workflow run. |
| `description` | `""` | Short description (GitHub's limit is 140 characters; longer is cut). |
| `transient` | `""` | transient_environment. Empty → true unless production is true. |
| `production` | `false` | production_environment. |
| `delete` | `false` | With state=inactive and no deployment-id (PR closed): also DELETE the PR's deployment records after deactivating them, so the environment's history does not grow without bound. Same permission (deployments: write). |
| `deactivate-previous` | `true` | After a success, mark this PR's earlier deployments in the environment inactive. |
| `pr` | `""` | Pull request number. Empty → from the event. |
| `sha` | `""` | Commit to record. Empty → the PR head or GITHUB_SHA. |
| `fail-on-error` | `false` | Fail on a GitHub API error. Default false — the record is a convenience, so a failure warns. |

| Output | Description |
| --- | --- |
| `deployment-id` | The deployment's id (pass it back in with a later state). |
| `environment` | The rendered environment name. |
| `deactivated` | How many deployments were marked inactive (PR-close mode). |
| `deleted` | How many deployment records were deleted (PR-close mode with delete). |

### `Wave-RF/cloudflare-preview/preview-comment@v1`

The sticky preview comment. Source: [`preview-comment/action.yml`](preview-comment/action.yml).

| Input | Default | Description |
| --- | --- | --- |
| `outcome` (required) |  | The upload's outcome, `success` or `failure` (upload's `outcome` output). |
| `alias-url` | `""` | upload's `alias-url` output. |
| `version-url` | `""` | upload's `version-url` output. |
| `version-id` | `""` | upload's `version-id` output. |
| `attempts` | `1` | upload's `attempts` output (named in the failure line). |
| `label` | `preview` | Preview name; one sticky comment per label, so a PR can carry several previews. |
| `marker` | `<!-- preview:{label} -->` | Marker pattern ({label} {pr} ...). Must render to a single-line HTML comment. |
| `title` | `""` | Heading pattern. Empty → "Preview", or "<label> preview" for a custom label. |
| `template` | `""` | Markdown body template. Empty → the default layout. Placeholders (values are already escaped): {title} {status} {alias_url} {version_url} {version_id} {commit} {sha} {sha7} {subject} {authors} {committed} {deployed} {deployed_label} {run_url} {history} {label} {pr} {outcome}. |
| `timezone` | `UTC` | IANA time zone for timestamps, e.g. America/New_York. DST-aware. |
| `history-limit` | `10` | How many earlier commits to keep in the collapsed history (0-50). |
| `author` | `github-actions[bot]` | Only adopt an existing marker comment posted by this login (see comment/). `*` = any. |
| `pr` | `""` | Pull request number. Empty → from the event. |
| `sha` | `""` | The previewed commit. Empty → the PR head. |
| `github-token` | `${{ github.token }}` | Token that posts the comment. |
| `fail-on-error` | `false` | Fail on a GitHub API error (default warns). An unmaskable credential always fails. |

| Output | Description |
| --- | --- |
| `comment-id` | The comment's id. |
| `comment-url` | The comment's URL. |
| `action` | created, updated, skipped or failed. |

### `Wave-RF/cloudflare-preview/comment@v1`

A generic sticky comment: any body, any marker. Source: [`comment/action.yml`](comment/action.yml).

| Input | Default | Description |
| --- | --- | --- |
| `marker` (required) |  | A single-line HTML comment that identifies the comment, e.g. `<!-- dependabot-major-bump -->`. The body is posted after it. |
| `body` | `""` | Markdown body. Ignored when body-file is set. |
| `body-file` | `""` | Read the body from this file instead (relative to the workspace). |
| `number` | `""` | PR or issue number. Empty → from the event. |
| `mode` | `upsert` | `upsert` (create or update) or `delete` (remove the sticky comment if present). |
| `author` | `github-actions[bot]` | Only adopt an existing marker comment posted by this login, so a stranger's comment that starts with the marker is never edited. `github-actions[bot]` matches GITHUB_TOKEN; use your app's `<slug>[bot]` or the PAT user's login; `*` adopts any author. |
| `mask-values` | `""` | Extra literal values to redact, one per line (e.g. a secret the body might echo). |
| `github-token` | `${{ github.token }}` | Token that posts the comment. |
| `fail-on-error` | `false` | Fail on a GitHub API error. Default false — a failed comment warns and writes the intended body to the job summary. An unmaskable credential always fails. |

| Output | Description |
| --- | --- |
| `comment-id` | The comment's id. |
| `comment-url` | The comment's URL. |
| `action` | created, updated, deleted, none, skipped or failed. |

### Reusable workflow `.github/workflows/preview.yml`

Called with `uses: Wave-RF/cloudflare-preview/.github/workflows/preview.yml@v1`. Source: [`.github/workflows/preview.yml`](.github/workflows/preview.yml). Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (both optional; empty → previews skip with a warning).

| Input | Default | Description |
| --- | --- | --- |
| `build-command` (required) |  | Command that builds the site, run in working-directory (bash -c). Runs with no Cloudflare secrets. |
| `working-directory` | `.` | Directory with package.json and the wrangler config. |
| `output-dir` | `dist` | Build output, relative to working-directory. Uploaded between jobs and placed back before wrangler runs. |
| `package-manager` | `pnpm` | pnpm, npm or yarn. Picks the setup step and the default install command. |
| `pnpm-version` | `""` | pnpm version. Empty → the packageManager field in the repository-root package.json. |
| `node-version` | `22` | Node.js version for setup-node. |
| `install-command` | `""` | Override the install command (bash -c). Empty → `pnpm install --frozen-lockfile` / `npm ci` / `yarn install --frozen-lockfile`. |
| `wrangler-command` | `""` | Override how wrangler is invoked. Empty → the repo's own install, detected from its lockfile (see the README). |
| `wrangler-config` | `""` | Path to the wrangler config, relative to working-directory. |
| `wrangler-args` | `""` | Extra arguments for `wrangler versions upload` (and `wrangler deploy`). |
| `label` | `preview` | Preview name; one comment, environment and artifact per label. |
| `alias` | `pr-{pr}` | --preview-alias pattern. |
| `environment` | `""` | GitHub environment pattern for previews. Empty → `preview/{label}`. |
| `comment-title` | `""` | Comment heading pattern. |
| `comment-template` | `""` | Comment body template (see preview-comment/action.yml). |
| `timezone` | `UTC` | IANA zone for the comment's timestamps. |
| `retries` | `3` | Upload/deploy attempts. |
| `fail-on-error` | `true` | Red the preview job when the upload fails. |
| `trusted-checkout` | `false` | Run wrangler, the Worker source and the wrangler config from the DEFAULT BRANCH, with only the built output coming from the PR (as an artifact). A PR's changes to dependencies, worker code or wrangler config then take effect on merge, not in its preview. |
| `production` | `false` | On a push to the default branch, `wrangler deploy` to production. |
| `delete-closed-deployments` | `false` | On PR close, DELETE the PR's deployment records (after deactivating them) instead of only deactivating them, so the environment's history does not grow without bound. |
| `production-url` | `""` | Public production URL. Empty → derived from the deploy's triggers. |
| `runs-on` | `"ubuntu-latest"` | Runner label(s) as JSON, e.g. '"ubuntu-latest"' or '["self-hosted","linux"]'. |

| Output | Description |
| --- | --- |
| `alias-url` | Stable per-PR preview URL. |
| `version-url` | This commit's preview URL. |
| `production-url` | Production URL after a deploy. |

<!-- reference:end -->

## Versioning

[release-please](https://github.com/googleapis/release-please) cuts `vX.Y.Z` releases from Conventional Commits. After each release the major tag (`v1`) moves to the new one. See [RELEASING.md](RELEASING.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs are welcome.

## License

[MIT](LICENSE)
