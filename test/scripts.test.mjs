// End-to-end tests of the entry scripts, run as child processes the way the composite
// actions run them: env in, GITHUB_OUTPUT/summary out, a fake wrangler on the command
// line and a fake GitHub on a local port.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FAKE_WRANGLER, HEAD_SHA, fakeGitHub, fixture, prEvent, runScript } from "./helpers/harness.mjs";

const wranglerCommand = `"${process.execPath}" "${FAKE_WRANGLER}"`;
const CF = { CLOUDFLARE_API_TOKEN: "cf-token-value-123456", CLOUDFLARE_ACCOUNT_ID: "acct" };

describe("check-secrets", () => {
  it("skips with a warning when a secret is empty", async () => {
    const r = await runScript("check-secrets.mjs", { env: { CLOUDFLARE_ACCOUNT_ID: "a" } });
    assert.equal(r.code, 0);
    assert.equal(r.outputs.ok, "false");
    assert.match(r.stdout, /::warning::CLOUDFLARE_API_TOKEN is empty/);
  });
  it("fails when asked to", async () => {
    const r = await runScript("check-secrets.mjs", { env: { CFP_MISSING_SECRETS: "fail" } });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /::error::CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are empty/);
  });
  it("ignores the check when the wrangler command brings its own credentials", async () => {
    const r = await runScript("check-secrets.mjs", { env: { CFP_MISSING_SECRETS: "ignore" } });
    assert.equal(r.code, 0);
    assert.equal(r.outputs.ok, "true");
  });
  it("passes when both are set", async () => {
    const r = await runScript("check-secrets.mjs", { env: CF });
    assert.equal(r.outputs.ok, "true");
  });
});

