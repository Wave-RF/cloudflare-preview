// Pure-function tests: shell splitting, patterns, alias rules, wrangler output parsing,
// redaction, body assembly, preview rendering, wrangler-command detection.
//
// Fixtures (values are neutral examples: example-worker, example.workers.dev, made-up ids):
//   *-stdout.wrangler-<version>.txt   wrangler's human output, line for line in the format
//                                     that wrangler version prints in CI
//   output-dry-run.wrangler-4.130.0.ndjson, output-command-failed-no-code.wrangler-4.130.0.ndjson
//                                     files wrangler 4.130.0 itself wrote to WRANGLER_OUTPUT_FILE_PATH
//   output-version-upload.ndjson, output-deploy.ndjson, output-command-failed.ndjson
//                                     built field for field from wrangler's writer (workers-sdk
//                                     packages/wrangler/src/versions/upload.ts and deploy; types in
//                                     packages/workers-utils/src/output.ts): a real successful upload
//                                     needs Cloudflare credentials.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEFAULT_TEMPLATE, authorsLine, formatTime, inert, nextState, parseState, serializeState, templateVars } from "../src/lib/preview-body.mjs";
import { REDACTED, SecretInCommentError, redact } from "../src/lib/redact.mjs";
import { splitWords } from "../src/lib/shellwords.mjs";
import { LIMIT, assembleBody, findSticky, validateMarker } from "../src/lib/sticky.mjs";
import { renderPattern, renderTemplate, sanitizeAlias } from "../src/lib/template.mjs";
import { isRetryable, parseDeployStdout, parseOutputFile, parseUploadStdout, productionUrl } from "../src/lib/wrangler.mjs";
import { buildUploadArgv } from "../src/upload.mjs";
import { buildDeployArgv } from "../src/deploy.mjs";
import { detectWranglerCommand, repoRoot, wranglerArgv } from "../src/lib/wrangler-command.mjs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coAuthors, loginFromEmail } from "../src/lib/commit.mjs";
import { fixture } from "./helpers/harness.mjs";

const read = (name) => readFileSync(fixture(name), "utf8");

describe("splitWords", () => {
  it("splits like a shell without evaluating anything", () => {
    assert.deepEqual(splitWords("pnpm exec wrangler"), ["pnpm", "exec", "wrangler"]);
    assert.deepEqual(splitWords(`--var 'A:b c' --define "X:\\"y\\"" a\\ b`), ["--var", "A:b c", "--define", 'X:"y"', "a b"]);
    assert.deepEqual(splitWords("echo $(id) `id` ; rm -rf / | cat"), ["echo", "$(id)", "`id`", ";", "rm", "-rf", "/", "|", "cat"]);
    assert.deepEqual(splitWords("  "), []);
    assert.deepEqual(splitWords("''"), [""]);
  });
  it("rejects an unterminated quote", () => {
    assert.throws(() => splitWords(`--x "abc`), /unterminated/);
  });
});

describe("patterns", () => {
  const vars = { pr: "12", sha: "abc", sha7: "abc", branch: "b", label: "docs", run: "1" };
  it("renders known placeholders once, never re-expanding a value", () => {
    assert.equal(renderPattern("pr-{pr}-{label}", vars), "pr-12-docs");
    assert.equal(renderPattern("{branch}", { ...vars, branch: "{pr}" }), "{pr}");
  });
  it("throws on an unknown placeholder in a pattern, keeps it in a template", () => {
    assert.throws(() => renderPattern("pr-{nope}", vars), /unknown placeholder \{nope\}/);
    assert.equal(renderTemplate("a {nope} {pr} {\"json\":1}", vars), 'a {nope} 12 {"json":1}');
  });
  it("sanitises aliases to Cloudflare's rules", () => {
    assert.equal(sanitizeAlias("PR-12"), "pr-12");
    assert.equal(sanitizeAlias("feature/Some_Thing!!"), "feature-some-thing");
    assert.equal(sanitizeAlias("123-fix"), "p-123-fix");
    assert.equal(sanitizeAlias("---"), "");
  });
  it("truncates with a hash so alias-workername fits a DNS label", () => {
    const worker = "a-rather-long-worker-name";
    const alias = sanitizeAlias("feature/an-extremely-long-branch-name-that-goes-on-and-on", worker);
    assert.ok(`${alias}-${worker}`.length <= 63, alias);
    assert.match(alias, /-[0-9a-f]{4}$/);
    assert.equal(sanitizeAlias("pr-12", worker), "pr-12");
  });
});

