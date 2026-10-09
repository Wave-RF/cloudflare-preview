// Test harness: an in-memory GitHub REST API on a local port, and a runner for the
// entry-point scripts with a realistic Actions environment (GITHUB_OUTPUT,
// GITHUB_STEP_SUMMARY, GITHUB_EVENT_PATH) in a temp dir.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURES = join(ROOT, "test", "fixtures");
export const FAKE_WRANGLER = join(ROOT, "test", "helpers", "fake-wrangler.mjs");
export const fixture = (name) => join(FIXTURES, name);

export const HEAD_SHA = "0123abc4567890def0123abc4567890def012345";
export const REPO = "acme/site";

/** A fake GitHub. `state` is inspectable and pre-seedable by tests. */
export async function fakeGitHub(seed = {}) {
  const state = {
    comments: seed.comments ?? [], // { id, body, user: { login }, issue }
    deployments: seed.deployments ?? [], // { id, environment, payload, ref, ... }
    statuses: seed.statuses ?? {}, // deploymentId -> [{ state, ... }] newest first
    commits: seed.commits ?? {},
    requests: [],
    failNext: seed.failNext ?? [], // [{ method, pathRe, status }]
    nextId: 1000,
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const body = raw ? JSON.parse(raw) : undefined;
      state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });
      const send = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(data === undefined ? "" : JSON.stringify(data));
      };
      const fail = state.failNext.findIndex((f) => f.method === req.method && f.pathRe.test(url.pathname));
      if (fail !== -1) {
        const [f] = state.failNext.splice(fail, 1);
        return send(f.status, { message: "injected failure" });
      }
      const page = Number(url.searchParams.get("page") || 1);
      const perPage = Number(url.searchParams.get("per_page") || 30);
      const paged = (list) => list.slice((page - 1) * perPage, page * perPage);
      let m;
      if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(url.pathname))) {
        const issue = Number(m[1]);
        if (req.method === "GET") return send(200, paged(state.comments.filter((c) => c.issue === issue)));
        const c = { id: state.nextId++, issue, body: body.body, user: { login: "github-actions[bot]" }, html_url: `https://github.com/${REPO}/pull/${issue}#issuecomment-${state.nextId}` };
        state.comments.push(c);
        return send(201, c);
      }
      if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(url.pathname))) {
        const c = state.comments.find((x) => x.id === Number(m[1]));
        if (!c) return send(404, { message: "Not Found" });
        if (req.method === "DELETE") {
          state.comments.splice(state.comments.indexOf(c), 1);
          return send(204);
        }
        c.body = body.body;
        return send(200, c);
      }
      if ((m = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})$/.exec(url.pathname))) {
        const c = state.commits[m[1]];
        return c ? send(200, c) : send(404, { message: "No commit found" });
      }
      if (/^\/repos\/[^/]+\/[^/]+\/deployments$/.test(url.pathname)) {
        if (req.method === "GET") {
          const env = url.searchParams.get("environment");
          return send(200, paged(state.deployments.filter((d) => !env || d.environment === env).slice().reverse()));
        }
        const d = { id: state.nextId++, ...body };
        state.deployments.push(d);
        return send(201, d);
      }
      if ((m = /^\/repos\/[^/]+\/[^/]+\/deployments\/(\d+)$/.exec(url.pathname)) && req.method === "DELETE") {
        // GitHub: with more than one deployment, only an inactive one can be deleted.
        const i = state.deployments.findIndex((d) => String(d.id) === m[1]);
        if (i === -1) return send(404, { message: "Not Found" });
        if (state.deployments.length > 1 && state.statuses[m[1]]?.[0]?.state !== "inactive")
          return send(422, { message: "We cannot delete an active deployment unless it is the only deployment in a given environment." });
        state.deployments.splice(i, 1);
        state.deleted = [...(state.deleted ?? []), m[1]];
        return send(204);
      }
      if ((m = /^\/repos\/[^/]+\/[^/]+\/deployments\/(\d+)\/statuses$/.exec(url.pathname))) {
        const id = m[1];
        state.statuses[id] ??= [];
        if (req.method === "GET") return send(200, paged(state.statuses[id]));
        state.statuses[id].unshift(body);
        return send(201, { id: state.nextId++, ...body });
      }
      send(404, { message: `fake GitHub has no route for ${req.method} ${url.pathname}` });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { state, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

export function prEvent({ number = 7, sha = HEAD_SHA, ref = "feature/x", fork = false } = {}) {
  return {
    action: "synchronize",
    number,
    pull_request: { number, head: { sha, ref, repo: { full_name: fork ? "stranger/site" : REPO } } },
    repository: { full_name: REPO, default_branch: "main" },
  };
}

/** Run an entry script; resolves { code, stdout, stderr, outputs, summary }. */
export async function runScript(script, { env = {}, event = prEvent(), cwd } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cfp-test-"));
  const outputFile = join(dir, "output");
  const summaryFile = join(dir, "summary");
  const eventFile = join(dir, "event.json");
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");
  writeFileSync(eventFile, JSON.stringify(event));
  const fullEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_EVENT_PATH: eventFile,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: REPO,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "f".repeat(40),
    RUNNER_TEMP: dir,
    CFP_GITHUB_RETRY_MS: "1",
    ...env,
  };
  const child = spawn(process.execPath, [join(ROOT, "src", script)], { env: fullEnv, cwd: cwd ?? dir });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const code = await new Promise((r) => child.on("close", r));
  return { code, stdout, stderr, outputs: parseOutputs(readFileSync(outputFile, "utf8")), summary: readFileSync(summaryFile, "utf8"), dir };
}

/** Parse the heredoc format setOutput writes. */
export function parseOutputs(text) {
  const out = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^<]+)<<(\S+)$/.exec(lines[i]);
    if (!m) continue;
    const value = [];
    for (i++; i < lines.length && lines[i] !== m[2]; i++) value.push(lines[i]);
    out[m[1]] = value.join("\n");
  }
  return out;
}
