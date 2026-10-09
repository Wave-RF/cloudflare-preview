// The sticky comment: one comment per (issue, marker), found by a hidden marker at the
// start of its body and edited in place, so re-runs never stack up comments.

import { redact } from "./redact.mjs";

/** GitHub's hard limit on an issue-comment body, in characters. */
export const LIMIT = 65536;
const MARGIN = 256;
export const TRUNCATED = "\n\n… (truncated: this comment hit GitHub's 65,536-character limit; see the run log)\n";

/** A marker must be one HTML comment, so it renders as nothing and cannot carry markup. */
export function validateMarker(marker) {
  if (!/^<!--[^\n]*?-->$/.test(marker) || marker.slice(4, -3).includes("--"))
    throw new Error(`comment marker must be a single-line HTML comment like <!-- preview:docs -->, got ${JSON.stringify(marker)}`);
  return marker;
}

/**
 * Marker first, then the redacted body, cut under the limit on a line boundary.
 * Redaction runs before measuring, so a mask can never push the body back over.
 * `tail` (e.g. a state comment) is kept intact at the end when the body is cut.
 */
export function assembleBody({ marker, body, tail = "", literals = [], limit = LIMIT }) {
  const clean = redact(body ?? "", { literals });
  const cleanTail = tail ? `\n${redact(tail, { literals })}` : "";
  const head = `${marker}\n`;
  const budget = limit - MARGIN - head.length - cleanTail.length;
  if (clean.length <= budget) return `${head}${clean}${cleanTail}`;
  let cut = clean.slice(0, Math.max(0, budget - TRUNCATED.length));
  const nl = cut.lastIndexOf("\n");
  if (nl > cut.length / 2) cut = cut.slice(0, nl);
  // Never leave a <details> open or a code fence unterminated: close what we cut into.
  const fences = (cut.match(/^```/gm) || []).length;
  if (fences % 2) cut += "\n```";
  const opened = (cut.match(/<details>/g) || []).length - (cut.match(/<\/details>/g) || []).length;
  for (let i = 0; i < opened; i++) cut += "\n</details>";
  return `${head}${cut}${TRUNCATED}${cleanTail}`;
}

/**
 * Find the sticky comment: the OLDEST comment whose body starts with the marker and,
 * when `author` is set, whose author login matches. Oldest so that a duplicate created
 * by a race never becomes the one that is updated forever.
 *
 * `author` exists because anyone who can comment on the PR can also post a body that
 * starts with the marker; filtering on the poster's identity stops a stranger's comment
 * being adopted (and its "state" trusted). `*` disables the filter.
 */
export function findSticky(comments, marker, author) {
  return comments.find(
    (c) =>
      typeof c?.body === "string" &&
      c.body.startsWith(marker) &&
      (!author || author === "*" || c.user?.login?.toLowerCase() === author.toLowerCase()),
  );
}

export async function listComments(client, repo, number) {
  return client.paginate(`/repos/${repo}/issues/${number}/comments`, { maxPages: 30 });
}

/** Create or update the sticky comment. Returns { action, id, url }. */
export async function upsertSticky(client, { repo, number, marker, body, existing }) {
  if (existing) {
    const { data } = await client.request("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
    return { action: "updated", id: data?.id ?? existing.id, url: data?.html_url ?? existing.html_url ?? "" };
  }
  const { data } = await client.request("POST", `/repos/${repo}/issues/${number}/comments`, { body });
  return { action: "created", id: data?.id ?? "", url: data?.html_url ?? "" };
}

export async function deleteSticky(client, { repo, existing }) {
  if (!existing) return { action: "none", id: "", url: "" };
  await client.request("DELETE", `/repos/${repo}/issues/comments/${existing.id}`);
  return { action: "deleted", id: existing.id, url: "" };
}

/** The default sticky author: the identity GITHUB_TOKEN posts as. */
export const DEFAULT_AUTHOR = "github-actions[bot]";
