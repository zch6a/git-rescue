// @ts-check
// The interactive menu, as a person uses it: pick a problem and an option, answer the question, or press Enter.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { commit, git, repo } from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/git-rescue.js", import.meta.url));
// Makes git-rescue believe it talks to a person at a terminal, so the menu and its questions run.
const AS_TERMINAL = 'data:text/javascript,Object.defineProperty(process.stdin,"isTTY",{value:true})';

/** git-rescue in `dir` with these lines typed in. @param {string} dir @param {string[]} typed @param {...string} args */
function typing(dir, typed, ...args) {
  assert.ok(resolve(dir).includes("git-rescue-test-"), "only in the test sandbox");
  const r = spawnSync(process.execPath, ["--import", AS_TERMINAL, BIN, "-C", dir, ...args], { encoding: "utf8", env: process.env, input: typed.map((l) => l + "\n").join("") });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function lostCommits() {
  const dir = repo();
  commit(dir, "a.txt", "1\n", "one");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  return dir;
}

test("menu: pick 1a, say yes, and it is done", () => {
  const dir = lostCommits();
  const r = typing(dir, ["1a", "y"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Fix one\? Type its number and letter/);
  assert.match(r.out, /Go ahead\? \[y\/N\]/);
  assert.match(r.out, /✓ git branch rescued\//);
  assert.match(git(dir, "branch", "--list", "rescued/*"), /rescued\/main-before-reset-/);
});

test("menu: Enter, or no, changes nothing", () => {
  const dir = lostCommits();
  const before = git(dir, "for-each-ref");
  const enter = typing(dir, [""]);
  assert.equal(enter.code, 1);
  assert.match(enter.out, /Nothing changed\./);
  const no = typing(dir, ["1b", "n"]);
  assert.equal(no.code, 1);
  assert.match(no.out, /Nothing changed\./);
  const eof = typing(dir, []);
  assert.notEqual(eof.code, 0, "input ended before an answer: nothing done");
  assert.equal(git(dir, "for-each-ref"), before);
});

test("menu: a wrong pick is named, and nothing runs", () => {
  const dir = lostCommits();
  const before = git(dir, "for-each-ref");
  const r = typing(dir, ["7z"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /"7z" is not one of the problems listed \(1 to 1\)/);
  assert.equal(git(dir, "for-each-ref"), before);
});

test("menu: an answer typed ahead waits for its question; the end of the input is never a yes", () => {
  const dir = lostCommits();
  const ahead = typing(dir, ["1a", "y"]); // both lines arrive at once, before the second question is asked
  assert.equal(ahead.code, 0, ahead.out);
  const ended = typing(lostCommits(), ["1a"]);
  assert.equal(ended.code, 1);
  assert.match(ended.out, /No answer: nothing changed\./);
});

test("menu: fix and undo ask first, and do it on yes", () => {
  const dir = lostCommits();
  assert.equal(typing(dir, ["y"], "fix", "1a").code, 0);
  assert.notEqual(git(dir, "branch", "--list", "rescued/*"), "");
  const undo = typing(dir, ["y"], "undo");
  assert.equal(undo.code, 0, undo.out + undo.err);
  assert.match(undo.out, /Go ahead\? \[y\/N\]/);
  assert.equal(git(dir, "branch", "--list", "rescued/*"), "");
});
