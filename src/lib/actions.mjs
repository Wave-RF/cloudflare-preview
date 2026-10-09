// Minimal stand-ins for @actions/core, so the scripts run with no npm install.
//
// Composite actions do NOT expose `inputs.*` to the scripts they run: every value
// reaches a script through an explicit `env:` entry in the action.yml, named CFP_*.
// Nothing here ever builds a shell command — values are read from the environment
// and written to files GitHub reads (GITHUB_OUTPUT, GITHUB_STEP_SUMMARY).

import { randomBytes } from "node:crypto";
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Read a CFP_* input. Empty and unset are the same thing (an unset `with:` arrives as ""). */
export function input(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

export function boolInput(name, fallback = false) {
  const raw = input(name, "").trim().toLowerCase();
  if (raw === "") return fallback;
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false, got ${JSON.stringify(raw)}`);
}

export function intInput(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = input(name, "").trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  return n;
}

export function choiceInput(name, choices, fallback) {
  const raw = input(name, fallback).trim();
  if (!choices.includes(raw)) throw new Error(`${name} must be one of ${choices.join(", ")}, got ${JSON.stringify(raw)}`);
  return raw;
}

// A heredoc delimiter that cannot appear in the value, so a value can never close
// the block early and inject a second output (the GITHUB_OUTPUT injection class).
function fileCommand(file, key, value) {
  const text = String(value ?? "");
  let delimiter;
  do delimiter = `cfp_${randomBytes(12).toString("hex")}`;
  while (text.includes(delimiter));
  appendFileSync(file, `${key}<<${delimiter}\n${text}\n${delimiter}\n`);
}

export function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) fileCommand(file, key, value);
  else process.stdout.write(`[output] ${key}=${value}\n`);
}

export function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

// Workflow-command escaping (the runner's own rules): data escapes % \r \n,
// properties additionally : and ,. Without it, a message could end the command.
const escapeData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

function command(kind, message, props = {}) {
  const p = Object.entries(props)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${escapeProperty(v)}`)
    .join(",");
  process.stdout.write(`::${kind}${p ? ` ${p}` : ""}::${escapeData(message)}\n`);
}

export const notice = (m, props) => command("notice", m, props);
export const warning = (m, props) => command("warning", m, props);
export const error = (m, props) => command("error", m, props);

/** Register a value with the runner's log masker. Multi-line values are masked line by line. */
export function mask(value) {
  if (!value) return;
  for (const line of String(value).split(/\r?\n/)) if (line.trim()) command("add-mask", line);
}

export function info(message) {
  process.stdout.write(`${message}\n`);
}

/** Run an entry point: any thrown error becomes one ::error:: line and exit 1. */
export async function main(fn) {
  try {
    await fn();
  } catch (err) {
    error(err?.message || String(err));
    process.exitCode = 1;
  }
}

/** True when `metaUrl` is the script node was started with (so tests can import it). */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
