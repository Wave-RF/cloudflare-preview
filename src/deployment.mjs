// A GitHub Deployment + status, so the PR shows "View deployment" and the repo's
// Environments page knows what is where.
//
// Modes, picked by CFP_STATE and CFP_DEPLOYMENT_ID:
//   no id, any state but inactive → create a deployment for the commit, then post the status
//   id given                      → post the status on that deployment (start → finish)
//   no id, state inactive         → mark every deployment of this PR in the environment
//                                   inactive (for a closed PR); with CFP_DELETE, delete them too
// After a `success`, earlier deployments of the same PR in the same environment are
// marked inactive. GitHub's auto_inactive does not do this for transient environments
// (docs.github.com/rest/deployments/statuses: it applies to "non-transient,
// non-production" deployments only), so we do it explicitly.
//
// Env: CFP_GITHUB_TOKEN, CFP_ENVIRONMENT (pattern), CFP_LABEL, CFP_STATE,
//      CFP_DEPLOYMENT_ID, CFP_ENVIRONMENT_URL, CFP_LOG_URL, CFP_DESCRIPTION,
//      CFP_TRANSIENT, CFP_PRODUCTION, CFP_PR, CFP_SHA, CFP_DEACTIVATE_PREVIOUS,
//      CFP_DELETE, CFP_FAIL_ON_ERROR
// Outputs: deployment-id, environment, deactivated, deleted
// Permissions: deployments: write

import { boolInput, choiceInput, input, isMain, main, setOutput, warning } from "./lib/actions.mjs";
import { runContext } from "./lib/context.mjs";
import { createClient, repoFromEnv } from "./lib/github.mjs";
import { patternVars, renderPattern } from "./lib/template.mjs";

const STATES = ["queued", "in_progress", "pending", "success", "failure", "error", "inactive"];
const HTTPS = /^https:\/\/\S+$/;
const PAYLOAD_SOURCE = "cloudflare-preview";

const prOf = (d) => {
  let p = d?.payload;
  if (typeof p === "string") {
    try {
      p = JSON.parse(p);
    } catch {
      return "";
    }
  }
  return p && p.source === PAYLOAD_SOURCE ? String(p.pr ?? "") : "";
};

/**
 * Mark this PR's deployments in `environment` inactive (all but `keepId`), and with
 * `remove` also DELETE them. GitHub only lets you delete an inactive deployment when the
 * repo has more than one (docs.github.com/rest/deployments/deployments#delete-a-deployment),
 * so deactivation always comes first.
 */
export async function deactivateOthers(client, repo, { environment, pr, keepId, remove = false }) {
  const list = await client.paginate(`/repos/${repo}/deployments?environment=${encodeURIComponent(environment)}`, { maxPages: 10 });
  let deactivated = 0;
  let deleted = 0;
  for (const d of list) {
    if (String(d.id) === String(keepId) || prOf(d) !== String(pr)) continue;
    const { data: statuses } = await client.request("GET", `/repos/${repo}/deployments/${d.id}/statuses?per_page=1`);
    if (!(Array.isArray(statuses) && statuses[0]?.state === "inactive")) {
      await client.request("POST", `/repos/${repo}/deployments/${d.id}/statuses`, {
        state: "inactive",
        description: keepId ? "Superseded by a newer commit" : "Pull request closed",
      });
      deactivated++;
    }
    if (remove) {
      await client.request("DELETE", `/repos/${repo}/deployments/${d.id}`);
      deleted++;
    }
  }
  return { deactivated, deleted };
}

export async function deployment({ client } = {}) {
  const ctx = runContext({ prOverride: input("CFP_PR"), shaOverride: input("CFP_SHA") });
  const repo = repoFromEnv();
  const label = input("CFP_LABEL", "preview");
  const defaultEnvironment = label === "preview" ? "preview" : "preview/{label}";
  const environment = renderPattern(input("CFP_ENVIRONMENT", defaultEnvironment), patternVars({ ...ctx, label }), "environment");
  if (!environment || environment.length > 255) throw new Error(`environment must be 1-255 characters, got ${JSON.stringify(environment)}`);
  const state = choiceInput("CFP_STATE", STATES, "success");
  const production = boolInput("CFP_PRODUCTION", false);
  const transient = boolInput("CFP_TRANSIENT", !production);
  const environmentUrl = input("CFP_ENVIRONMENT_URL");
  if (environmentUrl && !HTTPS.test(environmentUrl)) throw new Error(`environment-url must be an https URL, got ${JSON.stringify(environmentUrl)}`);
  const description = input("CFP_DESCRIPTION").slice(0, 140); // the API's limit
  let id = input("CFP_DEPLOYMENT_ID");
  if (id && !/^[1-9][0-9]*$/.test(id)) throw new Error(`deployment-id must be numeric, got ${JSON.stringify(id)}`);
  client ??= createClient({ token: input("CFP_GITHUB_TOKEN") });
  setOutput("environment", environment);

  if (!id && state === "inactive") {
    if (!ctx.pr) throw new Error("state inactive with no deployment-id deactivates a PR's deployments, but there is no pull request number");
    const remove = boolInput("CFP_DELETE", false);
    const n = await deactivateOthers(client, repo, { environment, pr: ctx.pr, keepId: "", remove });
    setOutput("deployment-id", "");
    setOutput("deactivated", String(n.deactivated));
    setOutput("deleted", String(n.deleted));
    return { id: "", ...n };
  }

  if (!id) {
    if (!ctx.sha) throw new Error("no commit sha to deploy (input sha, or a pull_request/push event)");
    const { data } = await client.request("POST", `/repos/${repo}/deployments`, {
      ref: ctx.sha,
      environment,
      description,
      // A preview is not gated on other checks and must never merge anything.
      auto_merge: false,
      required_contexts: [],
      transient_environment: transient,
      production_environment: production,
      payload: { source: PAYLOAD_SOURCE, pr: ctx.pr ? Number(ctx.pr) : null, label },
    });
    if (!data?.id) throw new Error(`GitHub did not create a deployment: ${data?.message ?? "no id in response"}`);
    id = String(data.id);
  }

  const status = { state, log_url: input("CFP_LOG_URL", ctx.runUrl), description };
  if (environmentUrl && state === "success") status.environment_url = environmentUrl;
  await client.request("POST", `/repos/${repo}/deployments/${id}/statuses`, status);
  setOutput("deployment-id", id);

  let deactivated = 0;
  if (state === "success" && ctx.pr && boolInput("CFP_DEACTIVATE_PREVIOUS", true))
    ({ deactivated } = await deactivateOthers(client, repo, { environment, pr: ctx.pr, keepId: id }));
  return { id, deactivated };
}

if (isMain(import.meta.url))
  main(async () => {
    try {
      await deployment();
    } catch (err) {
      // The deployment record is a convenience: by default a GitHub API problem warns
      // instead of failing the job that did the real work.
      if (boolInput("CFP_FAIL_ON_ERROR", false)) throw err;
      warning(`GitHub deployment not recorded: ${err.message}`);
      setOutput("deployment-id", input("CFP_DEPLOYMENT_ID"));
    }
  });
