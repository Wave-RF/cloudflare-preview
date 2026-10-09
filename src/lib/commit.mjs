// Commit facts for the comment: subject, author(s) with @-links, and when.
//
// One REST call (GET /repos/{repo}/commits/{sha}) gives the message, the author and
// committer names/emails/dates, and the GitHub logins GitHub matched by verified email.
// It works whatever the working tree is — including the trusted-checkout pattern, where
// the tree is the default branch and the PR head commit is not present locally.
// Co-authors come from `Co-authored-by:` trailers; their login is read from a
// github.com noreply address when that is what they used, else the plain name is shown.

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

export function loginFromEmail(email) {
  const m = /^(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com$/i.exec(String(email ?? "").trim());
  return m && LOGIN.test(m[1]) ? m[1] : "";
}

/** Co-authored-by trailers → [{ name, email }], de-duplicated by name. */
export function coAuthors(message) {
  const out = [];
  for (const line of String(message ?? "").split(/\r?\n/)) {
    const m = /^\s*co-authored-by:\s*(.*?)\s*(?:<([^>]*)>)?\s*$/i.exec(line);
    if (!m || !m[1]) continue;
    out.push({ name: m[1].trim(), email: (m[2] || "").trim() });
  }
  return out;
}

/**
 * @param {{ request: Function }} client
 * @returns {Promise<{ sha, subject, authorName, authorLogin, committerName, committerLogin, coAuthors, committedAt }>}
 */
export async function commitInfo(client, repo, sha) {
  const empty = { sha, subject: "", authorName: "", authorLogin: "", committerName: "", committerLogin: "", coAuthors: [], committedAt: "" };
  if (!client || !sha) return empty;
  try {
    const { data } = await client.request("GET", `/repos/${repo}/commits/${sha}`);
    const c = data?.commit ?? {};
    const message = String(c.message ?? "");
    const authorLogin = LOGIN.test(data?.author?.login ?? "") ? data.author.login : loginFromEmail(c.author?.email);
    const committerLogin = LOGIN.test(data?.committer?.login ?? "") ? data.committer.login : loginFromEmail(c.committer?.email);
    return {
      sha,
      subject: message.split(/\r?\n/)[0] ?? "",
      authorName: String(c.author?.name ?? ""),
      authorLogin,
      committerName: String(c.committer?.name ?? ""),
      committerLogin,
      coAuthors: coAuthors(message).map((a) => ({ ...a, login: loginFromEmail(a.email) })),
      committedAt: String(c.committer?.date ?? c.author?.date ?? ""),
    };
  } catch {
    // Best effort: the comment still posts, with less detail, if this call fails.
    return empty;
  }
}
