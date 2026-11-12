// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { cli, commit, folder, git, repo } from "./helpers.js";
import { describe } from "../src/timeline.js";

test("the timeline says what happened, newest first", () => {
  const dir = repo();
  commit(dir, "a.txt", "a\n", "add a");
  git(dir, "checkout", "-q", "-b", "feature");
  git(dir, "checkout", "-q", "main");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  const r = cli(dir, "timeline");
  assert.equal(r.code, 0);
  const lines = r.out.split("\n").filter((l) => l.startsWith("  "));
  assert.match(lines[0], /reset to HEAD~1/);
  assert.match(lines[1], /switched from feature to main/);
  assert.match(r.out, /committed "add a"/);
  assert.match(lines[0], /\[before: [0-9a-f]{8}\]/);
});

test("reflog messages in words", () => {
  assert.equal(describe("commit (amend): better"), 'amended the last commit: "better"');
  assert.equal(describe("rebase -i (finish): returning to refs/heads/topic"), "finished a rebase back on topic");
  assert.equal(describe("pull: Fast-forward"), "pulled (Fast-forward)");
  assert.equal(describe("something new"), "something new");
});

test("outside a repository, and with mistakes", () => {
  const dir = folder("plain");
  const r = cli(dir);
  assert.equal(r.code, 2);
  assert.match(r.err, /not inside a git repository/);
  const inRepo = repo();
  assert.equal(cli(inRepo, "frobnicate").code, 2);
  assert.equal(cli(inRepo, "find").code, 2);
  assert.equal(cli(inRepo, "restore", "zzz", "x.txt").code, 2);
  assert.equal(cli(inRepo, "fix", "9", "--yes").code, 2);
});

test("found problems are listed with their commands and change nothing unasked", () => {
  const dir = repo();
  commit(dir, "a.txt", "a\n", "second");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  const before = git(dir, "for-each-ref");
  const r = cli(dir);
  assert.equal(r.code, 1, "something to look at");
  assert.match(r.out, /1 commit fell off main/);
  assert.match(r.out, /a\) Keep them on a new branch/);
  assert.match(r.out, /git branch rescued\//);
  assert.match(r.out, /To apply one: git-rescue fix N\[a\]/);
  assert.equal(git(dir, "for-each-ref"), before, "nothing changed");
  const json = JSON.parse(cli(dir, "--json").out);
  assert.equal(json.findings[0].id, "dropped-by-reset");
});

test("a fix is not run without --yes when there is no terminal to ask in", () => {
  const dir = repo();
  commit(dir, "a.txt", "a\n", "second");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  const r = cli(dir, "fix", "1a");
  assert.equal(r.code, 2);
  assert.match(r.err, /add --yes/);
  assert.equal(git(dir, "branch", "--list", "rescued/*"), "");
});

test("undo with nothing to undo, and the list of backups", () => {
  const dir = repo();
  assert.match(cli(dir, "undo").out, /nothing to undo/);
  commit(dir, "a.txt", "a\n", "second");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  cli(dir, "fix", "1a", "--yes");
  assert.match(cli(dir, "undo", "--list").out, /before: Keep them on a new branch/);
});
