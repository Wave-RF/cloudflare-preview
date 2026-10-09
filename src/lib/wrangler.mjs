// Running wrangler and reading what it did.
//
// Structured output first: when WRANGLER_OUTPUT_FILE_PATH is set, wrangler appends one
// JSON object per line (ND-JSON) to that file — a "wrangler-session" entry, then a
// "version-upload" (versions upload) or "deploy" (deploy) entry on success, or a
// "command-failed" entry on failure. Source: workers-sdk
// packages/workers-utils/src/output.ts (types) and packages/wrangler/src/versions/
// upload.ts / deploy (writers). Present in every wrangler 4.x checked (4.118, 4.130).
//
// Stdout second, as a fallback for an older wrangler or a custom wrapper that drops
// the env var: "Worker Version ID: …", "Version Preview URL: …", "Version Preview Alias
// URL: …" (versions upload), "Current Version ID: …" and the indented trigger list
// (deploy). Fixtures in test/fixtures are real CI logs.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g; // eslint-disable-line no-control-regex
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?:\/[^\s<>"'`]*)?$/;

export const stripAnsi = (s) => String(s ?? "").replace(ANSI, "");
const url = (v) => (typeof v === "string" && HTTPS_URL.test(v) ? v : "");
const uuid = (v) => (typeof v === "string" && UUID.test(v) ? v.match(UUID)[0].toLowerCase() : "");

/** Parse an ND-JSON output file's text. Unparseable lines are skipped, not fatal. */
export function parseOutputFile(text) {
  const entries = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === "object" && typeof entry.type === "string") entries.push(entry);
    } catch {
      /* a partial line from a killed process */
    }
  }
  const last = (type) => entries.filter((e) => e.type === type).at(-1);
  const session = last("wrangler-session");
  const upload = last("version-upload");
  const deploy = last("deploy");
  const failed = last("command-failed");
  return {
    wranglerVersion: typeof session?.wrangler_version === "string" ? session.wrangler_version : "",
    upload: upload
      ? {
          workerName: typeof upload.worker_name === "string" ? upload.worker_name : "",
          versionId: uuid(upload.version_id),
          versionUrl: url(upload.preview_url),
          aliasUrl: url(upload.preview_alias_url),
        }
      : null,
    deploy: deploy
      ? {
          workerName: typeof deploy.worker_name === "string" ? deploy.worker_name : "",
          versionId: uuid(deploy.version_id),
          targets: Array.isArray(deploy.targets) ? deploy.targets.filter((t) => typeof t === "string") : [],
        }
      : null,
    failed: failed
      ? {
          code: typeof failed.code === "number" ? failed.code : undefined,
          message: typeof failed.message === "string" ? failed.message : "",
          retryAfterMs: typeof failed.retry_after_ms === "number" ? failed.retry_after_ms : undefined,
        }
      : null,
  };
}

