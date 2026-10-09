// The sticky preview comment: render it from the upload's result and the comment's own
// previous state (for the history), then post it through the generic sticky path.
//
// Env: CFP_GITHUB_TOKEN, CFP_MARKER (pattern), CFP_LABEL, CFP_TITLE (pattern),
//      CFP_TEMPLATE ({placeholder} markdown, "" = the default layout), CFP_OUTCOME
//      (success|failure), CFP_ATTEMPTS, CFP_ALIAS_URL, CFP_VERSION_URL,
//      CFP_VERSION_ID, CFP_TIMEZONE, CFP_HISTORY_LIMIT, CFP_AUTHOR, CFP_PR, CFP_SHA,
//      CFP_FAIL_ON_ERROR
// Outputs: comment-id, comment-url, action
// Permissions: pull-requests: write (+ contents: read for the commit lookup)

import { boolInput, choiceInput, input, intInput, isMain, main, setOutput, warning } from "./lib/actions.mjs";
import { commitInfo } from "./lib/commit.mjs";
import { runContext } from "./lib/context.mjs";
import { createClient, repoFromEnv } from "./lib/github.mjs";
import { DEFAULT_TEMPLATE, nextState, parseState, serializeState, templateVars, validTimeZone } from "./lib/preview-body.mjs";
import { SecretInCommentError } from "./lib/redact.mjs";
import { DEFAULT_AUTHOR, findSticky, listComments, validateMarker } from "./lib/sticky.mjs";
import { patternVars, renderPattern, renderTemplate } from "./lib/template.mjs";
import { postSticky } from "./comment.mjs";

const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(?:\/\S*)?$/;
const urlInput = (name) => {
  const v = input(name);
  if (v && !HTTPS.test(v)) throw new Error(`${name} must be an https URL, got ${JSON.stringify(v)}`);
  return v;
};

export async function previewComment({ client, now = new Date().toISOString() } = {}) {
  const repo = repoFromEnv();
  const ctx = runContext({ prOverride: input("CFP_PR"), shaOverride: input("CFP_SHA") });
  if (!ctx.pr) {
    warning("Not a pull request run (and no pr input): no preview comment to post.");
    setOutput("action", "skipped");
    return { action: "skipped" };
  }
  const label = input("CFP_LABEL", "preview");
  const vars = patternVars({ ...ctx, label });
  const marker = validateMarker(renderPattern(input("CFP_MARKER", "<!-- preview:{label} -->"), vars, "comment-marker"));
  const title = renderPattern(input("CFP_TITLE", label === "preview" ? "Preview" : "{label} preview"), vars, "comment-title");
  const outcome = choiceInput("CFP_OUTCOME", ["success", "failure"], "success");
  let timeZone = input("CFP_TIMEZONE", "UTC");
  if (!validTimeZone(timeZone)) {
    warning(`timezone ${JSON.stringify(timeZone)} is not an IANA zone; using UTC.`);
    timeZone = "UTC";
  }
  const author = input("CFP_AUTHOR", DEFAULT_AUTHOR);
  client ??= createClient({ token: input("CFP_GITHUB_TOKEN") });

  // Previous state comes only from OUR sticky comment (author-filtered), never from a
  // comment anyone else could have written.
  let comments = [];
  try {
    comments = await listComments(client, repo, ctx.pr);
  } catch (err) {
    warning(`Could not read existing comments (${err.message}); history starts fresh.`);
  }
  const existing = findSticky(comments, marker, author);
  const prevState = parseState(existing?.body);
  const result = {
    outcome,
    sha: ctx.sha,
    aliasUrl: urlInput("CFP_ALIAS_URL"),
    versionUrl: urlInput("CFP_VERSION_URL"),
    versionId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input("CFP_VERSION_ID")) ? input("CFP_VERSION_ID").toLowerCase() : "",
    at: now.replace(/\.\d+Z$/, "Z"),
  };
  const state = nextState(prevState, result, intInput("CFP_HISTORY_LIMIT", 10, { min: 0, max: 50 }));
  const info = await commitInfo(client, repo, ctx.sha);
  const tv = templateVars({
    title,
    outcome,
    attempts: intInput("CFP_ATTEMPTS", 1, { min: 0, max: 100 }),
    state,
    prevState,
    info,
    ...result,
    runUrl: ctx.runUrl,
    server: ctx.serverUrl,
    repo,
    timeZone,
    now,
    label,
    pr: ctx.pr,
  });
  const body = renderTemplate(input("CFP_TEMPLATE", DEFAULT_TEMPLATE), tv)
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  const posted = await postSticky({ client, repo, number: ctx.pr, marker, body, tail: serializeState(state), author, existing, comments });
  setOutput("action", posted.action);
  setOutput("comment-id", String(posted.id ?? ""));
  setOutput("comment-url", posted.url ?? "");
  return posted;
}

if (isMain(import.meta.url))
  main(async () => {
    try {
      await previewComment();
    } catch (err) {
      if (err instanceof SecretInCommentError) throw err;
      if (boolInput("CFP_FAIL_ON_ERROR", false)) throw err;
      warning(`Preview comment not posted: ${err.message}`);
      setOutput("action", "failed");
    }
  });
