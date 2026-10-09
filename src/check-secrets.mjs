// Are the Cloudflare credentials present? Fork PRs and Dependabot runs get no
// repository secrets, so "missing" is normal there and the default is to skip with a
// warning rather than red the PR. `missing-secrets: fail` is for jobs where a missing
// secret can only mean misconfiguration (a production deploy on the default branch).
// `ignore` skips the check, for a wrangler-command that brings its own credentials
// (a wrapper script that injects secrets from a secrets manager, then runs wrangler).
//
// Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CFP_MISSING_SECRETS (skip|fail|ignore), CFP_WHAT
// Out: ok=true|false

import { choiceInput, input, main, setOutput, warning } from "./lib/actions.mjs";

main(async () => {
  const mode = choiceInput("CFP_MISSING_SECRETS", ["skip", "fail", "ignore"], "skip");
  const what = input("CFP_WHAT", "Cloudflare upload");
  const missing = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter((k) => !process.env[k]);
  if (!missing.length || mode === "ignore") {
    setOutput("ok", "true");
    return;
  }
  setOutput("ok", "false");
  const message = `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} empty, so the ${what} was skipped. Fork PRs and Dependabot runs get no repository secrets; elsewhere, check that the secrets are set and passed to this action's inputs.`;
  if (mode === "fail") throw new Error(message);
  warning(message);
});
