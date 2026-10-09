// {placeholder} rendering for the short patterns (alias, tag, message, marker,
// environment) and for the comment body template.
//
// One pass, function replacement: a substituted value is never scanned again, so a
// commit subject containing "{alias_url}" stays literal, and no value is ever used as a
// format string or reaches a shell.

import { createHash } from "node:crypto";

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;

/** Strict: an unknown {name} is a typo in the workflow, so it throws. */
export function renderPattern(pattern, vars, what = "pattern") {
  return String(pattern).replace(PLACEHOLDER, (whole, name) => {
    if (!Object.hasOwn(vars, name))
      throw new Error(`${what} ${JSON.stringify(pattern)} uses unknown placeholder {${name}}; known: ${Object.keys(vars).map((k) => `{${k}}`).join(" ")}`);
    return String(vars[name] ?? "");
  });
}

/** Lenient: markdown may legitimately contain {words}; unknown names are left as written. */
export function renderTemplate(template, vars) {
  return String(template).replace(PLACEHOLDER, (whole, name) => (Object.hasOwn(vars, name) ? String(vars[name] ?? "") : whole));
}

// Cloudflare's alias rules (developers.cloudflare.com/workers/configuration/previews/):
// lowercase letters, digits and dashes, starting with a letter; alias + "-" + worker
// name must fit one 63-character DNS label. wrangler's own generator
// (generatePreviewAlias in workers-sdk) truncates with a 4-hex hash; so do we.
const MAX_DNS_LABEL = 63;
const HASH_LENGTH = 4;

export function sanitizeAlias(raw, workerName = "") {
  let alias = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!alias) return "";
  if (!/^[a-z]/.test(alias)) alias = `p-${alias}`;
  if (workerName) {
    const room = MAX_DNS_LABEL - workerName.length - 1;
    if (alias.length > room) {
      const keep = room - HASH_LENGTH - 1;
      if (keep < 1) return "";
      const hash = createHash("sha256").update(String(raw)).digest("hex").slice(0, HASH_LENGTH);
      alias = `${alias.slice(0, keep).replace(/-+$/, "")}-${hash}`;
    }
  }
  return alias;
}

/** Variables available to every pattern. */
export function patternVars({ pr, sha, branch, label, runId = process.env.GITHUB_RUN_ID || "" }) {
  return {
    pr: pr || "",
    sha: sha || "",
    sha7: (sha || "").slice(0, 7),
    branch: branch || "",
    label: label || "",
    run: runId,
  };
}
