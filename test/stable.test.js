// @ts-check
// What docs/COMPATIBILITY.md promises for 1.x, held against the code.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { cli, commit, git, repo } from "./helpers.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const doc = readFileSync(join(ROOT, "docs", "COMPATIBILITY.md"), "utf8");

test("every finding id the code can produce is listed in COMPATIBILITY.md, and only those", () => {
  const dir = join(ROOT, "src", "findings");
  const code = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  const ids = new Set([...code.matchAll(/\bid: "([a-z-]+)"/g)].map((m) => m[1]));
  for (const op of ["rebase", "am", "cherry-pick", "revert"]) ids.add(`${op}-in-progress`); // `${op}-in-progress`
  const kinds = code.match(/const kind = ([\s\S]*?);\n/)?.[1] ?? "";
  for (const k of kinds.matchAll(/[?:] "([a-z]+)"/g)) ids.add(`dropped-by-${k[1]}`); // `dropped-by-${kind}`: the ternary's results
  const section = doc.match(/\*\*Finding ids\.\*\*([\s\S]*?)New ids may be/)?.[1] ?? "";
  const listed = new Set([...section.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]));
  assert.deepEqual([...ids].sort(), [...listed].sort());
});

test("a backup written by 0.1 (no worktree record, stamp to the second) is still listed and undoable", () => {
  const dir = repo();
  const head = git(dir, "rev-parse", "HEAD");
  const old = { stamp: "20261112-095300Z", label: "Keep them on a new branch", head: "refs/heads/main", branch: "main",
    branches: { main: head }, worktree: null };
  appendFileSync(join(dir, ".git", "rescue.log"), JSON.stringify(old) + "\n");
  const list = JSON.parse(cli(dir, "undo", "--list", "--json").out);
  assert.equal(list.backups[0]?.stamp, "20261112-095300Z");
  assert.equal(cli(dir, "undo", "20261112-095300Z", "--dry-run").code, 0);
});

test("exit codes as COMPATIBILITY.md lists them", () => {
  const dir = repo();
  assert.equal(cli(dir).code, 0, "report: nothing");
  assert.equal(cli(dir, "lost").code, 0);
  assert.equal(cli(dir, "timeline").code, 0);
  assert.equal(cli(dir, "find", "nowhere").code, 1);
  assert.equal(cli(dir, "undo").code, 0, "nothing to undo");
  assert.equal(cli(dir, "undo", "nosuchstamp").code, 2);
  commit(dir, "a.txt", "1\n", "one");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  assert.equal(cli(dir).code, 1, "report: a warning");
  assert.equal(cli(dir, "fix", "1a", "--dry-run").code, 0);
  assert.equal(cli(dir, "fix", "1a").code, 2, "no terminal and no --yes");
  assert.equal(cli(dir, "fix", "9a", "--yes").code, 2);
  assert.equal(cli(dir, "fix", "1a", "--yes").code, 0);
  assert.equal(cli(dir, "undo").code, 2, "no terminal and no --yes");
  assert.equal(cli(dir, "undo", "--yes").code, 0);
});
