// The preview comment: what is live, for which commit, by whom, when — and a capped
// history of earlier commits' per-version URLs.
//
// History lives in a hidden state comment at the end of the body. It is read back only
// from the sticky comment this action owns (see findSticky's author filter) and every
// field is re-validated on read, so an edited comment cannot smuggle markup in.

const STATE_RE = /<!-- cloudflare-preview-state (\{[^\n]*?\}) -->/;
const SHA = /^[0-9a-f]{40}$/;
const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@/?#-]*)?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── text safety ────────────────────────────────────────────────────────────────────────
/**
 * Make untrusted text (commit subjects, names) inert in GitHub markdown: HTML is
 * escaped, markdown punctuation is backslash-escaped (no links, images, tables or
 * emphasis), control characters become spaces, and @ becomes an entity so a subject
 * like "thanks @org/everyone" renders as text and pings nobody.
 */
export function inert(text, max = 200) {
  let s = String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ");
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]()#+!|~])/g, "\\$1")
    .replace(/@/g, "&#64;");
}

const safeUrl = (u) => (typeof u === "string" && HTTPS.test(u) ? u : "");

// ── time ───────────────────────────────────────────────────────────────────────────────
export function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "2026-10-09 13:03 UTC" / "2026-10-09 09:03 EDT" — DST-aware, in the given zone. */
export function formatTime(iso, timeZone = "UTC") {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "(unknown)";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

// ── state ──────────────────────────────────────────────────────────────────────────────
function cleanEntry(e) {
  if (!e || typeof e !== "object") return null;
  const sha = typeof e.sha === "string" && SHA.test(e.sha) ? e.sha : "";
  const versionUrl = safeUrl(e.versionUrl);
  const at = typeof e.at === "string" && ISO.test(e.at) ? e.at : "";
  if (!sha || !versionUrl || !at) return null;
  return { sha, versionUrl, at, versionId: typeof e.versionId === "string" && UUID.test(e.versionId) ? e.versionId : "" };
}

export function parseState(body) {
  const empty = { current: null, aliasUrl: "", history: [] };
  const m = STATE_RE.exec(String(body ?? ""));
  if (!m) return empty;
  try {
    const raw = JSON.parse(m[1]);
    if (raw?.v !== 1) return empty;
    return {
      current: cleanEntry(raw.current),
      aliasUrl: safeUrl(raw.aliasUrl),
      history: Array.isArray(raw.history) ? raw.history.map(cleanEntry).filter(Boolean) : [],
    };
  } catch {
    return empty;
  }
}

export function serializeState(state) {
  // JSON.stringify never emits a raw newline, and none of the validated fields can hold
  // "-->", so the state comment cannot be closed early.
  return `<!-- cloudflare-preview-state ${JSON.stringify({ v: 1, ...state })} -->`;
}

/** Fold a new upload into the previous state. A failure changes nothing that is live. */
export function nextState(prev, { outcome, sha, versionUrl, versionId, aliasUrl, at }, historyLimit = 10) {
  if (outcome !== "success" || !versionUrl) return prev;
  const entry = cleanEntry({ sha, versionUrl, versionId, at });
  if (!entry) return prev;
  const older = [prev.current, ...prev.history].filter((e) => e && e.versionUrl !== entry.versionUrl);
  return {
    current: entry,
    aliasUrl: safeUrl(aliasUrl) || prev.aliasUrl,
    history: older.slice(0, Math.max(0, historyLimit)),
  };
}

// ── rendering ──────────────────────────────────────────────────────────────────────────
function person(name, login, server) {
  if (login) return `[@${login}](${server}/${encodeURIComponent(login).replace(/%5B/g, "[").replace(/%5D/g, "]")})`;
  return name ? inert(name, 80) : "";
}

export function authorsLine(info, server) {
  if (!info.authorName && !info.authorLogin) return "(unknown)";
  const seen = new Set([info.authorName.toLowerCase(), info.authorLogin.toLowerCase()].filter(Boolean));
  const parts = [person(info.authorName, info.authorLogin, server)];
  for (const c of info.coAuthors ?? []) {
    const keys = [c.name.toLowerCase(), (c.login || "").toLowerCase()].filter(Boolean);
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    parts.push(person(c.name, c.login, server));
  }
  let line = parts.filter(Boolean).join(", ");
  const committer = info.committerName;
  if (committer && committer !== "GitHub" && !seen.has(committer.toLowerCase()) && !seen.has((info.committerLogin || "").toLowerCase()))
    line += ` (committed by ${person(committer, info.committerLogin, server)})`;
  return line;
}

const short = (sha) => sha.slice(0, 7);
const commitLink = (sha, server, repo) => `[\`${short(sha)}\`](${server}/${repo}/commit/${sha})`;

function historyBlock(history, { server, repo, timeZone }) {
  if (!history.length) return "";
  const rows = history.map((e) => `| ${commitLink(e.sha, server, repo)} | ${e.versionUrl} | ${formatTime(e.at, timeZone)} |`);
  return [
    `<details><summary>Earlier commits (${history.length})</summary>`,
    "",
    "| Commit | Preview (that commit only) | Uploaded |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "</details>",
  ].join("\n");
}

/**
 * Every value a body template can use, already escaped/linked. The default body is the
 * default template rendered with these, so a custom template sees exactly the same.
 */
export function templateVars({ title, outcome, attempts, state, prevState, info, sha, aliasUrl, versionUrl, versionId, runUrl, server, repo, timeZone, now, label, pr }) {
  const live = state.current;
  const shaLink = sha ? commitLink(sha, server, repo) : "(unknown commit)";
  let status;
  if (outcome === "success" && (aliasUrl || versionUrl)) {
    status = aliasUrl
      ? `✅ **Live:** ${aliasUrl} (follows this PR)\n**This commit** (${shaLink}): ${versionUrl || "(no per-commit URL reported)"} (exactly this commit; open it if the link above looks stale)`
      : `✅ **Live for this commit** (${shaLink}): ${versionUrl}`;
  } else if (outcome === "success") {
    status = `⚠️ **Uploaded** ${shaLink}, but wrangler reported no preview URL. Preview URLs may be disabled for this Worker (\`preview_urls\`), or it uses Durable Objects, which get no preview URLs. See the [run log](${runUrl}).`;
  } else {
    const tries = attempts > 1 ? ` after ${attempts} attempts` : "";
    const stale = prevState.current
      ? `\n${prevState.aliasUrl || prevState.current.versionUrl} still serves ${commitLink(prevState.current.sha, server, repo)}, which is **not** this PR's latest commit.`
      : "\nNo preview of this PR is live.";
    status = `❌ **Upload failed** for ${shaLink}${tries}. See the [run log](${runUrl}).${stale}`;
  }
  const deployedLabel = outcome === "success" ? "Uploaded" : "Failed";
  return {
    title: inert(title, 120),
    label: inert(label, 60),
    pr: pr || "",
    status,
    outcome,
    alias_url: aliasUrl || "",
    version_url: versionUrl || "",
    version_id: versionId || "",
    sha: sha || "",
    sha7: sha ? short(sha) : "",
    commit: shaLink,
    subject: info.subject ? inert(info.subject) : "",
    authors: authorsLine(info, server),
    committed: formatTime(info.committedAt, timeZone),
    deployed: formatTime(now, timeZone),
    deployed_label: deployedLabel,
    run_url: runUrl || "",
    history: historyBlock(state.history, { server, repo, timeZone }),
    live_sha7: live ? short(live.sha) : "",
  };
}

export const DEFAULT_TEMPLATE = [
  "### {title}",
  "",
  "{status}",
  "",
  "- **Commit:** {commit} {subject}",
  "- **Author:** {authors}",
  "- **Committed:** {committed}",
  "- **{deployed_label}:** {deployed} ([run]({run_url}))",
  "",
  "{history}",
].join("\n");
