// `wrangler versions upload` with retries and a stable per-PR alias.
//
// Env (set by upload/action.yml and action.yml; see their input docs):
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID    read by wrangler itself
//   CFP_WRANGLER_COMMAND  how to invoke wrangler ("pnpm exec wrangler")
//   CFP_WRANGLER_CONFIG   --config path ("" = wrangler's own lookup)
//   CFP_WRANGLER_ARGS     extra arguments, split without a shell
//   CFP_ALIAS, CFP_TAG, CFP_MESSAGE   {placeholder} patterns ("" = flag omitted)
//   CFP_LABEL, CFP_PR, CFP_SHA        context overrides
//   CFP_RETRIES, CFP_RETRY_DELAY      attempts (≥1) and seconds between them
//   CFP_FAIL_ON_ERROR     exit 1 when the upload fails (default true)
//   CFP_SUMMARY           write a job-summary line (default true)
// Outputs: outcome, alias-url, version-url, version-id, url, worker-name, alias, attempts

import { appendSummary, boolInput, error, info, input, intInput, isMain, main, notice, setOutput, warning } from "./lib/actions.mjs";
import { runContext } from "./lib/context.mjs";
import { splitWords } from "./lib/shellwords.mjs";
import { wranglerArgv } from "./lib/wrangler-command.mjs";
import { patternVars, renderPattern, sanitizeAlias } from "./lib/template.mjs";
import { parseUploadStdout, runWithRetries } from "./lib/wrangler.mjs";

const needsPr = (pattern, pr) => (pattern.includes("{pr}") && !pr ? "" : pattern);

export function buildUploadArgv({ base, config, extraArgs, alias, tag, message }) {
  const argv = [...base, "versions", "upload"];
  if (config) argv.push("--config", config);
  if (alias) argv.push("--preview-alias", alias);
  if (tag) argv.push("--tag", tag);
  if (message) argv.push("--message", message);
  argv.push(...splitWords(extraArgs));
  return argv;
}

export async function upload({ spawnImpl } = {}) {
  const ctx = runContext({ prOverride: input("CFP_PR"), shaOverride: input("CFP_SHA") });
  const label = input("CFP_LABEL", "preview");
  const vars = patternVars({ ...ctx, label });

  // No PR (push, dispatch): {pr} has nothing to say, so the alias falls back to the
  // branch name — the same thing wrangler's own WRANGLER_CI_GENERATE_PREVIEW_ALIAS does.
  let aliasPattern = input("CFP_ALIAS");
  if (aliasPattern.includes("{pr}") && !ctx.pr) aliasPattern = ctx.branch ? "{branch}" : "";
  const alias = aliasPattern ? sanitizeAlias(renderPattern(aliasPattern, vars, "alias")) : "";
  if (aliasPattern && !alias) warning(`alias pattern ${JSON.stringify(aliasPattern)} rendered to nothing usable; uploading without --preview-alias.`);

  const argv = buildUploadArgv({
    base: wranglerArgv(input("CFP_WRANGLER_COMMAND"), { log: info }),
    config: input("CFP_WRANGLER_CONFIG"),
    extraArgs: input("CFP_WRANGLER_ARGS"),
    alias,
    // Outside a PR, a tag/message that names {pr} would read "pr-": omit it instead.
    tag: renderPattern(needsPr(input("CFP_TAG"), ctx.pr), vars, "tag"),
    message: renderPattern(needsPr(input("CFP_MESSAGE"), ctx.pr), vars, "message"),
  });
  const attempts = intInput("CFP_RETRIES", 3, { min: 1, max: 10 });
  const delayMs = intInput("CFP_RETRY_DELAY", 10, { min: 0, max: 600 }) * 1000;
  const failOnError = boolInput("CFP_FAIL_ON_ERROR", true);

  const run = await runWithRetries(argv, { attempts, delayMs, spawnImpl });

  // Structured output first; stdout only for the fields it did not give us.
  const structured = run.output.upload;
  const fallback = parseUploadStdout(run.stdout, { alias });
  const result = {
    workerName: structured?.workerName || fallback.workerName,
    versionId: structured?.versionId || fallback.versionId,
    versionUrl: structured?.versionUrl || fallback.versionUrl,
    aliasUrl: structured?.aliasUrl || fallback.aliasUrl,
  };
  const outcome = run.ok ? "success" : "failure";

  setOutput("outcome", outcome);
  setOutput("attempts", String(run.attempts));
  setOutput("alias", alias);
  setOutput("alias-url", result.aliasUrl);
  setOutput("version-url", result.versionUrl);
  setOutput("version-id", result.versionId);
  setOutput("worker-name", result.workerName);
  setOutput("url", result.aliasUrl || result.versionUrl);
  setOutput("source", structured ? "output-file" : "stdout");

  const summary = boolInput("CFP_SUMMARY", true);
  if (run.ok) {
    if (!structured) notice("wrangler wrote no version-upload entry to WRANGLER_OUTPUT_FILE_PATH; URLs were read from its stdout instead.");
    if (!result.aliasUrl && !result.versionUrl)
      warning("The upload succeeded but wrangler reported no preview URL. Preview URLs need `preview_urls` enabled (it defaults to the workers_dev setting) and are not generated for Workers that use Durable Objects.");
    else if (alias && !result.aliasUrl)
      warning(`The upload succeeded but no alias URL was reported for --preview-alias ${alias}. alias + "-" + worker name must fit 63 characters.`);
    if (summary) {
      const lines = [`### ${label} preview`];
      if (result.aliasUrl) lines.push(`- Alias (follows the PR): ${result.aliasUrl}`);
      if (result.versionUrl) lines.push(`- This commit: ${result.versionUrl}`);
      if (result.versionId) lines.push(`- Version: \`${result.versionId}\``);
      appendSummary(lines.join("\n"));
    }
  } else {
    const why = run.output.failed?.message ? ` (${run.output.failed.message.split("\n")[0].slice(0, 300)})` : "";
    const message = `wrangler versions upload failed after ${run.attempts} attempt(s)${why}. See the log above.`;
    if (summary) appendSummary(`### ${label} preview\n- ❌ upload failed after ${run.attempts} attempt(s)`);
    if (failOnError) throw new Error(message);
    error(message);
  }
  return { outcome, ...result, alias, attempts: run.attempts };
}

if (isMain(import.meta.url)) main(() => upload());
