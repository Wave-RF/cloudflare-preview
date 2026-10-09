#!/usr/bin/env node
// Stands in for wrangler in the end-to-end tests. Behaviour comes from env:
//   FAKE_STDOUT        fixture file printed to stdout
//   FAKE_NDJSON        fixture file appended to WRANGLER_OUTPUT_FILE_PATH (unless FAKE_IGNORE_OUTPUT_FILE)
//   FAKE_FAIL_TIMES    fail (exit 1) this many times first, counting in FAKE_STATE
//   FAKE_FAIL_NDJSON   fixture appended on a failing attempt
//   FAKE_ARGV_LOG      every invocation's argv appended here as one JSON line
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const env = process.env;
if (env.FAKE_ARGV_LOG) appendFileSync(env.FAKE_ARGV_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);

let count = 0;
if (env.FAKE_STATE && existsSync(env.FAKE_STATE)) count = Number(readFileSync(env.FAKE_STATE, "utf8")) || 0;
if (env.FAKE_STATE) writeFileSync(env.FAKE_STATE, String(count + 1));

const out = env.WRANGLER_OUTPUT_FILE_PATH;
if (count < Number(env.FAKE_FAIL_TIMES || 0)) {
  if (out && env.FAKE_FAIL_NDJSON) appendFileSync(out, readFileSync(env.FAKE_FAIL_NDJSON, "utf8"));
  process.stderr.write("✘ [ERROR] A request to the Cloudflare API failed.\n");
  process.exit(1);
}
if (out && env.FAKE_NDJSON && !env.FAKE_IGNORE_OUTPUT_FILE) appendFileSync(out, readFileSync(env.FAKE_NDJSON, "utf8"));
if (env.FAKE_STDOUT) process.stdout.write(readFileSync(env.FAKE_STDOUT, "utf8"));
