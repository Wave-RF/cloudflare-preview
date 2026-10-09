// Redaction applied to EVERY comment body before it is posted. A PR comment is public on
// a public repo and permanent in practice (edits keep history), so the rule is: mask what
// can be masked, and refuse to post — fail closed — when something credential-shaped is
// present in a form this cannot mask.
//
// Three layers, in order:
//   1. literal values the caller hands in (the tokens this action itself holds);
//   2. well-known credential formats, recognisable by prefix (GitHub, AWS, Slack, JWT,
//      PEM private keys);
//   3. secret-NAMED key/value pairs (password=…, api_token: "…") anywhere in a line,
//      including values nested in JSON blobs and Terraform/Helm-style plan output.

export const REDACTED = "(redacted)";

export class SecretInCommentError extends Error {}

// ── layer 2: credential formats ────────────────────────────────────────────────────────
const KNOWN_TOKENS = [
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, // GitHub classic/OAuth/app/refresh tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g, // GitHub fine-grained PAT
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

// ── layer 3: secret-named pairs ────────────────────────────────────────────────────────
// Matched with every separator stripped: db_admin_password, dbAdminPassword and
// DB-ADMIN-PASSWORD are one name.
const SECRET_KEY =
  /passw(?:or)?d|passphrase|secret|token|credential|apikey|privatekey|accesskey|authorization|bearer|signingkey|masterkey|key$/;
// Identifier suffixes are not the credential. A shape rule, never a list of known variables.
const SAFE_SUFFIX = /(?:name|arn|id|file|path|ref|prefix|uri|url|host|region|bucket)$/;
const NOT_A_VALUE = /^(?:""|''|null|true|false|-?\d+(?:\.\d+)?|\(.*\)|#.*)[,;]?$/;
const MASKABLE = /^(?:["'].*|\S+)$/;
const OPENS_BLOCK = /^<<|^[A-Za-z0-9_.]*[([{]$/;
const KV = /^(\s*[-+~]*\s*)(["']?)([A-Za-z0-9_-]+)\2(\s*[:=]>?\s*)(.*)$/;
const PAIR =
  /(\\?["']?)([A-Za-z0-9_-]+)\1\s*[:=]>?\s*(\([^)]*\)|\\"(?:[^"\\]|\\\\|\\[^"])*\\"|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\])"']+)/g;
const QUOTED = /^(\\?["'])[\s\S]*\1$/;
const ARROW = /^\s*->\s*(?:\([^)]*\)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\])"']+)/;
const ARROW_TAIL = /\s*->\s*(?:\([^)]*\)|null)$/;
const TOKENISH = /[A-Za-z0-9+/=_-]{20,}/g;

const normalise = (key) => key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
const isSecretKey = (key) => {
  const k = normalise(key);
  return SECRET_KEY.test(k) && !SAFE_SUFFIX.test(k);
};

// Shannon entropy, bits per character: a password scores ~4.5, a repeated-word identifier ~2.5.
function entropyBits(s) {
  const freq = new Map();
  for (const c of s) freq.set(c, (freq.get(c) || 0) + 1);
  let bits = 0;
  for (const n of freq.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

export const looksLikeSecret = (text) =>
  (text.match(TOKENISH) || []).some((t) => {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(t)).length;
    return classes >= 2 && entropyBits(t) >= 3.2;
  });

function* secretPairs(line) {
  const re = new RegExp(PAIR.source, "g");
  for (;;) {
    const m = re.exec(line);
    if (!m) return;
    re.lastIndex = m.index + m[1].length + m[2].length;
    if (isSecretKey(m[2])) yield m;
  }
}

function maskPairs(line) {
  let out = "";
  let cursor = 0;
  for (const m of secretPairs(line)) {
    if (m.index < cursor) continue;
    const value = m[3];
    const q = QUOTED.exec(value);
    const inner = q ? value.slice(q[1].length, -q[1].length) : value;
    if (!inner || value.includes(REDACTED) || NOT_A_VALUE.test(value)) continue;
    if (!q && !looksLikeSecret(value)) continue;
    out += line.slice(cursor, m.index + m[0].length - value.length);
    out += q ? `${q[1]}${REDACTED}${q[1]}` : REDACTED;
    cursor = m.index + m[0].length;
    cursor += ARROW.exec(line.slice(cursor))?.[0].length ?? 0;
  }
  return out + line.slice(cursor);
}

function armedLines(lines) {
  const armed = new Array(lines.length).fill(false);
  lines.forEach((line, i) => {
    const m = KV.exec(line);
    if (!m || normalise(m[3]) !== "name") return;
    const named = /^["'](.+)["'],?$/.exec(m[5].trim());
    if (!named || !isSecretKey(named[1])) return;
    for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) armed[j] = true;
  });
  return armed;
}

function redactPairs(text) {
  const lines = text.split("\n").map(maskPairs);
  const out = lines.slice();
  const leaks = [];
  const armed = armedLines(lines);
  for (let i = 0; i < lines.length; i++) {
    const m = KV.exec(lines[i]);
    if (!m) continue;
    const [, indent, quote, key, sep, raw] = m;
    const value = raw.trim().replace(ARROW_TAIL, "");
    if (!isSecretKey(key) && !(armed[i] && normalise(key) === "value")) continue;
    if (NOT_A_VALUE.test(value)) continue;
    if (value === "" || OPENS_BLOCK.test(value) || !MASKABLE.test(value)) {
      if (lines.slice(i + 1, i + 4).some((l) => looksLikeSecret(KV.exec(l)?.[5] ?? l))) leaks.push(key);
      continue;
    }
    out[i] = `${indent}${quote}${key}${quote}${sep}"${REDACTED}"${value.endsWith(",") ? "," : ""}`;
  }
  const body = out.join("\n");
  for (const line of body.split("\n"))
    for (const m of secretPairs(line)) if (!m[3].includes(REDACTED) && looksLikeSecret(m[3])) leaks.push(m[2]);
  return { body, leaks };
}

/**
 * Redact `text`. Throws SecretInCommentError when a credential is present in a shape
 * that cannot be masked — the caller must then NOT post (and must not print the body).
 *
 * @param {string} text
 * @param {{ literals?: string[] }} [o]  exact secret values to mask wherever they appear
 */
export function redact(text, { literals = [] } = {}) {
  if (!text) return text;
  let out = String(text);

  // 1. literal values, longest first so a value containing another is masked whole.
  for (const secret of [...new Set(literals.filter((s) => typeof s === "string" && s.length >= 8))].sort(
    (a, b) => b.length - a.length,
  )) {
    out = out.split(secret).join(REDACTED);
  }

  // 2. credential formats.
  out = out.replace(PEM_BLOCK, REDACTED);
  if (PEM_BEGIN.test(out))
    throw new SecretInCommentError(
      "refusing to post: the body contains the start of a PEM private key with no matching END line, so it cannot be masked.",
    );
  for (const re of KNOWN_TOKENS) out = out.replace(re, REDACTED);

  // 3. secret-named pairs.
  const { body, leaks } = redactPairs(out);
  if (leaks.length)
    throw new SecretInCommentError(
      `refusing to post: a high-entropy value sits on ${[...new Set(leaks)].join(", ")} in a shape this cannot mask. Read the run log and remove it from the body.`,
    );
  return body;
}