/** Fallback: read the same facts from wrangler's human output. */
export function parseUploadStdout(text, { alias = "" } = {}) {
  const lines = stripAnsi(text).split(/\r?\n/);
  const field = (label) => {
    const re = new RegExp(`^\\s*${label}:\\s*(\\S+)\\s*$`);
    for (const l of lines) {
      const m = re.exec(l);
      if (m) return m[1];
    }
    return "";
  };
  const workerName = (lines.map((l) => /^\s*Uploaded (\S+) \(/.exec(l)?.[1]).find(Boolean)) || "";
  let versionUrl = url(field("Version Preview URL"));
  let aliasUrl = url(field("Version Preview Alias URL"));
  // Last resort (very old wrangler): any workers.dev URL, the alias one by its prefix.
  if (!versionUrl && !aliasUrl) {
    const all = [...stripAnsi(text).matchAll(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev/g)].map((m) => m[0]);
    if (alias) aliasUrl = all.find((u) => u.startsWith(`https://${alias}-`)) || "";
    versionUrl = all.find((u) => u !== aliasUrl) || "";
  }
  return { workerName, versionId: uuid(field("Worker Version ID")), versionUrl, aliasUrl };
}

export function parseDeployStdout(text) {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);
  const versionId = uuid(lines.find((l) => /^\s*Current Version ID:/.test(l)) || "");
  const targets = [];
  let inTargets = false;
  for (const l of lines) {
    if (/^Deployed \S+ triggers/.test(l)) {
      inTargets = true;
      continue;
    }
    if (inTargets) {
      const m = /^\s+(\S.*)$/.exec(l);
      if (m) targets.push(m[1].trim());
      else inTargets = false;
    }
  }
  const workerName = (lines.map((l) => /^\s*Uploaded (\S+) \(/.exec(l)?.[1]).find(Boolean)) || "";
  return { workerName, versionId, targets };
}

/**
 * The public URL to show for a production deploy. Target strings (wrangler
 * triggersDeploy): "https://<name>.<sub>.workers.dev", "<host> (custom domain)",
 * "<pattern> (zone name: …)", "schedule: …". A custom domain wins, then a route with
 * no wildcard, then workers.dev.
 */
export function productionUrl(targets) {
  const clean = targets.map((t) => String(t).trim());
  const domain = clean.map((t) => /^([A-Za-z0-9.-]+) \(custom domain/.exec(t)?.[1]).find(Boolean);
  if (domain) return `https://${domain}`;
  const route = clean
    .map((t) => /^([A-Za-z0-9.-]+(?:\/[^\s*]*)?) \(zone name/.exec(t)?.[1])
    .find((r) => r && !r.includes("*"));
  if (route) return `https://${route.replace(/\/$/, "")}`;
  return clean.find((t) => /^https:\/\/[A-Za-z0-9.-]+\.workers\.dev$/.test(t)) || "";
}

/** Cloudflare error codes that no retry will fix. 10000 = authentication error. */
const NOT_RETRYABLE = new Set([10000]);
// Failures wrangler reports with no code that are just as deterministic.
const NOT_RETRYABLE_MESSAGE = [/cannot upload a new version of a Worker that does not yet exist/i];

export const isRetryable = (failed) =>
  !failed || !((failed.code !== undefined && NOT_RETRYABLE.has(failed.code)) || NOT_RETRYABLE_MESSAGE.some((re) => re.test(failed.message || "")));

/**
 * Run `argv` up to `attempts` times. Output streams through to our stdout as it comes
 * (people read it in the job log) and is captured for the fallback parser.
 *
 * @returns {Promise<{ ok: boolean, attempts: number, stdout: string, output: ReturnType<typeof parseOutputFile> }>}
 */
export async function runWithRetries(argv, { attempts = 3, delayMs = 10_000, cwd, env = process.env, log = (m) => process.stdout.write(`${m}\n`), spawnImpl = spawn } = {}) {
  const dir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "cfp-wrangler-"));
  try {
    // An empty credential (missing-secrets: ignore, with a wrapper that injects the real
    // one) is dropped rather than passed as "", so it can never shadow the wrapper's value.
    const base = { ...env };
    for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) if (base[k] === "") delete base[k];
    let last = { ok: false, attempts: 0, stdout: "", output: parseOutputFile("") };
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const outFile = join(dir, `attempt-${attempt}.ndjson`);
      const { code, stdout } = await runOnce(argv, {
        cwd,
        // CI=true: no prompts, no colour by default. WRANGLER_OUTPUT_FILE_PATH wins over
        // any inherited WRANGLER_OUTPUT_FILE_DIRECTORY, so we always know which file to read.
        env: { ...base, CI: env.CI || "true", WRANGLER_OUTPUT_FILE_PATH: outFile },
        spawnImpl,
      });
      let text = "";
      try {
        text = readFileSync(outFile, "utf8");
      } catch {
        /* wrangler never got far enough to write */
      }
      last = { ok: code === 0, attempts: attempt, stdout, output: parseOutputFile(text) };
      if (last.ok) return last;
      const failed = last.output.failed;
      if (!isRetryable(failed)) {
        log("::warning::wrangler failed in a way a retry cannot fix (an authentication error, or a Worker that has never been deployed); not retrying.");
        return last;
      }
      if (attempt < attempts) {
        const wait = Math.max(delayMs, Math.min(failed?.retryAfterMs ?? 0, 120_000));
        log(`::warning::wrangler failed (attempt ${attempt}/${attempts}, exit ${code}); retrying in ${Math.round(wait / 1000)}s.`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    return last;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MAX_CAPTURE = 4 * 1024 * 1024;

function runOnce(argv, { cwd, env, spawnImpl }) {
  return new Promise((resolve) => {
    let captured = "";
    const keep = (chunk) => {
      if (captured.length < MAX_CAPTURE) captured += chunk.toString("utf8");
    };
    let child;
    try {
      // No shell: argv[0] is executed directly, every other element is one argument.
      child = spawnImpl(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: 127, stdout: `failed to start ${argv[0]}: ${err.message}` });
      return;
    }
    child.stdout.on("data", (c) => {
      process.stdout.write(c);
      keep(c);
    });
    child.stderr.on("data", (c) => {
      process.stderr.write(c);
      keep(c);
    });
    child.on("error", (err) => {
      process.stdout.write(`failed to start ${argv[0]}: ${err.message}\n`);
      resolve({ code: 127, stdout: captured });
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: captured }));
  });
}
