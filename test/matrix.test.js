// @ts-check
/**
 * Every option of every finding, run for real: each kind of finding is staged in a fresh repository, each option
 * that git-rescue runs (not those that start with something the user does) is applied with `fix --yes`, and then:
 * the finding is gone, an uncommitted edit elsewhere survived, and `undo --yes` puts every branch and HEAD back
 * where they were. An abandoned operation (merge, rebase ...) cannot come back, but the refs do.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { cli, commit, folder, git, repo } from "./helpers.js";

/** A repository with a tracked notes.txt that the scenario leaves edited (when `dirty`). */
function base() {
  const dir = repo();
  commit(dir, "notes.txt", "notes\n", "notes");
  return dir;
}
const EDIT = "notes, edited and not committed\n";
/** @param {string} dir */
const edit = (dir) => writeFileSync(join(dir, "notes.txt"), EDIT);

/** @param {string} dir @param {string} file */
function conflict(dir, file = "c.txt") {
  commit(dir, file, "base\n", "base");
  git(dir, "checkout", "-q", "-b", "other");
  commit(dir, file, "theirs\n", "theirs");
  git(dir, "checkout", "-q", "main");
  commit(dir, file, "ours\n", "ours");
}

/** @type {Record<string, {id: string, dirty: boolean, make: () => string, keep?: string[]}>} */
const SCENARIOS = {
  reset: { id: "dropped-by-reset", dirty: true, make() {
    const d = base(); commit(d, "a.txt", "1\n", "one"); commit(d, "a.txt", "2\n", "two");
    git(d, "reset", "-q", "--hard", "HEAD~2"); edit(d); return d;
  } },
  "deleted branch": { id: "deleted-branch", dirty: true, make() {
    const d = base(); git(d, "checkout", "-q", "-b", "topic"); commit(d, "t.txt", "t\n", "topic work");
    git(d, "checkout", "-q", "main"); git(d, "branch", "-q", "-D", "topic"); edit(d); return d;
  } },
  "detached with commits": { id: "detached-with-commits", dirty: true, make() {
    const d = base(); git(d, "checkout", "-q", "--detach"); commit(d, "d.txt", "d\n", "detached work"); edit(d); return d;
  } },
  "left on a detached HEAD": { id: "left-on-detached-head", dirty: true, make() {
    const d = base(); git(d, "checkout", "-q", "--detach"); commit(d, "d.txt", "d\n", "detached work");
    git(d, "checkout", "-q", "main"); edit(d); return d;
  } },
  "detached on a branch's commit": { id: "detached", dirty: true, make() {
    const d = base(); git(d, "checkout", "-q", "--detach"); edit(d); return d;
  } },
  "dropped stash": { id: "dropped-stash", dirty: false, make() {
    const d = base(); writeFileSync(join(d, "README.md"), "stashed\n"); git(d, "stash", "-q"); git(d, "stash", "drop", "-q"); return d;
  } },
  "branch -f": { id: "dropped-by-branch", dirty: true, make() {
    const d = base(); git(d, "branch", "side"); git(d, "checkout", "-q", "side"); commit(d, "s.txt", "s\n", "side work");
    git(d, "checkout", "-q", "main"); git(d, "branch", "-f", "side", "main"); edit(d); return d;
  } },
  "checkout -B": { id: "dropped-by-branch", dirty: true, make() { // git writes "branch: Reset to" for it, as for branch -f
    const d = base(); commit(d, "a.txt", "1\n", "one"); git(d, "checkout", "-q", "-B", "main", "HEAD~1"); edit(d); return d;
  } },
  "amend that changed content": { id: "dropped-by-amend", dirty: true, make() {
    const d = base(); commit(d, "a.txt", "1\n", "one"); writeFileSync(join(d, "a.txt"), "1 and more\n");
    git(d, "commit", "-q", "-a", "--amend", "-m", "one"); edit(d); return d;
  } },
  "nothing points to them": { id: "unreachable-commits", dirty: true, make() {
    const d = base(); commit(d, "a.txt", "1\n", "one"); git(d, "reset", "-q", "--hard", "HEAD~1");
    git(d, "reflog", "expire", "--expire=now", "--all"); edit(d); return d;
  } },
  "stale lock": { id: "index-lock", dirty: true, make() {
    const d = base(); edit(d); writeFileSync(join(d, ".git", "index.lock"), ""); return d;
  } },
  merge: { id: "merge-in-progress", dirty: false, make() {
    const d = base(); conflict(d); tryGit(d, "merge", "-q", "other", "--no-edit"); return d;
  } },
  rebase: { id: "rebase-in-progress", dirty: false, make() {
    const d = base(); conflict(d); git(d, "checkout", "-q", "other"); tryGit(d, "rebase", "main"); return d;
  } },
  "cherry-pick": { id: "cherry-pick-in-progress", dirty: false, make() {
    const d = base(); conflict(d); tryGit(d, "cherry-pick", "other"); return d;
  } },
  revert: { id: "revert-in-progress", dirty: false, make() {
    const d = base(); commit(d, "c.txt", "1\n", "c1"); commit(d, "c.txt", "2\n", "c2"); tryGit(d, "revert", "--no-edit", "HEAD~1"); return d;
  } },
  am: { id: "am-in-progress", dirty: false, make() {
    const d = base(); conflict(d); const patch = join(folder("patch"), "p.patch");
    writeFileSync(patch, git(d, "format-patch", "-1", "--stdout", "other") + "\n"); tryGit(d, "am", patch); return d;
  } },
  bisect: { id: "bisect-in-progress", dirty: false, make() {
    const d = base(); commit(d, "a.txt", "1\n", "one"); commit(d, "a.txt", "2\n", "two");
    git(d, "bisect", "start"); git(d, "bisect", "bad"); git(d, "bisect", "good", "HEAD~2"); return d;
  } },
  "upstream rewritten": { id: "upstream-rewritten", dirty: false, keep: ["b"], make() {
    const remote = folder("remote"); git(remote, "init", "-q", "--bare");
    const a = base(); git(a, "remote", "add", "origin", remote); commit(a, "a.txt", "1\n", "shared"); git(a, "push", "-q", "-u", "origin", "main");
    const b = folder("clone"); git(b, "clone", "-q", "-b", "main", remote, "."); commit(b, "b.txt", "mine\n", "my work");
    git(a, "commit", "-q", "--amend", "-m", "shared, rewritten"); git(a, "push", "-q", "--force", "origin", "main");
    git(b, "fetch", "-q"); return b;
  } },
};

