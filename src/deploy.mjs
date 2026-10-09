// `wrangler deploy` (production) with retries.
//
// Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CFP_WRANGLER_COMMAND,
//      CFP_WRANGLER_CONFIG, CFP_WRANGLER_ARGS, CFP_TAG, CFP_MESSAGE ({placeholder}
//      patterns, "" = omitted), CFP_URL (the public URL, "" = derived from the
//      deploy's triggers), CFP_LABEL, CFP_RETRIES, CFP_RETRY_DELAY, CFP_FAIL_ON_ERROR,
//      CFP_SUMMARY
// Outputs: outcome, version-id, url, targets (JSON array), worker-name, attempts

import { appendSummary, boolInput, error, info, input, intInput, isMain, main, setOutput } from "./lib/actions.mjs";
import { runContext } from "./lib/context.mjs";
import { splitWords } from "./lib/shellwords.mjs";
import { wranglerArgv } from "./lib/wrangler-command.mjs";
import { patternVars, renderPattern } from "./lib/template.mjs";
import { parseDeployStdout, productionUrl, runWithRetries } from "./lib/wrangler.mjs";

export function buildDeployArgv({ base, config, extraArgs, tag, message }) {
  const argv = [...base, "deploy"];
  if (config) argv.push("--config", config);
  if (tag) argv.push("--tag", tag);
  if (message) argv.push("--message", message);
  argv.push(...splitWords(extraArgs));
  return argv;
}

export async function deploy({ spawnImpl } = {}) {
  const ctx = runContext({ shaOverride: input("CFP_SHA") });
  const label = input("CFP_LABEL", "production");
  const vars = patternVars({ ...ctx, label });
  const argv = buildDeployArgv({
    base: wranglerArgv(input("CFP_WRANGLER_COMMAND"), { log: info }),
    config: input("CFP_WRANGLER_CONFIG"),
    extraArgs: input("CFP_WRANGLER_ARGS"),
    tag: renderPattern(input("CFP_TAG"), vars, "tag"),
    message: renderPattern(input("CFP_MESSAGE"), vars, "message"),
  });
  const run = await runWithRetries(argv, {
    attempts: intInput("CFP_RETRIES", 3, { min: 1, max: 10 }),
    delayMs: intInput("CFP_RETRY_DELAY", 10, { min: 0, max: 600 }) * 1000,
    spawnImpl,
  });
  const structured = run.output.deploy;
  const fallback = parseDeployStdout(run.stdout);
  const targets = structured?.targets?.length ? structured.targets : fallback.targets;
  const url = input("CFP_URL") || productionUrl(targets);
  const versionId = structured?.versionId || fallback.versionId;
  const outcome = run.ok ? "success" : "failure";

  setOutput("outcome", outcome);
  setOutput("attempts", String(run.attempts));
  setOutput("version-id", versionId);
  setOutput("url", url);
  setOutput("targets", JSON.stringify(targets));
  setOutput("worker-name", structured?.workerName || fallback.workerName);

  const summary = boolInput("CFP_SUMMARY", true);
  if (run.ok) {
    if (summary) appendSummary(`### ${label} deploy\n- ✅ ${url || "deployed"}${versionId ? ` (version \`${versionId}\`)` : ""}`);
    return { outcome, url, versionId, targets };
  }
  if (summary) appendSummary(`### ${label} deploy\n- ❌ failed after ${run.attempts} attempt(s)`);
  const why = run.output.failed?.message ? ` (${run.output.failed.message.split("\n")[0].slice(0, 300)})` : "";
  const message = `wrangler deploy failed after ${run.attempts} attempt(s)${why}. See the log above.`;
  if (boolInput("CFP_FAIL_ON_ERROR", true)) throw new Error(message);
  error(message);
  return { outcome, url, versionId, targets };
}

if (isMain(import.meta.url)) main(() => deploy());
