// The default `wrangler-command`: the repo's own wrangler, run through its own package
// manager, and NEVER a download.
//
// Walk up from the working directory to the repository root; the first directory that
// holds a lockfile decides:
//
//   pnpm-lock.yaml            → pnpm exec wrangler          (node_modules/.bin, incl. the
//                                                            workspace root; no registry)
//   yarn.lock                 → yarn wrangler               (runs a dependency's binary;
//                                                            `yarn dlx` is the one that downloads)
//   bun.lock / bun.lockb      → bunx --no-install wrangler  (plain `bunx` installs a missing
//                                                            package into a global cache)
//   package-lock.json,
//   npm-shrinkwrap.json, none → <dir>/node_modules/.bin/wrangler, found by walking up
//                               (`npx --no` still queries the registry, and can run a copy
//                               from npm's npx cache rather than the repo's install)
//
// An explicit `wrangler-command` input always wins.

import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { splitWords } from "./shellwords.mjs";

const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const COMMANDS = {
  pnpm: ["pnpm", "exec", "wrangler"],
  yarn: ["yarn", "wrangler"],
  bun: ["bunx", "--no-install", "wrangler"],
};

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Directories from `start` up to and including `root` (or the filesystem root). */
function* upward(start, root) {
  let dir = resolve(start);
  const stop = root ? resolve(root) : "";
  for (;;) {
    yield dir;
    if (dir === stop) return;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/**
 * The repository root to stop at: GITHUB_WORKSPACE when `start` is inside it, else the
 * nearest directory with a `.git`, else none (walk to the filesystem root).
 */
export function repoRoot(start, workspace = process.env.GITHUB_WORKSPACE) {
  const abs = resolve(start);
  if (workspace) {
    const rel = relative(resolve(workspace), abs);
    if (rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel))) return resolve(workspace);
  }
  for (const dir of upward(abs)) if (existsSync(join(dir, ".git"))) return dir;
  return "";
}

/**
 * @returns {{ argv: string[], manager: string, lockfile: string, reason: string }}
 * argv is empty when nothing local was found (the caller fails with `reason`).
 */
export function detectWranglerCommand(cwd, { workspace = process.env.GITHUB_WORKSPACE } = {}) {
  const root = repoRoot(cwd, workspace);
  let manager = "npm";
  let lockfile = "";
  outer: for (const dir of upward(cwd, root)) {
    for (const [file, pm] of LOCKFILES) {
      if (existsSync(join(dir, file))) {
        manager = pm;
        lockfile = join(dir, file);
        break outer;
      }
    }
  }
  if (COMMANDS[manager]) return { argv: COMMANDS[manager], manager, lockfile, reason: `found ${lockfile}` };

  for (const dir of upward(cwd, root)) {
    const bin = join(dir, "node_modules", ".bin", "wrangler");
    if (existsSync(bin) && !isDir(bin)) return { argv: [bin], manager, lockfile, reason: lockfile ? `found ${lockfile}` : "no lockfile" };
  }
  return {
    argv: [],
    manager,
    lockfile,
    reason: `wrangler is not installed: no node_modules/.bin/wrangler between ${resolve(cwd)} and ${root || "the filesystem root"}. Add wrangler as a devDependency and install it before this step, or set wrangler-command.`,
  };
}

/** The argv prefix to run wrangler with: the explicit command, else the detected one. */
export function wranglerArgv(explicit, { cwd = process.cwd(), log = () => {} } = {}) {
  if (explicit && explicit.trim()) {
    const argv = splitWords(explicit);
    if (!argv.length || !argv[0]) throw new Error("wrangler-command is empty");
    return argv;
  }
  const found = detectWranglerCommand(cwd);
  if (!found.argv.length) throw new Error(found.reason);
  log(`wrangler-command not set; using \`${found.argv.join(" ")}\` (${found.reason}).`);
  return found.argv;
}
