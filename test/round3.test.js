// @ts-check
// Round 3: commits no reflog remembers, git gc at work, the user's git config, odd branch names, shallow clones.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

import { cli, commit, folder, git, repo } from "./helpers.js";

/** @param {string} dir */
const ids = (dir) => JSON.parse(cli(dir, "--json").out).findings.map((/** @type {{id: string}} */ f) => f.id);

test("commits that no reflog remembers any more are reported, and kept on a branch", () => {
  const dir = repo();
  commit(dir, "a.txt", "1\n", "work from last month");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  git(dir, "reflog", "expire", "--expire=now", "--all");
  const r = cli(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /1 commit that nothing points to, not even the reflog/);
  assert.match(r.out, /[0-9a-f]{8} {2}work from last month/);
  assert.equal(cli(dir, "fix", "1a", "--yes").code, 0);
  assert.match(git(dir, "log", "--all", "--format=%s"), /work from last month/);
  assert.deepEqual(ids(dir), []);
});

test("a bare repository after a force push: the overwritten commits are found", () => {
  const server = folder("server");
  git(server, "init", "-q", "--bare");
  const dev = repo();
  git(dev, "remote", "add", "origin", server);
  commit(dev, "a.txt", "1\n", "pushed, then overwritten");
  git(dev, "push", "-q", "origin", "main");
  git(dev, "reset", "-q", "--hard", "HEAD~1");
  commit(dev, "a.txt", "2\n", "the rewrite");
  git(dev, "push", "-q", "--force", "origin", "main");
  const r = cli(server);
  assert.match(r.out, /a bare repository/);
  assert.match(r.out, /pushed, then overwritten/);
  assert.equal(cli(server, "fix", "1a", "--yes").code, 0, "a branch can be made in a bare repository");
  assert.match(git(server, "branch", "--list", "rescued/*"), /rescued\/lost-/);
});

test("old rebased commits whose reflog expired are not reported: their changes are on the branch", () => {
  const dir = repo();
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, "t.txt", "t\n", "topic");
  git(dir, "checkout", "-q", "main");
  commit(dir, "m.txt", "m\n", "main moves on");
  git(dir, "checkout", "-q", "topic");
  git(dir, "rebase", "-q", "main");
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "-q", "--ff-only", "topic");
  git(dir, "reflog", "expire", "--expire=now", "--all");
  assert.ok(!ids(dir).includes("unreachable-commits"));
});

test("git gc at work is said, more loudly when there is something to rescue", () => {
  const dir = repo();
  writeFileSync(join(dir, ".git", "gc.pid"), "12345 somehost\n");
  const calm = JSON.parse(cli(dir, "--json").out).findings.find((/** @type {{id: string}} */ f) => f.id === "gc-running");
  assert.equal(calm?.level, "info");
  commit(dir, "a.txt", "1\n", "one");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  const loud = JSON.parse(cli(dir, "--json").out).findings.find((/** @type {{id: string}} */ f) => f.id === "gc-running");
  assert.equal(loud?.level, "warning");
});

test("the user's git config does not change what git-rescue reads or writes", () => {
  const dir = repo();
  for (const [k, v] of [["color.ui", "always"], ["color.diff", "always"], ["format.pretty", "oneline"], ["log.showSignature", "true"],
    ["diff.external", "false"], ["log.decorate", "full"], ["status.showUntrackedFiles", "no"], ["core.quotePath", "true"]]) git(dir, "config", k, v);
  commit(dir, "a.txt", "1\n", "one");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  assert.deepEqual(ids(dir), ["dropped-by-reset"]);
  const lost = git(dir, "rev-parse", "HEAD@{1}");
  const out = join(dir, "commit.txt");
  assert.equal(cli(dir, "restore", lost, out).code, 0);
  const text = readFileSync(out, "utf8");
  assert.ok(!text.includes("\x1b"), "no color codes");
  assert.match(text, /^Author: /m, "the whole commit, not one line");
  assert.match(text, /^diff --git a\/a\.txt b\/a\.txt$/m, "git's own diff, not the external one");
});

test("deleted branches with slashes, # and non-ASCII names come back", () => {
  const dir = repo();
  for (const b of ["feature/login", "fix-#12", "功能/测试"]) {
    git(dir, "checkout", "-q", "-b", b);
    commit(dir, `${b.replace(/[^\w]/g, "_")}.txt`, "x\n", `work on ${b}`);
    git(dir, "checkout", "-q", "main");
    git(dir, "branch", "-q", "-D", b);
  }
  for (let i = 0; i < 3; i++) assert.equal(cli(dir, "fix", "1a", "--yes").code, 0);
  const now = git(dir, "branch", "--list", "--format=%(refname:short)").split("\n").sort();
  assert.deepEqual(now, ["feature/login", "fix-#12", "main", "功能/测试"].sort());
});

test("a shallow clone: a lost commit is found and nothing fails at the shallow boundary", () => {
  const src = repo();
  for (let i = 1; i < 5; i++) commit(src, "a.txt", `${i}\n`, `upstream ${i}`);
  const dir = folder("shallow");
  git(dir, "clone", "-q", "--depth", "2", "-b", "main", `file://${src.replace(/\\/g, "/")}`, ".");
  commit(dir, "a.txt", "mine\n", "my work");
  git(dir, "reset", "-q", "--hard", "HEAD~2");
  const r = cli(dir);
  assert.equal(r.code, 1, r.err);
  assert.equal(r.err, "");
  assert.match(r.out, /my work/);
  assert.equal(cli(dir, "lost").code, 0);
});

test("restore writes FILE where you are, also with -C pointing elsewhere", () => {
  const dir = repo();
  git(dir, "config", "core.autocrlf", "true");
  writeFileSync(join(dir, "notes.txt"), "one\ntwo\n");
  git(dir, "add", "notes.txt");
  git(dir, "reset", "-q", "--hard");
  const id = cli(dir, "find", "two").out.match(/\b([0-9a-f]{8})\b/)?.[1];
  assert.ok(id);
  const here = folder("shell-here");
  const bin = fileURLToPath(new URL("../bin/git-rescue.js", import.meta.url));
  const r = spawnSync(process.execPath, [bin, "-C", dir, "restore", id, "saved.txt"], { cwd: here, encoding: "utf8", env: process.env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(here, "saved.txt")), "written in the shell's folder");
  assert.ok(!existsSync(join(dir, "saved.txt")));
  assert.equal(readFileSync(join(here, "saved.txt"), "utf8"), "one\ntwo\n", "outside the repository: the contents as git has them");
});
