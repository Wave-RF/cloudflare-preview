// What the run is about, read from the event payload file rather than from `${{ }}`
// expressions, so no event field is ever interpolated into a script.

import { readFileSync } from "node:fs";

export function readEvent(path = process.env.GITHUB_EVENT_PATH) {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

const SHA = /^[0-9a-f]{40}$/;
const NUMBER = /^[1-9][0-9]{0,9}$/;

/**
 * @returns {{ pr: string, sha: string, branch: string, isFork: boolean, defaultBranch: string,
 *             eventName: string, action: string, runUrl: string, serverUrl: string, repo: string }}
 * `pr` is "" when the run is not about a pull request; `sha` is the PR head when it is
 * (GITHUB_SHA is the throwaway merge commit on pull_request events), else GITHUB_SHA.
 */
export function runContext({ env = process.env, event = readEvent(env.GITHUB_EVENT_PATH), prOverride = "", shaOverride = "" } = {}) {
  const pull = event.pull_request ?? null;
  const pr = String(prOverride || pull?.number || (event.issue?.pull_request ? event.issue.number : "") || "");
  if (pr && !NUMBER.test(pr)) throw new Error(`pull request number must be a positive integer, got ${JSON.stringify(pr)}`);
  const sha = String(shaOverride || pull?.head?.sha || env.GITHUB_SHA || "").toLowerCase();
  if (sha && !SHA.test(sha)) throw new Error(`commit sha must be 40 hex characters, got ${JSON.stringify(sha)}`);
  const repo = env.GITHUB_REPOSITORY || "";
  const serverUrl = (env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
  const branch = pull?.head?.ref || env.GITHUB_HEAD_REF || (env.GITHUB_REF || "").replace(/^refs\/heads\//, "");
  return {
    pr,
    sha,
    branch,
    isFork: Boolean(pull && pull.head?.repo?.full_name && pull.head.repo.full_name !== repo),
    defaultBranch: event.repository?.default_branch || "",
    eventName: env.GITHUB_EVENT_NAME || "",
    action: event.action || "",
    repo,
    serverUrl,
    runUrl:
      repo && env.GITHUB_RUN_ID
        ? `${serverUrl}/${repo}/actions/runs/${env.GITHUB_RUN_ID}${env.GITHUB_RUN_ATTEMPT && env.GITHUB_RUN_ATTEMPT !== "1" ? `/attempts/${env.GITHUB_RUN_ATTEMPT}` : ""}`
        : "",
  };
}
