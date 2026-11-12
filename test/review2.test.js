// @ts-check
// Round 4: the second independent review. One test per finding (numbers are the review's), all in throwaway
// repositories.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { at, cli, commit, folder, git, repo } from "./helpers.js";

/** @param {string} dir */
const report = (dir) => JSON.parse(cli(dir, "--json").out);
/** @param {string} dir @returns {string[]} */
const ids = (dir) => report(dir).findings.map((/** @type {{id: string}} */ f) => f.id);
/** git that may stop on a conflict. @param {string} dir @param {...string} args */
const tryGit = (dir, ...args) => { try { git(dir, ...args); } catch { /* stopped, as intended */ } };
/** rebase -i without an editor: the todo list as git (and --autosquash) writes it. @param {string} dir @param {...string} args */
const rebaseI = (dir, ...args) => git(dir, "-c", "sequence.editor=true", "-c", "core.editor=true", "rebase", "-i", ...args);

/** feature with F1, F2 off main; main gets M. @returns {string} */
function forked() {
  const dir = repo();
  git(dir, "checkout", "-q", "-b", "feature");
  commit(dir, "f.txt", "1\n", "F1");
  commit(dir, "f.txt", "2\n", "F2");
  git(dir, "checkout", "-q", "main");
  commit(dir, "m.txt", "m\n", "M");
  return dir;
}

test("1. a routine rebase, then switching branch, is not a loss", () => {
  const dir = forked();
  git(dir, "checkout", "-q", "feature");
  git(dir, "rebase", "-q", "main");
  git(dir, "checkout", "-q", "main");
  assert.deepEqual(ids(dir), []);
});

test("2. squash and fixup rebases keep the changes: not a loss", () => {
  const dir = repo();
  commit(dir, "a.txt", "a\n", "A");
  commit(dir, "b.txt", "b\n", "B");
  writeFileSync(join(dir, "a.txt"), "a, fixed\n");
  git(dir, "commit", "-q", "-a", "--fixup", "HEAD~1");
  writeFileSync(join(dir, "b.txt"), "b, more\n");
  git(dir, "commit", "-q", "-a", "--squash", "HEAD~1", "-m", "more of B");
  rebaseI(dir, "--autosquash", "HEAD~4");
  assert.equal(git(dir, "log", "--format=%s", "-3"), "B\nA\nfirst");
  assert.deepEqual(ids(dir), []);
});

test("3. a dropped stash -u with only new files is reported", () => {
  const dir = repo();
  writeFileSync(join(dir, "new-notes.txt"), "only here\n");
  git(dir, "stash", "push", "-q", "-u");
  git(dir, "stash", "drop", "-q");
  const f = report(dir).findings.find((/** @type {{id: string}} */ x) => x.id === "dropped-stash");
  assert.ok(f, "reported");
  assert.match(f.detail, /new-notes\.txt/);
});

test("4. files staged in a repository with no commits yet are found", () => {
  const dir = folder();
  git(dir, "init", "-q");
  writeFileSync(join(dir, "thesis.txt"), "chapter one: the only copy\n");
  git(dir, "add", "thesis.txt");
  git(dir, "rm", "-q", "--cached", "thesis.txt");
  unlinkSync(join(dir, "thesis.txt"));
  assert.ok(ids(dir).includes("lost-staged-files"));
  assert.match(cli(dir, "find", "only copy").out, /chapter one/);
});

test("5. fix takes a finding's key, and refuses one that is no longer there", () => {
  const dir = repo();
  commit(dir, "a.txt", "1\n", "one");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, "t.txt", "t\n", "topic work");
  git(dir, "checkout", "-q", "main");
  git(dir, "branch", "-q", "-D", "topic");
  const r = report(dir);
  const reset = r.findings.find((/** @type {{id: string}} */ f) => f.id === "dropped-by-reset");
  assert.match(reset.key, /^dropped-by-reset:[0-9a-f]{8}$/);
  assert.equal(cli(dir, "fix", `${reset.key}/a`, "--yes").code, 0);
  const again = cli(dir, "fix", `${reset.key}/a`, "--yes");
  assert.equal(again.code, 2);
  assert.match(again.err, /no longer/);
});

test("6. a submodule with changes during a conflict does not stop the backup", () => {
  const lib = repo();
  const dir = repo();
  git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib");
  git(dir, "commit", "-q", "-m", "add lib");
  commit(join(dir, "lib"), "lib.txt", "changed in the submodule\n", "lib change");
  commit(dir, "x.txt", "base\n", "base");
  git(dir, "checkout", "-q", "-b", "other");
  commit(dir, "x.txt", "theirs\n", "theirs");
  git(dir, "checkout", "-q", "main");
  commit(dir, "x.txt", "ours\n", "ours");
  tryGit(dir, "merge", "other");
  const fix = cli(dir, "fix", "1a", "--yes");
  assert.equal(fix.code, 0, fix.out + fix.err);
});