/** git that may fail (a command that stops on a conflict exits 1). @param {string} dir @param {...string} args */
function tryGit(dir, ...args) {
  try { git(dir, ...args); } catch { /* stopped on a conflict, as intended */ }
}

/** Where every branch and HEAD are. @param {string} dir */
function refsNow(dir) {
  const heads = git(dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
  let head;
  try { head = git(dir, "symbolic-ref", "-q", "HEAD"); } catch { head = git(dir, "rev-parse", "HEAD"); }
  return `${head}\n${heads}`;
}

/** @param {string} dir @param {string} id */
function findingIndex(dir, id) {
  const report = JSON.parse(cli(dir, "--json").out);
  return report.findings.findIndex((/** @type {{id: string}} */ f) => f.id === id);
}

for (const [name, s] of Object.entries(SCENARIOS)) {
  test(`every option of "${name}" runs, fixes it, and undoes`, () => {
    const probe = s.make();
    const report = JSON.parse(cli(probe, "--json").out);
    const i = report.findings.findIndex((/** @type {{id: string}} */ f) => f.id === s.id);
    assert.ok(i >= 0, `${s.id} is reported: ${report.findings.map((/** @type {{id: string}} */ f) => f.id).join(", ")}`);
    const options = report.findings[i].options;
    let ran = 0;
    options.forEach((/** @type {{title: string, risk: string, steps: string[][]}} */ opt, k) => {
      if (opt.risk === "manual") return;
      const letter = String.fromCharCode(97 + k);
      const dir = s.make();
      const before = refsNow(dir);
      const fix = cli(dir, "fix", `${i + 1}${letter}`, "--yes");
      assert.equal(fix.code, 0, `${name} ${letter}) ${opt.title}\n${fix.out}${fix.err}`);
      ran++;
      if (!s.keep?.includes(letter)) assert.equal(findingIndex(dir, s.id), -1, `${name} ${letter}): the finding is gone`);
      if (s.dirty) assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), EDIT, `${name} ${letter}): the uncommitted edit survived the fix`);
      const undo = cli(dir, "undo", "--yes");
      assert.equal(undo.code, 0, `${name} ${letter}) undo\n${undo.out}${undo.err}`);
      assert.equal(refsNow(dir), before, `${name} ${letter}): undo put every branch and HEAD back\n${undo.out}`);
      if (s.dirty) assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), EDIT, `${name} ${letter}): the uncommitted edit survived the undo`);
    });
    assert.ok(ran > 0, "at least one option ran");
  });
}