describe("wrangler structured output", () => {
  it("reads the version-upload entry", () => {
    const o = parseOutputFile(read("output-version-upload.ndjson"));
    assert.equal(o.wranglerVersion, "4.147.0");
    assert.deepEqual(o.upload, {
      workerName: "example-worker",
      versionId: "5f3c1a2b-7d4e-4f60-9a81-2b3c4d5e6f70",
      versionUrl: "https://5f3c1a2b-example-worker.example.workers.dev",
      aliasUrl: "https://pr-42-example-worker.example.workers.dev",
    });
    assert.equal(o.failed, null);
  });
  it("tolerates the real dry-run shape (null ids, URL keys absent)", () => {
    const o = parseOutputFile(read("output-dry-run.wrangler-4.130.0.ndjson"));
    assert.deepEqual(o.upload, { workerName: "cfp-dry", versionId: "", versionUrl: "", aliasUrl: "" });
  });
  it("reads deploy targets and failures, and skips a torn line", () => {
    const d = parseOutputFile(read("output-deploy.ndjson"));
    assert.equal(d.deploy.versionId, "c0ffee00-1234-4abc-8def-0123456789ab");
    assert.deepEqual(d.deploy.targets, ["https://example-docs.example.workers.dev", "www.example.com (custom domain)"]);
    const f = parseOutputFile(`${read("output-command-failed.ndjson")}{"type":"vers`);
    assert.equal(f.failed.code, 10000);
    assert.equal(isRetryable(f.failed), false);
    const g = parseOutputFile(read("output-command-failed-no-code.wrangler-4.130.0.ndjson"));
    assert.equal(g.failed.code, undefined);
    assert.equal(isRetryable(g.failed), false, "a never-deployed Worker is not retryable");
    assert.equal(isRetryable({ code: 10013, message: "timeout" }), true);
  });
  it("rejects non-https or malformed URLs in the file", () => {
    const o = parseOutputFile('{"type":"version-upload","preview_url":"javascript:alert(1)","preview_alias_url":"https://ok.workers.dev","version_id":"nope"}');
    assert.equal(o.upload.versionUrl, "");
    assert.equal(o.upload.aliasUrl, "https://ok.workers.dev");
    assert.equal(o.upload.versionId, "");
  });
});

describe("wrangler stdout fallback (real logs)", () => {
  it("reads alias + version URL (4.147.0)", () => {
    assert.deepEqual(parseUploadStdout(read("upload-stdout-alias.wrangler-4.147.0.txt")), {
      workerName: "example-worker",
      versionId: "5f3c1a2b-7d4e-4f60-9a81-2b3c4d5e6f70",
      versionUrl: "https://5f3c1a2b-example-worker.example.workers.dev",
      aliasUrl: "https://pr-42-example-worker.example.workers.dev",
    });
  });
  it("reads the version URL with no alias (4.118.0)", () => {
    assert.deepEqual(parseUploadStdout(read("upload-stdout-no-alias.wrangler-4.118.0.txt")), {
      workerName: "example-docs",
      versionId: "0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b",
      versionUrl: "https://0b9e8d7c-example-docs.example.workers.dev",
      aliasUrl: "",
    });
  });
  it("survives ANSI colour codes", () => {
    const coloured = "\x1b[32mVersion Preview URL:\x1b[0m https://abc12345-w.x.workers.dev\n";
    assert.equal(parseUploadStdout(coloured).versionUrl, "https://abc12345-w.x.workers.dev");
  });
  it("reads deploy targets and picks the custom domain", () => {
    const d = parseDeployStdout(read("deploy-stdout.wrangler-4.118.0.txt"));
    assert.equal(d.versionId, "c0ffee00-1234-4abc-8def-0123456789ab");
    assert.deepEqual(d.targets, ["https://example-docs.example.workers.dev", "www.example.com (custom domain)"]);
    assert.equal(productionUrl(d.targets), "https://www.example.com");
    assert.equal(productionUrl(["example.com/* (zone name: example.com)", "app.example.com/ (zone name: example.com)"]), "https://app.example.com");
    assert.equal(productionUrl(["https://w.sub.workers.dev", "schedule: */5 * * * *"]), "https://w.sub.workers.dev");
    assert.equal(productionUrl([]), "");
  });
});