test("7. two backups in the same second are two backups", async () => {
  const dir = repo();
  const { backup, backups } = await import("../src/backup.js");
  const r = await at(dir);
  const a = backup(dir, r, "first");
  const b = backup(dir, r, "second");
  assert.notEqual(a.stamp, b.stamp);
  assert.deepEqual(backups(r).map((x) => x.label), ["second", "first"]);
});

/** A bare server, a clone of it at `b`, and the first working copy at `a`. */
function serverAndClones() {
  const server = folder("server");
  git(server, "init", "-q", "--bare");
  const a = repo();
  git(a, "remote", "add", "origin", server);
  git(a, "push", "-q", "-u", "origin", "main");
  const b = folder("clone");
  git(b, "clone", "-q", "-b", "main", server, ".");
  return { server, a, b };
}

test("8. a pull request squash-merged on the server and pruned is not a loss", () => {
  const { a, b } = serverAndClones();
  git(a, "checkout", "-q", "-b", "pr");
  commit(a, "p.txt", "1\n", "pr part 1");
  commit(a, "p.txt", "2\n", "pr part 2");
  git(a, "push", "-q", "origin", "pr");
  git(b, "fetch", "-q");
  git(a, "checkout", "-q", "main");
  git(a, "merge", "-q", "--squash", "pr");
  git(a, "commit", "-q", "-m", "the pull request, squashed");
  git(a, "push", "-q", "origin", "main", ":pr");
  git(b, "pull", "-q", "--prune");
  git(b, "reflog", "expire", "--expire=now", "--all");
  assert.deepEqual(ids(b), []);
});

test("9. in the middle of a rebase, its own new commits are not lost", () => {
  const dir = repo();
  commit(dir, "c.txt", "base\n", "base");
  git(dir, "checkout", "-q", "-b", "feature");
  commit(dir, "f1.txt", "1\n", "F1");
  commit(dir, "f2.txt", "2\n", "F2");
  commit(dir, "c.txt", "feature\n", "F3 conflicts");
  git(dir, "checkout", "-q", "main");
  commit(dir, "c.txt", "main\n", "M");
  git(dir, "checkout", "-q", "feature");
  tryGit(dir, "rebase", "main");
  assert.deepEqual(ids(dir), ["rebase-in-progress"]);
});

test("10. an upstream force-pushed twice is still reported", () => {
  const { a, b } = serverAndClones();
  commit(a, "s.txt", "1\n", "shared");
  git(a, "push", "-q", "origin", "main");
  git(b, "pull", "-q");
  commit(b, "mine.txt", "mine\n", "my work");
  for (const msg of ["rewritten once", "rewritten twice"]) {
    git(a, "commit", "-q", "--amend", "-m", msg);
    git(a, "push", "-q", "--force", "origin", "main");
    git(b, "fetch", "-q");
  }
  assert.ok(ids(b).includes("upstream-rewritten"));
});

test("11. an old rebase of a branch you are not on is not reported after the reflog expires", () => {
  const dir = forked();
  git(dir, "checkout", "-q", "feature");
  git(dir, "rebase", "-q", "main");
  git(dir, "checkout", "-q", "main");
  git(dir, "reflog", "expire", "--expire=now", "--all");
  assert.deepEqual(ids(dir), []);
});

test("12. a branch deleted and made again is not said to be a detached HEAD", () => {
  const dir = repo();
  git(dir, "checkout", "-q", "-b", "exp");
  commit(dir, "e.txt", "e\n", "exp work");
  git(dir, "checkout", "-q", "main");
  git(dir, "branch", "-q", "-D", "exp");
  git(dir, "branch", "exp");
  const out = cli(dir).out;
  assert.match(out, /exp work/);
  assert.doesNotMatch(out, /detached/i);
  assert.match(out, /"exp"/);
});

test("13. a squash-merged branch, deleted, is not a loss", () => {
  const dir = forked();
  git(dir, "merge", "-q", "--squash", "feature");
  git(dir, "commit", "-q", "-m", "feature, squashed");
  git(dir, "branch", "-q", "-D", "feature");
  assert.deepEqual(ids(dir), []);
});

test("14. the text of the no-reflog finding is clean", () => {
  const dir = repo();
  commit(dir, "a.txt", "1\n", "one");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  git(dir, "reflog", "expire", "--expire=now", "--all");
  const f = report(dir).findings.find((/** @type {{id: string}} */ x) => x.id === "unreachable-commits");
  assert.ok(f);
  assert.doesNotMatch(f.detail, /" \+|\n\s+"/);
});

test("15. undo after abandoning a rebase does not strand HEAD on a commit from the middle of it", () => {
  const dir = repo();
  commit(dir, "c.txt", "base\n", "base");
  git(dir, "checkout", "-q", "-b", "feature");
  commit(dir, "c.txt", "feature\n", "F");
  git(dir, "checkout", "-q", "main");
  commit(dir, "c.txt", "main\n", "M");
  git(dir, "checkout", "-q", "feature");
  tryGit(dir, "rebase", "main");
  assert.equal(cli(dir, "fix", "1a", "--yes").code, 0);
  const undo = cli(dir, "undo", "--yes");
  assert.doesNotMatch(undo.out, /checkout --detach/);
  assert.match(undo.out, /cannot be resumed/);
  assert.equal(git(dir, "symbolic-ref", "HEAD"), "refs/heads/feature");
});

