// @ts-check
// Round 2: what the report says, submodules, the command line, --json, and credentials in reflog messages.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { cli, commit, folder, git, repo } from "./helpers.js";
import { describe, hideCredentials } from "../src/timeline.js";

test("the report names the commits that fell off and the files a dropped stash changed", () => {
  const dir = repo();
  commit(dir, "a.txt", "1\n", "add the parser");
  commit(dir, "a.txt", "2\n", "parser handles quotes");
  git(dir, "reset", "-q", "--hard", "HEAD~2");
  writeFileSync(join(dir, "README.md"), "edited\n");
  git(dir, "stash", "-q");
  git(dir, "stash", "drop", "-q");
  const out = cli(dir).out;
  assert.match(out, /2 commits fell off main/);
  assert.match(out, /\n {7}[0-9a-f]{8} {2}parser handles quotes\n {7}[0-9a-f]{8} {2}add the parser\n/);
  assert.match(out, /It changed README\.md\./);
  // Every line but the header (the repository's path, as long as it is) and the commands fits in 100 columns.
  for (const line of out.split("\n").slice(1)) if (!/^ {10}git /.test(line)) assert.ok(line.length <= 100, `wrapped: ${line}`);
});

test("lost files are previewed in the report; lost does not list a stash's inner commits", () => {
  const dir = repo();
  writeFileSync(join(dir, "plan.md"), "Step one: rename the table\n");
  git(dir, "add", "plan.md");
  git(dir, "reset", "-q", "--hard");
  writeFileSync(join(dir, "README.md"), "wip\n");
  git(dir, "stash", "-q");
  git(dir, "stash", "drop", "-q");
  assert.match(cli(dir).out, /\n {7}[0-9a-f]{8} {2}just now +Step one: rename the table\n/);
  const lost = cli(dir, "lost").out;
  assert.match(lost, /WIP on main/);
  assert.doesNotMatch(lost, /index on main/);
  const json = JSON.parse(cli(dir, "lost", "--json").out);
  assert.equal(json.unreachable.length, 1);
});

test("a popped stash is not reported when git-rescue runs in a subfolder", () => {
  const dir = repo();
  mkdirSync(join(dir, "src"));
  commit(dir, "src/app.js", "1\n", "app");
  writeFileSync(join(dir, "src", "app.js"), "2\n");
  git(dir, "stash", "-q");
  git(dir, "stash", "pop", "-q");
  const r = cli(join(dir, "src"));
  assert.doesNotMatch(r.out, /dropped stash/, r.out);
});

test("submodules: a hint in the parent, and a submodule's detached HEAD is how git leaves it", () => {
  const lib = repo();
  const app = repo();
  git(app, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib");
  git(app, "commit", "-q", "-m", "add lib");
  const parent = cli(app);
  assert.equal(parent.code, 0);
  assert.match(parent.out, /lib is a submodule, a repository of its own: git-rescue -C lib checks it/);
  const sub = join(app, "lib");
  git(sub, "checkout", "-q", "--detach");
  const r = cli(sub);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /the commit .* records for this submodule/);
  assert.doesNotMatch(r.out, /Go back to/);
  assert.match(r.out, /a submodule of /);
});

test("command-line mistakes say what is wrong", () => {
  const dir = repo();
  const missing = cli(dir, "-C", join(folder("x"), "nope"));
  assert.equal(missing.code, 2);
  assert.match(missing.err, /there is no folder/);
  const unknown = cli(dir, "--jsn");
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown option --jsn/);
  assert.match(cli(dir, "timeline", "-n", "abc").err, /-n takes a number/);
  const dashed = cli(dir, "find", "--", "-x");
  assert.equal(dashed.code, 1, "searched for -x and found nothing");
  assert.match(dashed.out, /"-x" is not in any lost work/);
});

test("--json has a format number and the same fields for every command", () => {
  const dir = repo();
  commit(dir, "a.txt", "a\n", "second");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  const report = JSON.parse(cli(dir, "--json").out);
  assert.equal(report.format, 1);
  assert.deepEqual(Object.keys(report), ["format", "version", "state", "findings"]);
  const f = report.findings[0];
  assert.deepEqual(Object.keys(f).sort(), ["commits", "detail", "id", "level", "options", "title"]);
  assert.deepEqual(Object.keys(f.options[0]).sort(), ["risk", "steps", "title"]);
  assert.ok(Array.isArray(f.options[0].steps[0]));
  for (const k of ["branch", "headSha", "unborn", "bare", "operation", "conflicted", "changed", "untracked", "lockAge", "superproject", "submodules"]) assert.ok(k in report.state, k);
  assert.deepEqual(Object.keys(JSON.parse(cli(dir, "timeline", "--json").out)), ["format", "version", "events"]);
  assert.deepEqual(Object.keys(JSON.parse(cli(dir, "lost", "--json").out)), ["format", "version", "reflogOnly", "unreachable", "staged"]);
  assert.deepEqual(Object.keys(JSON.parse(cli(dir, "find", "a", "--json").out)), ["format", "version", "text", "matches"]);
});

test("passwords and tokens in reflog URLs are never shown", () => {
  assert.equal(hideCredentials("clone: from https://me:s3cret@example.invalid/r.git"), "clone: from https://***@example.invalid/r.git");
  assert.equal(describe("pull https://tok3n@example.invalid/r.git main: Fast-forward"), "pulled (Fast-forward)");
  const dir = repo();
  const head = git(dir, "rev-parse", "HEAD");
  git(dir, "update-ref", "-m", "clone: from https://me:s3cret@example.invalid/r.git", "HEAD", head);
  for (const args of [["timeline"], ["timeline", "--json"]]) assert.doesNotMatch(cli(dir, ...args).out, /s3cret/);
});

test("more of git's reflog messages in words, old and new", () => {
  /** @type {[string, string][]} */
  const cases = [
    ["rebase finished: returning to refs/heads/topic", "finished a rebase back on topic"],
    ["rebase (finish): returning to refs/heads/topic", "finished a rebase back on topic"],
    ["pull --rebase (finish): returning to refs/heads/main", "finished a rebase back on main"],
    ["rebase: add the parser", 'rebase: replayed "add the parser"'],
    ["pull origin main: Fast-forward", "pulled (Fast-forward)"],
    ["merge feature: Merge made by the 'recursive' strategy.", "merged feature (a merge commit)"],
    ["checkout: moving from main to main", "checked out main again"],
    ["am: fix the build", 'applied a patch (git am): "fix the build"'],
    ["Branch: renamed refs/heads/old to refs/heads/new", "renamed branch old to new"],
    ["commit (cherry-pick): port the fix", 'committed a cherry-pick: "port the fix"'],
  ];
  for (const [m, words] of cases) assert.equal(describe(m), words);
  assert.match(describe("reset: moving to HEAD", true), /^dropped or unstaged uncommitted changes/);
  assert.equal(describe("reset: moving to HEAD~1"), "reset to HEAD~1");
});