describe("argv", () => {
  it("builds versions upload with every flag as its own argument", () => {
    assert.deepEqual(
      buildUploadArgv({ base: wranglerArgv("pnpm exec wrangler"), config: "wrangler.jsonc", extraArgs: "--env staging", alias: "pr-1", tag: "pr-1", message: "Preview of #1; $(rm -rf /)" }),
      ["pnpm", "exec", "wrangler", "versions", "upload", "--config", "wrangler.jsonc", "--preview-alias", "pr-1", "--tag", "pr-1", "--message", "Preview of #1; $(rm -rf /)", "--env", "staging"],
    );
    assert.deepEqual(buildDeployArgv({ base: ["bunx", "wrangler"], config: "", extraArgs: "", tag: "", message: "" }), ["bunx", "wrangler", "deploy"]);
    assert.throws(() => wranglerArgv(`""`), /empty/);
  });
});

describe("redact", () => {
  it("masks literal secrets and known token formats", () => {
    const gh = `ghp_${"a1B2".repeat(9)}`;
    const out = redact(`token ${gh} and cf=supersecretvalue123 and literal sekrit-value-9`, { literals: ["sekrit-value-9"] });
    assert.ok(!out.includes(gh));
    assert.ok(!out.includes("sekrit-value-9"));
    assert.ok(out.includes(REDACTED));
  });
  it("masks secret-named pairs, leaves identifiers alone", () => {
    const out = redact(`api_token = "Xk3jL9mQ2pR7vT1wZ8yB4nC6"\ntoken_name = "deploy"\nversion_id: 5f3c1a2b`);
    assert.match(out, /api_token = "\(redacted\)"/);
    assert.match(out, /token_name = "deploy"/);
    assert.match(out, /version_id: 5f3c1a2b/);
  });
  it("masks a whole PEM private key and fails closed on a torn one", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----";
    assert.equal(redact(`k:\n${pem}\n`), `k:\n${REDACTED}\n`);
    assert.throws(() => redact("-----BEGIN RSA PRIVATE KEY-----\nMIIabc"), SecretInCommentError);
  });
  it("fails closed when a secret-named key has an unmaskable high-entropy value", () => {
    assert.throws(() => redact("password: <<EOT\nXk3jL9mQ2pR7vT1wZ8yB4nC6dF\nEOT"), SecretInCommentError);
  });
  it("leaves an ordinary preview comment byte-identical", () => {
    const body = "### docs preview\n\n✅ **Live:** https://pr-12-docs.acme.workers.dev\n- **Commit:** [`abc1234`](https://github.com/a/b/commit/abc)";
    assert.equal(redact(body), body);
  });
});

