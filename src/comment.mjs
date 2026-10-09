// Generic sticky comment: any body, any marker. Post it once, then edit it in place.
//
// Env: CFP_GITHUB_TOKEN, CFP_MARKER, CFP_BODY | CFP_BODY_FILE, CFP_NUMBER,
//      CFP_MODE (upsert|delete), CFP_AUTHOR, CFP_MASK_VALUES (newline-separated
//      literals to redact), CFP_FAIL_ON_ERROR
// Outputs: comment-id, comment-url, action (created|updated|deleted|none|skipped|failed)
// Permissions: pull-requests: write (a PR) or issues: write (an issue)

import { readFileSync } from "node:fs";
import { appendSummary, boolInput, choiceInput, input, isMain, main, setOutput, warning } from "./lib/actions.mjs";
import { runContext } from "./lib/context.mjs";
import { createClient, repoFromEnv } from "./lib/github.mjs";
import { SecretInCommentError } from "./lib/redact.mjs";
import { DEFAULT_AUTHOR, assembleBody, deleteSticky, findSticky, listComments, upsertSticky, validateMarker } from "./lib/sticky.mjs";

export function literalsFromEnv() {
  return [input("CFP_GITHUB_TOKEN"), process.env.CLOUDFLARE_API_TOKEN, ...input("CFP_MASK_VALUES").split(/\r?\n/)].filter(Boolean);
}

/** Shared by comment.mjs and preview-comment.mjs: post `body`, degrade to a warning on API failure. */
export async function postSticky({ client, repo, number, marker, body, tail = "", author, existing, comments }) {
  const assembled = assembleBody({ marker, body, tail, literals: literalsFromEnv() }); // throws on an unmaskable secret
  try {
    existing ??= findSticky(comments ?? (await listComments(client, repo, number)), marker, author);
    return { ...(await upsertSticky(client, { repo, number, marker, body: assembled, existing })), body: assembled };
  } catch (err) {
    if (boolInput("CFP_FAIL_ON_ERROR", false)) throw err;
    warning(`Comment not posted on #${number} (${err.message}). The intended body is in the job summary.`);
    appendSummary(`<details><summary>Comment not posted on #${number}: intended body</summary>\n\n\`\`\`\`markdown\n${assembled}\n\`\`\`\`\n\n</details>`);
    return { action: "failed", id: "", url: "", body: assembled };
  }
}

export async function comment({ client } = {}) {
  const repo = repoFromEnv();
  const marker = validateMarker(input("CFP_MARKER"));
  const ctx = runContext({ prOverride: input("CFP_NUMBER") });
  const number = ctx.pr;
  if (!number) {
    warning("No pull request or issue number (input number, or a pull_request event): nothing to comment on.");
    setOutput("action", "skipped");
    return { action: "skipped" };
  }
  const mode = choiceInput("CFP_MODE", ["upsert", "delete"], "upsert");
  const author = input("CFP_AUTHOR", DEFAULT_AUTHOR);
  client ??= createClient({ token: input("CFP_GITHUB_TOKEN") });

  let result;
  if (mode === "delete") {
    const existing = findSticky(await listComments(client, repo, number), marker, author);
    result = await deleteSticky(client, { repo, existing });
  } else {
    const file = input("CFP_BODY_FILE");
    const body = file ? readFileSync(file, "utf8") : input("CFP_BODY");
    if (!body.trim()) throw new Error("comment body is empty (input body or body-file)");
    result = await postSticky({ client, repo, number, marker, body, author });
  }
  setOutput("action", result.action);
  setOutput("comment-id", String(result.id ?? ""));
  setOutput("comment-url", result.url ?? "");
  return result;
}

if (isMain(import.meta.url))
  main(async () => {
    try {
      await comment();
    } catch (err) {
      // An unmaskable credential always fails the step, and its body is never printed.
      if (err instanceof SecretInCommentError) throw err;
      if (boolInput("CFP_FAIL_ON_ERROR", false)) throw err;
      warning(`Comment not posted: ${err.message}`);
      setOutput("action", "failed");
    }
  });
