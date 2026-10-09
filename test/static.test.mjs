// Static guards over the action and workflow YAML. actionlint checks workflows but not
// composite action.yml files, so the rules that keep the actions safe are checked here:
//   - no ${{ }} expression inside any run: script (values go through env:);
//   - every ${{ inputs.x }} names a declared input (a typo would silently be "");
//   - every CFP_* variable an action sets is one its script reads (a typo would be ignored);
//   - every third-party `uses:` is pinned to a full commit SHA;
//   - the README's input/output reference matches the action.yml files.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ROOT } from "./helpers/harness.mjs";
import { render, replaceBlock } from "../scripts/reference.mjs";

const ACTIONS = ["action.yml", "upload/action.yml", "deploy/action.yml", "deployment/action.yml", "comment/action.yml", "preview-comment/action.yml"];
const WORKFLOWS = readdirSync(join(ROOT, ".github", "workflows")).filter((f) => f.endsWith(".yml")).map((f) => join(".github", "workflows", f));
const EXAMPLES = readdirSync(join(ROOT, "examples")).filter((f) => f.endsWith(".yml")).map((f) => join("examples", f));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/** Every run: script body (inline or block scalar), as [lineNumber, text]. */
function runScripts(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    if (!/^[|>][-+]?\s*$/.test(m[2])) {
      out.push([i + 1, m[2]]);
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() && l.search(/\S/) <= indent) break;
      out.push([j + 1, l]);
    }
  }
  return out;
}

function declaredInputs(text) {
  const block = /^inputs:\n([\s\S]*?)^\S/m.exec(`${text}\nEND`)?.[1] ?? "";
  return new Set([...block.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map((m) => m[1]));
}

describe("YAML safety", () => {
  for (const file of [...ACTIONS, ...WORKFLOWS, ...EXAMPLES]) {
    it(`${file}: no expressions inside run: scripts`, () => {
      const bad = runScripts(read(file)).filter(([, l]) => l.includes("${{"));
      assert.deepEqual(bad, [], `move these into env: — ${JSON.stringify(bad)}`);
    });
    it(`${file}: third-party actions are SHA-pinned`, () => {
      const uses = [...read(file).matchAll(/^\s*(?:- )?uses:\s*([^\s#]+)/gm)].map((m) => m[1]);
      for (const u of uses) {
        if (u.startsWith("./") || u.startsWith("Wave-RF/cloudflare-preview")) continue;
        assert.match(u, /@[0-9a-f]{40}$/, `${u} must be pinned to a commit SHA`);
      }
    });
  }
});

describe("composite action wiring", () => {
  for (const file of ACTIONS) {
    const text = read(file);
    it(`${file}: every inputs.x reference is declared`, () => {
      const declared = declaredInputs(text);
      const used = new Set([...text.matchAll(/inputs\.([a-z0-9-]+)/g)].map((m) => m[1]));
      for (const u of used) assert.ok(declared.has(u), `inputs.${u} is used but not declared`);
    });
    it(`${file}: CFP_* variables match what the scripts read`, () => {
      const steps = text.split(/\n\s{4}- /).slice(1);
      for (const step of steps) {
        const script = /src\/([a-z-]+\.mjs)/.exec(step)?.[1];
        if (!script) continue;
        const set = new Set([...step.matchAll(/^\s+(CFP_[A-Z_]+):/gm)].map((m) => m[1]));
        const src = [script, "comment.mjs", "lib/actions.mjs"].map((f) => {
          try {
            return readFileSync(join(ROOT, "src", f), "utf8");
          } catch {
            return "";
          }
        });
        const known = new Set(src.flatMap((s) => [...s.matchAll(/"(CFP_[A-Z_]+)"/g)].map((m) => m[1])));
        for (const v of set) assert.ok(known.has(v), `${file} sets ${v} but ${script} never reads it`);
      }
    });
  }
});

describe("README reference", () => {
  it("is regenerated from the action.yml files (node scripts/reference.mjs --write)", () => {
    const readme = read("README.md");
    assert.equal(readme, replaceBlock(readme, render()), "README reference is stale: run node scripts/reference.mjs --write");
  });
});