describe("sticky", () => {
  it("validates markers", () => {
    assert.equal(validateMarker("<!-- preview:docs -->"), "<!-- preview:docs -->");
    assert.throws(() => validateMarker("preview"), /HTML comment/);
    assert.throws(() => validateMarker("<!-- a -- b -->"), /HTML comment/);
    assert.throws(() => validateMarker("<!-- a\n -->"), /HTML comment/);
  });
  it("assembles under GitHub's limit, keeps the tail, closes what it cut", () => {
    const big = `<details><summary>x</summary>\n\n\`\`\`\n${"line of plan output\n".repeat(6000)}`;
    const body = assembleBody({ marker: "<!-- m -->", body: big, tail: "<!-- state -->" });
    assert.ok(body.length <= LIMIT, String(body.length));
    assert.ok(body.startsWith("<!-- m -->\n"));
    assert.ok(body.endsWith("<!-- state -->"));
    assert.match(body, /truncated/);
    assert.equal((body.match(/^```/gm) || []).length % 2, 0);
    assert.match(body, /<\/details>/);
  });
  it("adopts only the marker comment by the expected author", () => {
    const comments = [
      { id: 1, body: "<!-- preview:docs -->\nfake", user: { login: "mallory" } },
      { id: 2, body: "hello <!-- preview:docs -->", user: { login: "github-actions[bot]" } },
      { id: 3, body: "<!-- preview:docs -->\nreal", user: { login: "github-actions[bot]" } },
    ];
    assert.equal(findSticky(comments, "<!-- preview:docs -->", "github-actions[bot]").id, 3);
    assert.equal(findSticky(comments, "<!-- preview:docs -->", "*").id, 1);
  });
});

describe("preview body", () => {
  const sha = "0123abc4567890def0123abc4567890def012345";
  const old = "a".repeat(40);
  it("makes untrusted text inert", () => {
    const s = inert("<img src=x onerror=alert(1)> [click](https://evil) @org/team *bold* `code`");
    assert.ok(!s.includes("<img"));
    assert.ok(!s.includes("@"));
    assert.ok(!/(?<!\\)\[/.test(s));
    assert.ok(!/(?<!\\)`/.test(s));
  });
  it("formats time in a zone, DST-aware, UTC by default", () => {
    assert.equal(formatTime("2026-07-01T12:00:00Z"), "2026-07-01 12:00 UTC");
    assert.equal(formatTime("2026-07-01T12:00:00Z", "America/New_York"), "2026-07-01 08:00 EDT");
    assert.equal(formatTime("2026-12-01T12:00:00Z", "America/New_York"), "2026-12-01 07:00 EST");
    assert.equal(formatTime(""), "(unknown)");
  });
  it("round-trips state and rejects tampered entries", () => {
    const state = { current: { sha, versionUrl: "https://abc-docs.x.workers.dev", at: "2026-10-09T10:00:00Z", versionId: "" }, aliasUrl: "https://pr-1-docs.x.workers.dev", history: [] };
    assert.deepEqual(parseState(`x\n${serializeState(state)}`), state);
    const evil = serializeState({ current: { sha, versionUrl: "javascript:alert(1)", at: "2026-10-09T10:00:00Z" }, aliasUrl: "https://x\" onclick=\"y", history: [{ sha: "zz", versionUrl: "https://a.b", at: "now" }] });
    assert.deepEqual(parseState(evil), { current: null, aliasUrl: "", history: [] });
  });
  it("moves the previous version into history, capped, and ignores failures", () => {
    let s = { current: null, aliasUrl: "", history: [] };
    for (let i = 0; i < 5; i++)
      s = nextState(s, { outcome: "success", sha: String(i).repeat(40), versionUrl: `https://v${i}-docs.x.workers.dev`, aliasUrl: "https://pr-1-docs.x.workers.dev", at: `2026-10-0${i + 1}T00:00:00Z` }, 3);
    assert.equal(s.current.versionUrl, "https://v4-docs.x.workers.dev");
    assert.deepEqual(s.history.map((e) => e.versionUrl), ["https://v3-docs.x.workers.dev", "https://v2-docs.x.workers.dev", "https://v1-docs.x.workers.dev"]);
    assert.equal(nextState(s, { outcome: "failure", sha }, 3), s);
  });
  it("links authors and co-authors, de-duplicated, with a distinct committer", () => {
    const line = authorsLine(
      { authorName: "Ada", authorLogin: "ada", committerName: "Bob", committerLogin: "", coAuthors: [{ name: "Ada", login: "" }, { name: "Cy", login: "cy" }, { name: "Claude", login: "" }] },
      "https://github.com",
    );
    assert.equal(line, "[@ada](https://github.com/ada), [@cy](https://github.com/cy), Claude (committed by Bob)");
    assert.equal(loginFromEmail("123+octo@users.noreply.github.com"), "octo");
    assert.equal(loginFromEmail("octo@example.com"), "");
    assert.deepEqual(coAuthors("x\n\nCo-authored-by: Cy <1+cy@users.noreply.github.com>\nco-authored-by: Dee"), [{ name: "Cy", email: "1+cy@users.noreply.github.com" }, { name: "Dee", email: "" }]);
  });
  it("renders the failure state without claiming anything is live", () => {
    const prev = { current: { sha: old, versionUrl: "https://old-docs.x.workers.dev", at: "2026-10-01T00:00:00Z", versionId: "" }, aliasUrl: "https://pr-1-docs.x.workers.dev", history: [] };
    const tv = templateVars({ title: "docs preview", outcome: "failure", attempts: 3, state: prev, prevState: prev, info: { subject: "fix: x", authorName: "Ada", authorLogin: "ada", committerName: "Ada", coAuthors: [], committedAt: "2026-10-09T10:00:00Z" }, sha, aliasUrl: "", versionUrl: "", versionId: "", runUrl: "https://github.com/a/b/actions/runs/1", server: "https://github.com", repo: "a/b", timeZone: "UTC", now: "2026-10-09T10:05:00Z", label: "docs", pr: "1" });
    const body = renderTemplate(DEFAULT_TEMPLATE, tv);
    assert.match(body, /Upload failed\*\* for \[`0123abc`\].* after 3 attempts/);
    assert.match(body, /still serves \[`aaaaaaa`\]/);
    assert.doesNotMatch(body, /Live/);
    assert.match(body, /\*\*Failed:\*\* 2026-10-09 10:05 UTC/);
  });
});

describe("default wrangler command (lockfile detection, local only)", () => {
  // A throwaway repo: <root>/.git, optional lockfiles, optional node_modules/.bin/wrangler.
  function repo({ lock, at = "", bin = "", sub = "" } = {}) {
    const root = mkdtempSync(join(tmpdir(), "cfp-detect-"));
    mkdirSync(join(root, ".git"));
    if (lock) {
      mkdirSync(join(root, at), { recursive: true });
      writeFileSync(join(root, at, lock), "");
    }
    if (bin !== false && bin !== "") {
      mkdirSync(join(root, bin, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(root, bin, "node_modules", ".bin", "wrangler"), "#!/bin/sh\n");
    }
    const cwd = join(root, sub);
    mkdirSync(cwd, { recursive: true });
    return { root, cwd };
  }
  const detect = (r) => detectWranglerCommand(r.cwd, { workspace: "" });

  it("pnpm: the lockfile at the workspace root is found from a sub-package", () => {
    const r = repo({ lock: "pnpm-lock.yaml", sub: "packages/docs" });
    const d = detect(r);
    assert.deepEqual(d.argv, ["pnpm", "exec", "wrangler"]);
    assert.equal(d.lockfile, join(r.root, "pnpm-lock.yaml"));
  });
  it("yarn and bun map to their local-only runners", () => {
    assert.deepEqual(detect(repo({ lock: "yarn.lock" })).argv, ["yarn", "wrangler"]);
    assert.deepEqual(detect(repo({ lock: "bun.lock", sub: "site" })).argv, ["bunx", "--no-install", "wrangler"]);
    assert.deepEqual(detect(repo({ lock: "bun.lockb" })).argv, ["bunx", "--no-install", "wrangler"]);
  });
  it("the nearest lockfile wins over one further up", () => {
    const r = repo({ lock: "pnpm-lock.yaml", sub: "site" });
    writeFileSync(join(r.cwd, "package-lock.json"), "");
    mkdirSync(join(r.cwd, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(r.cwd, "node_modules", ".bin", "wrangler"), "");
    assert.deepEqual(detect(r).argv, [join(r.cwd, "node_modules", ".bin", "wrangler")]);
  });
  it("npm or no lockfile: runs node_modules/.bin/wrangler directly, found by walking up", () => {
    const r = repo({ lock: "package-lock.json", bin: ".", sub: "apps/site" });
    assert.deepEqual(detect(r).argv, [join(r.root, "node_modules", ".bin", "wrangler")]);
    const none = repo({ bin: ".", sub: "site" });
    assert.deepEqual(detect(none).argv, [join(none.root, "node_modules", ".bin", "wrangler")]);
  });
  it("npm with no local wrangler fails with a clear message instead of downloading", () => {
    const r = repo({ lock: "package-lock.json" });
    const d = detect(r);
    assert.deepEqual(d.argv, []);
    assert.match(d.reason, /wrangler is not installed/);
    assert.throws(() => wranglerArgv("", { cwd: r.cwd }), /wrangler is not installed/);
  });
  it("never looks above the repository root", () => {
    const outer = mkdtempSync(join(tmpdir(), "cfp-outer-"));
    writeFileSync(join(outer, "pnpm-lock.yaml"), "");
    const inner = join(outer, "repo");
    mkdirSync(join(inner, ".git"), { recursive: true });
    assert.equal(repoRoot(inner, ""), inner);
    assert.equal(detectWranglerCommand(inner, { workspace: "" }).manager, "npm");
    assert.equal(repoRoot(join(inner, "a"), inner), inner, "GITHUB_WORKSPACE bounds the walk");
  });
  it("an explicit command always wins, split without a shell", () => {
    const r = repo({ lock: "pnpm-lock.yaml" });
    assert.deepEqual(wranglerArgv("./with-secrets.sh 'pnpm exec' wrangler", { cwd: r.cwd }), ["./with-secrets.sh", "pnpm exec", "wrangler"]);
    let logged = "";
    assert.deepEqual(wranglerArgv("", { cwd: r.cwd, log: (m) => (logged = m) }), ["pnpm", "exec", "wrangler"]);
    assert.match(logged, /pnpm-lock\.yaml/);
  });
});