describe("upload", () => {
  const base = (extra = {}) => ({
    ...CF,
    CFP_WRANGLER_COMMAND: wranglerCommand,
    CFP_ALIAS: "pr-{pr}",
    CFP_TAG: "pr-{pr}",
    CFP_MESSAGE: "Preview of #{pr} at {sha7}",
    CFP_LABEL: "console",
    CFP_RETRY_DELAY: "0",
    ...extra,
  });

  it("reads URLs from the structured output file and passes the right argv", async () => {
    const r = await runScript("upload.mjs", {
      env: base({ FAKE_NDJSON: fixture("output-version-upload.ndjson"), FAKE_STDOUT: fixture("upload-stdout-alias.wrangler-4.147.0.txt"), FAKE_ARGV_LOG: "argv.log" }),
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.outcome, "success");
    assert.equal(r.outputs.source, "output-file");
    assert.equal(r.outputs["alias-url"], "https://pr-42-example-worker.example.workers.dev");
    assert.equal(r.outputs["version-url"], "https://5f3c1a2b-example-worker.example.workers.dev");
    assert.equal(r.outputs.url, r.outputs["alias-url"]);
    assert.equal(r.outputs.alias, "pr-7");
    const argv = JSON.parse(readFileSync(join(r.dir, "argv.log"), "utf8").trim());
    assert.deepEqual(argv, ["versions", "upload", "--preview-alias", "pr-7", "--tag", "pr-7", "--message", `Preview of #7 at ${HEAD_SHA.slice(0, 7)}`]);
    assert.match(r.summary, /This commit: https:\/\/5f3c1a2b/);
  });

  it("with no wrangler-command, runs the repo's own node_modules/.bin/wrangler", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfp-npm-"));
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(dir, "site"));
    writeFileSync(join(dir, "package-lock.json"), "{}");
    const bin = join(dir, "node_modules", ".bin", "wrangler");
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_WRANGLER}" "$@"\n`);
    chmodSync(bin, 0o755);
    const r = await runScript("upload.mjs", {
      cwd: join(dir, "site"),
      env: base({ CFP_WRANGLER_COMMAND: "", GITHUB_WORKSPACE: dir, FAKE_NDJSON: fixture("output-version-upload.ndjson") }),
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.outcome, "success");
    assert.match(r.stdout, /wrangler-command not set; using `.*node_modules\/\.bin\/wrangler` \(found .*package-lock\.json\)/);
  });

  it("falls back to stdout when no output file is written", async () => {
    const r = await runScript("upload.mjs", {
      env: base({ FAKE_IGNORE_OUTPUT_FILE: "1", FAKE_STDOUT: fixture("upload-stdout-alias.wrangler-4.147.0.txt") }),
    });
    assert.equal(r.code, 0);
    assert.equal(r.outputs.source, "stdout");
    assert.equal(r.outputs["alias-url"], "https://pr-42-example-worker.example.workers.dev");
    assert.equal(r.outputs["version-id"], "5f3c1a2b-7d4e-4f60-9a81-2b3c4d5e6f70");
    assert.match(r.stdout, /::notice::wrangler wrote no version-upload entry/);
  });

  it("retries a transient failure, then succeeds", async () => {
    const r = await runScript("upload.mjs", {
      env: base({ FAKE_FAIL_TIMES: "2", FAKE_STATE: "count", FAKE_NDJSON: fixture("output-version-upload.ndjson") }),
    });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.outputs.attempts, "3");
    assert.equal((r.stdout.match(/::warning::wrangler failed \(attempt/g) || []).length, 2);
  });

  it("does not retry an authentication error, and fails the step", async () => {
    const r = await runScript("upload.mjs", {
      env: base({ FAKE_FAIL_TIMES: "9", FAKE_STATE: "count", FAKE_FAIL_NDJSON: fixture("output-command-failed.ndjson") }),
    });
    assert.equal(r.code, 1);
    assert.equal(r.outputs.outcome, "failure");
    assert.equal(r.outputs.attempts, "1");
    assert.match(r.stdout, /::error::wrangler versions upload failed after 1 attempt\(s\) \(A request to the Cloudflare API/);
  });

  const failing = (ndjson, stdout) =>
    base({ FAKE_FAIL_TIMES: "9", FAKE_STATE: "count", FAKE_FAIL_NDJSON: fixture(ndjson), ...(stdout ? { FAKE_FAIL_STDOUT: fixture(stdout) } : {}) });

  it("does not retry 9109 (wrangler 4.147.0 reports it in place of 10000)", async () => {
    const r = await runScript("upload.mjs", { env: failing("output-command-failed.ndjson", "stdout-auth-failed.wrangler-4.147.0.txt") });
    assert.equal(r.code, 1);
    assert.equal(r.outputs.attempts, "1");
  });

  it("does not retry 9106", async () => {
    const r = await runScript("upload.mjs", { env: failing("output-command-failed-9106.ndjson") });
    assert.equal(r.outputs.attempts, "1");
  });

  it("does not retry when [code: 10000] appears only on stdout", async () => {
    const r = await runScript("upload.mjs", { env: failing("output-command-failed-auth-in-stdout-only.ndjson", "stdout-auth-failed.wrangler-4.147.0.txt") });
    assert.equal(r.outputs.attempts, "1");
  });

  it("still retries a rate limit (10429)", async () => {
    const r = await runScript("upload.mjs", { env: failing("output-command-failed-rate-limit.ndjson") });
    assert.equal(r.outputs.attempts, "3");
  });

  it("records failure without failing when fail-on-error is false", async () => {
    const r = await runScript("upload.mjs", { env: base({ FAKE_FAIL_TIMES: "9", FAKE_STATE: "count", CFP_RETRIES: "2", CFP_FAIL_ON_ERROR: "false" }) });
    assert.equal(r.code, 0);
    assert.equal(r.outputs.outcome, "failure");
    assert.equal(r.outputs.attempts, "2");
  });

  it("falls back to the branch for the alias outside a PR, and drops {pr} tags", async () => {
    const r = await runScript("upload.mjs", {
      event: { ref: "refs/heads/Feature/X" },
      env: base({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/Feature/X", FAKE_ARGV_LOG: "argv.log", FAKE_NDJSON: fixture("output-version-upload.ndjson") }),
    });
    assert.equal(r.code, 0, r.stdout);
    const argv = JSON.parse(readFileSync(join(r.dir, "argv.log"), "utf8").trim());
    assert.deepEqual(argv, ["versions", "upload", "--preview-alias", "feature-x"]);
  });

  it("rejects a typo'd placeholder before running anything", async () => {
    const r = await runScript("upload.mjs", { env: base({ CFP_TAG: "pr-{number}" }) });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /unknown placeholder \{number\}/);
  });
});

describe("deploy", () => {
  it("reports the custom domain as the URL", async () => {
    const r = await runScript("deploy.mjs", {
      event: {},
      env: { ...CF, CFP_WRANGLER_COMMAND: wranglerCommand, FAKE_NDJSON: fixture("output-deploy.ndjson"), FAKE_STDOUT: fixture("deploy-stdout.wrangler-4.118.0.txt") },
    });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.outputs.url, "https://www.example.com");
    assert.equal(r.outputs["version-id"], "c0ffee00-1234-4abc-8def-0123456789ab");
    assert.deepEqual(JSON.parse(r.outputs.targets), ["https://example-docs.example.workers.dev", "www.example.com (custom domain)"]);
  });
  it("reads the stdout of a real deploy log when there is no output file", async () => {
    const r = await runScript("deploy.mjs", {
      event: {},
      env: { ...CF, CFP_WRANGLER_COMMAND: wranglerCommand, FAKE_STDOUT: fixture("deploy-stdout.wrangler-4.118.0.txt") },
    });
    assert.equal(r.outputs.url, "https://www.example.com");
  });
});

