#!/usr/bin/env node
// Runs semantic-release through its programmatic API, so the released version is a
// return value rather than something scraped from a log. Used by release.yml.
//
//   node scripts/release.mjs            real run (CI only): tag, GitHub Release, comments.
//                                       Sets released / version / major / sha / tag as
//                                       step outputs when $GITHUB_OUTPUT is set.
//   node scripts/release.mjs --dry-run  replay: commit analyzer + release notes only,
//                                       with the options from .releaserc.json. Writes
//                                       nothing (no tag, no Release); prints the version
//                                       and notes. Run from a clone whose `main` has a
//                                       reachable remote (see RELEASING.md).
//
// Moving the major tag (v1) is deliberately NOT done here: it is a separate workflow
// step so the push credential is visible in the workflow, not buried in a script.

import { appendFileSync, readFileSync } from "node:fs";
import semanticRelease from "semantic-release";

const dryRun = process.argv.includes("--dry-run");
const config = JSON.parse(readFileSync(new URL("../.releaserc.json", import.meta.url), "utf8"));

const options = dryRun
  ? {
      ...config,
      dryRun: true,
      ci: false,
      plugins: config.plugins.filter((p) =>
        ["@semantic-release/commit-analyzer", "@semantic-release/release-notes-generator"].includes(Array.isArray(p) ? p[0] : p)
      ),
    }
  : config;

const result = await semanticRelease(options, { env: process.env, cwd: process.cwd() });

const output = (pairs) => {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join(""));
};

if (!result || !result.nextRelease) {
  console.log("release: no releasable commits since the last tag");
  output({ released: "false" });
} else {
  const { version, gitTag, gitHead, notes } = result.nextRelease;
  const major = version.split(".")[0];
  if (!/^\d+$/.test(major) || !/^[0-9a-f]{40}$/.test(gitHead)) throw new Error(`unexpected release ${version} @ ${gitHead}`);
  console.log(`release: ${dryRun ? "would release" : "released"} ${gitTag} (major tag v${major}) at ${gitHead}`);
  if (dryRun) console.log(`\n${notes}`);
  else output({ released: "true", version, tag: gitTag, major, sha: gitHead });
}