test("16. a branch checked out in another worktree is not offered a checkout that cannot work", () => {
  const dir = repo();
  git(dir, "branch", "side");
  const other = join(folder("wt"), "side");
  git(dir, "worktree", "add", other, "side");
  commit(other, "s.txt", "s\n", "side work");
  git(other, "reset", "-q", "--hard", "HEAD~1");
  const f = report(dir).findings.find((/** @type {{id: string}} */ x) => x.id === "dropped-by-reset");
  assert.ok(f);
  assert.ok(!f.options.some((/** @type {{steps: string[][]}} */ o) => o.steps.some((s) => s[0] === "checkout")), JSON.stringify(f.options));
  assert.match(JSON.stringify(f.options), /checked out in /);
});

test("17. the backup message for a locked index does not speak of conflicts", () => {
  const dir = repo();
  writeFileSync(join(dir, "README.md"), "edited\n");
  writeFileSync(join(dir, ".git", "index.lock"), "");
  const fix = cli(dir, "fix", "1a", "--yes");
  assert.equal(fix.code, 0, fix.out + fix.err);
  assert.doesNotMatch(fix.out, /conflict/);
});

test("18. a hand-edited rescue.log cannot make undo run an option", () => {
  const dir = repo();
  git(dir, "branch", "keepme");
  commit(dir, "a.txt", "1\n", "one");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  assert.equal(cli(dir, "fix", "1a", "--yes").code, 0);
  const log = join(dir, ".git", "rescue.log");
  const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  lines[0].branches.keepme = "-D";
  writeFileSync(log, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  cli(dir, "undo", "--yes");
  assert.match(git(dir, "branch", "--list", "keepme"), /keepme/);
});

test("19. exit codes: an option you have to do is not 'done'", () => {
  const dir = repo();
  writeFileSync(join(dir, "plan.md"), "lost plan\n");
  git(dir, "add", "plan.md");
  git(dir, "reset", "-q", "--hard");
  assert.equal(cli(dir, "fix", "1a", "--yes").code, 1, "lost staged files: the option starts with you");
});

test("20. undo STAMP undoes an earlier fix; undo twice redoes, as documented", () => {
  const dir = repo();
  commit(dir, "a.txt", "1\n", "one");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  assert.equal(cli(dir, "fix", "1a", "--yes").code, 0); // a rescued/ branch
  const first = JSON.parse(cli(dir, "undo", "--list", "--json").out).backups[0].stamp;
  git(dir, "branch", "unrelated");
  const r = cli(dir, "undo", first, "--yes");
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(git(dir, "branch", "--list", "rescued/*"), "");
  assert.match(git(dir, "branch", "--list", "unrelated"), /unrelated/);
});

test("21. the same dropped work is reported once", () => {
  const dir = repo();
  writeFileSync(join(dir, "README.md"), "work\n");
  git(dir, "stash", "-q");
  git(dir, "stash", "apply", "-q");
  git(dir, "stash", "drop", "-q");
  git(dir, "stash", "-q");
  git(dir, "stash", "drop", "-q");
  assert.equal(ids(dir).filter((i) => i === "dropped-stash").length, 1);
});

test("22. run from a subfolder, the report says where the commands are meant to run", () => {
  const dir = repo();
  mkdirSync(join(dir, "sub"));
  commit(dir, "sub/s.txt", "base\n", "base");
  git(dir, "checkout", "-q", "-b", "other");
  commit(dir, "sub/s.txt", "theirs\n", "theirs");
  git(dir, "checkout", "-q", "main");
  commit(dir, "sub/s.txt", "ours\n", "ours");
  tryGit(dir, "merge", "other");
  const out = cli(join(dir, "sub")).out;
  assert.match(out, /git add -- sub\/s\.txt/);
  assert.match(out, /run the commands from the top folder/);
});

test("am with a patch that does not apply: finishing means applying it by hand", () => {
  const dir = repo();
  commit(dir, "a.txt", "1\n2\n3\n", "base");
  git(dir, "checkout", "-q", "-b", "other");
  commit(dir, "a.txt", "1\nTWO\n3\n", "change two");
  const patch = join(folder("patch"), "p.patch");
  writeFileSync(patch, git(dir, "format-patch", "-1", "--stdout") + "\n");
  git(dir, "checkout", "-q", "main");
  commit(dir, "a.txt", "one\nzwei\nthree\n", "rewrite all");
  tryGit(dir, "am", patch);
  const f = report(dir).findings.find((/** @type {{id: string}} */ x) => x.id === "am-in-progress");
  assert.ok(f);
  assert.match(f.options[1].title, /apply the patch by hand/);
  assert.match(f.options[1].steps[0][0], /git apply --reject/);
  assert.match(f.options[2].title, /Leave this patch out/);
});