describe("GitHub-facing scripts", () => {
  let gh;
  before(async () => {
    gh = await fakeGitHub({
      commits: {
        [HEAD_SHA]: {
          sha: HEAD_SHA,
          author: { login: "ada" },
          committer: { login: "web-flow" },
          commit: {
            message: "feat: thing <b>bold</b> @everyone\n\nCo-authored-by: Cy <9+cy@users.noreply.github.com>\nCo-authored-by: Claude <noreply@anthropic.com>",
            author: { name: "Ada", email: "ada@example.com", date: "2026-10-09T09:00:00Z" },
            committer: { name: "GitHub", email: "noreply@github.com", date: "2026-10-09T09:01:00Z" },
          },
        },
      },
    });
  });
  after(() => gh.close());
  const env = (extra) => ({ GITHUB_API_URL: gh.url, CFP_GITHUB_TOKEN: "ghs_testtoken", ...extra });

  it("comment: creates, then updates the same comment, redacting secrets", async () => {
    const leak = `ghp_${"Ab1x".repeat(9)}`;
    let r = await runScript("comment.mjs", { env: env({ CFP_MARKER: "<!-- dependabot-major-bump -->", CFP_BODY: `Major bump, held. ${leak}`, CFP_NUMBER: "5" }) });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.outputs.action, "created");
    const id = r.outputs["comment-id"];
    r = await runScript("comment.mjs", { env: env({ CFP_MARKER: "<!-- dependabot-major-bump -->", CFP_BODY: "Second body", CFP_NUMBER: "5" }) });
    assert.equal(r.outputs.action, "updated");
    assert.equal(r.outputs["comment-id"], id);
    const mine = gh.state.comments.filter((c) => c.issue === 5);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].body, "<!-- dependabot-major-bump -->\nSecond body");
    const first = gh.state.requests.find((q) => q.method === "POST" && q.path.endsWith("/issues/5/comments"));
    assert.ok(!first.body.body.includes(leak), "the token never reached GitHub");
    assert.equal(first.auth, "Bearer ghs_testtoken");
  });

  it("comment: refuses an unmaskable credential and posts nothing", async () => {
    const before = gh.state.requests.length;
    const r = await runScript("comment.mjs", { env: env({ CFP_MARKER: "<!-- x -->", CFP_BODY: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk", CFP_NUMBER: "6" }) });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /refusing to post/);
    assert.ok(!r.stdout.includes("b3BlbnNzaC1rZXk"), "the body is never echoed");
    assert.equal(gh.state.requests.slice(before).filter((q) => q.method !== "GET").length, 0);
  });

  it("comment: delete mode removes the sticky comment", async () => {
    const r = await runScript("comment.mjs", { env: env({ CFP_MARKER: "<!-- dependabot-major-bump -->", CFP_NUMBER: "5", CFP_MODE: "delete" }) });
    assert.equal(r.outputs.action, "deleted");
    assert.equal(gh.state.comments.filter((c) => c.issue === 5).length, 0);
  });

  it("comment: a GitHub outage warns and writes the body to the summary", async () => {
    gh.state.failNext.push({ method: "POST", pathRe: /issues\/8\/comments$/, status: 403 });
    const r = await runScript("comment.mjs", { env: env({ CFP_MARKER: "<!-- x -->", CFP_BODY: "hello", CFP_NUMBER: "8" }) });
    assert.equal(r.code, 0);
    assert.equal(r.outputs.action, "failed");
    assert.match(r.stdout, /::warning::Comment not posted on #8/);
    assert.match(r.summary, /<!-- x -->\nhello/);
  });

  const preview = (extra) =>
    env({
      CFP_LABEL: "docs",
      CFP_OUTCOME: "success",
      CFP_ALIAS_URL: "https://pr-7-docs.acme.workers.dev",
      CFP_VERSION_URL: "https://11111111-docs.acme.workers.dev",
      CFP_VERSION_ID: "11111111-2222-4333-8444-555555555555",
      CFP_TIMEZONE: "America/New_York",
      ...extra,
    });

  it("preview-comment: renders, then keeps history across commits, then reports a failure", async () => {
    let r = await runScript("preview-comment.mjs", { env: preview() });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.outputs.action, "created");
    let c = gh.state.comments.find((x) => x.issue === 7);
    assert.ok(c.body.startsWith("<!-- preview:docs -->\n### docs preview"));
    assert.match(c.body, /✅ \*\*Live:\*\* https:\/\/pr-7-docs\.acme\.workers\.dev/);
    assert.match(c.body, /\*\*This commit\*\* \(\[`0123abc`\]/);
    assert.match(c.body, /https:\/\/11111111-docs\.acme\.workers\.dev/);
    assert.match(c.body, /\[@ada\]\(https:\/\/github\.com\/ada\), \[@cy\]\(https:\/\/github\.com\/cy\), Claude/);
    assert.ok(!c.body.includes("<b>"), "subject HTML is escaped");
    assert.ok(!c.body.includes("@everyone"), "subject mentions are neutralised");
    assert.match(c.body, /\*\*Committed:\*\* 2026-10-09 05:01 EDT/);
    assert.doesNotMatch(c.body, /Earlier commits/);

    // A second commit: the first version moves into history.
    const sha2 = "b".repeat(40);
    r = await runScript("preview-comment.mjs", { event: prEvent({ sha: sha2 }), env: preview({ CFP_VERSION_URL: "https://22222222-docs.acme.workers.dev" }) });
    assert.equal(r.outputs.action, "updated");
    c = gh.state.comments.find((x) => x.issue === 7);
    assert.match(c.body, /Earlier commits \(1\)/);
    assert.match(c.body, /\| \[`0123abc`\]\([^)]+\) \| https:\/\/11111111-docs\.acme\.workers\.dev \|/);

    // A failed third commit: says so, names what the alias still serves, keeps history.
    const sha3 = "c".repeat(40);
    r = await runScript("preview-comment.mjs", { event: prEvent({ sha: sha3 }), env: preview({ CFP_OUTCOME: "failure", CFP_ATTEMPTS: "3", CFP_ALIAS_URL: "", CFP_VERSION_URL: "", CFP_VERSION_ID: "" }) });
    c = gh.state.comments.find((x) => x.issue === 7);
    assert.match(c.body, /❌ \*\*Upload failed\*\* for \[`ccccccc`\].* after 3 attempts/);
    assert.match(c.body, /https:\/\/pr-7-docs\.acme\.workers\.dev still serves \[`bbbbbbb`\]/);
    assert.doesNotMatch(c.body, /✅/);
    assert.match(c.body, /Earlier commits \(1\)/);
    assert.equal(gh.state.comments.filter((x) => x.issue === 7).length, 1);
  });

  it("preview-comment: a second label gets its own comment", async () => {
    const r = await runScript("preview-comment.mjs", { env: preview({ CFP_LABEL: "console" }) });
    assert.equal(r.outputs.action, "created");
    assert.equal(gh.state.comments.filter((x) => x.issue === 7).length, 2);
  });

  it("preview-comment: ignores a stranger's comment that copies the marker", async () => {
    gh.state.comments.push({ id: 1, issue: 9, user: { login: "mallory" }, body: '<!-- preview:docs -->\n<!-- cloudflare-preview-state {"v":1,"current":null,"aliasUrl":"https://evil.example","history":[]} -->' });
    const r = await runScript("preview-comment.mjs", { event: prEvent({ number: 9 }), env: preview() });
    assert.equal(r.outputs.action, "created");
    assert.equal(gh.state.comments.find((x) => x.id === 1).body.includes("evil"), true, "the stranger's comment is untouched");
  });

  it("deployment: start → finish, then the next commit deactivates the previous one", async () => {
    const d = (extra, event) => runScript("deployment.mjs", { event, env: env({ CFP_LABEL: "docs", ...extra }) });
    let r = await d({ CFP_STATE: "in_progress" });
    assert.equal(r.code, 0, r.stdout);
    const id1 = r.outputs["deployment-id"];
    assert.equal(r.outputs.environment, "preview/docs");
    const created = gh.state.deployments.find((x) => String(x.id) === id1);
    assert.equal(created.ref, HEAD_SHA);
    assert.equal(created.transient_environment, true);
    assert.equal(created.production_environment, false);
    assert.equal(created.auto_merge, false);
    assert.deepEqual(created.required_contexts, []);
    r = await d({ CFP_STATE: "success", CFP_DEPLOYMENT_ID: id1, CFP_ENVIRONMENT_URL: "https://pr-7-docs.acme.workers.dev" });
    assert.equal(gh.state.statuses[id1][0].state, "success");
    assert.equal(gh.state.statuses[id1][0].environment_url, "https://pr-7-docs.acme.workers.dev");
    assert.equal(gh.state.statuses[id1][0].log_url, "https://github.com/acme/site/actions/runs/42");

    // Another PR's deployment in the same environment must be left alone.
    const other = await d({ CFP_STATE: "success" }, prEvent({ number: 99 }));
    const otherId = other.outputs["deployment-id"];

    r = await d({ CFP_STATE: "success", CFP_ENVIRONMENT_URL: "https://pr-7-docs.acme.workers.dev" }, prEvent({ sha: "d".repeat(40) }));
    const id2 = r.outputs["deployment-id"];
    assert.notEqual(id2, id1);
    assert.equal(gh.state.statuses[id1][0].state, "inactive");
    assert.equal(gh.state.statuses[id2][0].state, "success");
    assert.equal(gh.state.statuses[otherId][0].state, "success");

    // PR closed: everything of PR 7 goes inactive.
    r = await d({ CFP_STATE: "inactive" });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(gh.state.statuses[id2][0].state, "inactive");
    assert.equal(gh.state.statuses[otherId][0].state, "success");
  });

  it("deployment: PR-close with delete deactivates, then deletes, only that PR's records", async () => {
    const d = (extra, event) => runScript("deployment.mjs", { event, env: env({ CFP_LABEL: "site", ...extra }) });
    const a = (await d({ CFP_STATE: "success" }, prEvent({ number: 21 }))).outputs["deployment-id"];
    const b = (await d({ CFP_STATE: "success" }, prEvent({ number: 21, sha: "e".repeat(40) }))).outputs["deployment-id"];
    const other = (await d({ CFP_STATE: "success" }, prEvent({ number: 22 }))).outputs["deployment-id"];
    const r = await d({ CFP_STATE: "inactive", CFP_DELETE: "true" }, prEvent({ number: 21 }));
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.outputs.deleted, "2");
    assert.equal(r.outputs.deactivated, "1", "a was already inactive (superseded by b); only b needed it");
    const ids = gh.state.deployments.map((x) => String(x.id));
    assert.ok(!ids.includes(a) && !ids.includes(b));
    assert.ok(ids.includes(other));
    assert.equal(gh.state.statuses[other][0].state, "success");
  });

  describe("production retirement", () => {
    // A push to the default branch: no pull request in the event.
    let n = 0;
    const prod = (extra) => {
      const sha = String(++n).padStart(40, "0");
      return runScript("deployment.mjs", { event: { ref: "refs/heads/main", after: sha }, env: env({ GITHUB_EVENT_NAME: "push", GITHUB_SHA: sha, CFP_LABEL: "production", CFP_ENVIRONMENT: "production", CFP_PRODUCTION: "true", CFP_STATE: "success", ...extra }) });
    };
    const seed = (id, environment, payload, state) => {
      gh.state.deployments.push({ id, environment, payload, ref: HEAD_SHA });
      if (state) gh.state.statuses[id] = [{ state }];
    };

    it("a new production deploy retires only our earlier records in the same environment", async () => {
      const first = (await prod({})).outputs["deployment-id"];
      seed(9001, "production", { source: "other-tool" }, "success"); // foreign, other source
      seed(9002, "production", undefined, "success"); // foreign, no payload
      seed(9003, "production", "not json", "success"); // foreign, unparseable payload
      seed(9004, "staging", { source: "cloudflare-preview", pr: null, label: "production" }, "success"); // other environment
      seed(9005, "production", { source: "cloudflare-preview", pr: null, label: "production" }, "inactive"); // already inactive
      const r = await prod({});
      assert.equal(r.code, 0, r.stdout);
      const second = r.outputs["deployment-id"];
      assert.notEqual(second, first);
      assert.equal(r.outputs.deactivated, "1");
      assert.equal(gh.state.statuses[first][0].state, "inactive");
      assert.equal(gh.state.statuses[first][0].description, "Superseded by a newer deploy");
      assert.equal(gh.state.statuses[second][0].state, "success");
      for (const id of [9001, 9002, 9003, 9004]) assert.equal(gh.state.statuses[id].length, 1, `deployment ${id} untouched`);
      assert.equal(gh.state.statuses[9005].length, 1, "no duplicate inactive status");
    });

    it("deactivate-previous false touches nothing", async () => {
      const a = (await prod({ CFP_ENVIRONMENT: "production-off" })).outputs["deployment-id"];
      const r = await prod({ CFP_ENVIRONMENT: "production-off", CFP_DEACTIVATE_PREVIOUS: "false" });
      assert.equal(r.code, 0, r.stdout);
      assert.equal(gh.state.statuses[a].length, 1);
      assert.equal(gh.state.statuses[a][0].state, "success");
    });

    it("a failure while retiring warns and does not fail the deploy", async () => {
      const old = (await prod({ CFP_ENVIRONMENT: "production-warn" })).outputs["deployment-id"];
      // Fail only the status POST on the OLD deployment, i.e. the retirement itself.
      gh.state.failNext.push({ method: "POST", pathRe: new RegExp(`/deployments/${old}/statuses$`), status: 422 });
      const r = await prod({ CFP_ENVIRONMENT: "production-warn" });
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, /::warning::GitHub deployment not recorded/);
      assert.equal(gh.state.statuses[old].length, 1, "the old record is unchanged");
      assert.equal(gh.state.failNext.length, 0, "the injected failure was consumed by the retirement");
    });

    it("a per-PR preview rule leaves a foreign deployment in preview/<label> alone", async () => {
      const d = (extra, event) => runScript("deployment.mjs", { event, env: env({ CFP_LABEL: "guard", ...extra }) });
      seed(9101, "preview/guard", { source: "other-tool", pr: 31 }, "success");
      seed(9102, "preview/guard", undefined, "success");
      await d({ CFP_STATE: "success" }, prEvent({ number: 31 }));
      const r = await d({ CFP_STATE: "success" }, prEvent({ number: 31, sha: "c".repeat(40) }));
      assert.equal(r.outputs.deactivated, "1");
      assert.equal(gh.state.statuses[9101].length, 1);
      assert.equal(gh.state.statuses[9102].length, 1);
      const closed = await d({ CFP_STATE: "inactive" }, prEvent({ number: 31 }));
      assert.equal(closed.code, 0, closed.stdout);
      assert.equal(gh.state.statuses[9101].length, 1);
      assert.equal(gh.state.statuses[9102].length, 1);
    });
  });

  it("deployment: an API failure warns by default", async () => {
    gh.state.failNext.push({ method: "POST", pathRe: /\/deployments$/, status: 422 });
    const r = await runScript("deployment.mjs", { env: env({ CFP_STATE: "in_progress" }) });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /::warning::GitHub deployment not recorded/);
    assert.equal(r.outputs["deployment-id"], "");
  });
});
