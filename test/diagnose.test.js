// @ts-check
import assert from "node:assert/strict";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { at, cli, commit, folder, git, repo } from "./helpers.js";
import { diagnose } from "../src/diagnose.js";

/** @param {string} dir */
async function findings(dir) {
  return diagnose(dir, await at(dir)).findings;
}

/** @param {Awaited<ReturnType<typeof findings>>} fs */
const ids = (fs) => fs.map((f) => f.id);

test("a clean repository has nothing wrong", async () => {
  const dir = repo();
  commit(dir, "a.txt", "a\n", "second");
  assert.deepEqual(await findings(dir), []);
  const r = cli(dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /Nothing looks wrong/);
});

test("commits dropped by reset --hard are found, kept on a branch, and the fix can be undone", async () => {
  const dir = repo();
  commit(dir, "a.txt", "a\n", "second");
  const tip = commit(dir, "b.txt", "b\n", "third");
  git(dir, "reset", "-q", "--hard", "HEAD~2");
  const f = (await findings(dir)).find((x) => x.id === "dropped-by-reset");
  assert.ok(f, "found");
  assert.equal(f.commits?.length, 2);
  assert.match(f.title, /2 commits fell off main with a reset/);

  const dry = cli(dir, "fix", "1a", "--dry-run");
  assert.equal(dry.code, 0);
  assert.match(dry.out, /git branch rescued\/main-before-reset-\S+ [0-9a-f]{40}/);
  assert.equal(git(dir, "branch", "--list", "rescued/*"), "", "a dry run changes nothing");

  const run = cli(dir, "fix", "1a", "--yes");
  assert.equal(run.code, 0, run.out + run.err);
  const branch = git(dir, "branch", "--list", "rescued/*", "--format=%(refname:short)");
  assert.equal(git(dir, "rev-parse", branch), tip, "the branch keeps the lost commits");
  assert.ok(git(dir, "for-each-ref", "refs/rescue/").length, "a backup was made");
  assert.deepEqual(ids(await findings(dir)), [], "nothing is lost any more");

  const back = cli(dir, "fix", "1b", "--yes"); // there is nothing to fix now
  assert.equal(back.code, 2);
});

test("putting a branch back where it was, and undoing that", async () => {
  const dir = repo();
  const before = commit(dir, "a.txt", "a\n", "second");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  const now = git(dir, "rev-parse", "HEAD");
  const r = cli(dir, "fix", "1b", "--yes");
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(git(dir, "rev-parse", "main"), before);
  const u = cli(dir, "undo", "--yes");
  assert.equal(u.code, 0, u.out + u.err);
  assert.equal(git(dir, "rev-parse", "main"), now, "undo puts main back where it was before the fix");
});

test("a deleted branch with commits nobody else has", async () => {
  const dir = repo();
  git(dir, "checkout", "-q", "-b", "feature");
  const tip = commit(dir, "f.txt", "feature work\n", "feature work");
  git(dir, "checkout", "-q", "main");
  git(dir, "branch", "-q", "-D", "feature");
  const f = (await findings(dir)).find((x) => x.id === "deleted-branch");
  assert.ok(f);
  assert.match(f.title, /"feature" was deleted with 1 commit/);
  assert.deepEqual(f.options[0].steps, [["branch", "feature", tip]]);
  assert.equal(cli(dir, "fix", "1", "--yes").code, 0);
  assert.equal(git(dir, "rev-parse", "feature"), tip);
});

test("a merged branch that was deleted is not a problem", async () => {
  const dir = repo();
  git(dir, "checkout", "-q", "-b", "feature");
  commit(dir, "f.txt", "x\n", "feature");
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "-q", "feature");
  git(dir, "branch", "-q", "-d", "feature");
  assert.deepEqual(ids(await findings(dir)), []);
});

test("commits made on a detached HEAD: now, and after switching away", async () => {
  const dir = repo();
  git(dir, "checkout", "-q", "--detach");
  const lost = commit(dir, "d.txt", "detached\n", "on no branch");
  let f = (await findings(dir)).find((x) => x.id === "detached-with-commits");
  assert.ok(f, "while detached");
  git(dir, "checkout", "-q", "main");
  f = (await findings(dir)).find((x) => x.id === "left-on-detached-head");
  assert.ok(f, "after leaving");
  assert.deepEqual(f.commits, [lost]);
  assert.equal(cli(dir, "fix", "1a", "--yes").code, 0);
  assert.equal(git(dir, "branch", "--contains", lost, "--format=%(refname:short)").startsWith("rescued/"), true);
});

test("a detached HEAD on a branch's commit is only information", async () => {
  const dir = repo();
  git(dir, "checkout", "-q", "--detach");
  const f = await findings(dir);
  assert.deepEqual(ids(f), ["detached"]);
  assert.equal(f[0].level, "info");
});

test("a dropped stash comes back on the stash list", async () => {
  const dir = repo();
  writeFileSync(join(dir, "README.md"), "changed but not committed\n");
  git(dir, "stash", "-q");
  git(dir, "stash", "drop", "-q");
  const f = (await findings(dir)).find((x) => x.id === "dropped-stash");
  assert.ok(f);
  assert.equal(cli(dir, "fix", "1", "--yes").code, 0);
  assert.match(git(dir, "stash", "list"), /rescued: WIP on main/);
  git(dir, "stash", "pop", "-q");
  assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "changed but not committed\n");
});

test("files staged and lost to reset --hard: found, searched, restored, never over a file", async () => {
  const dir = repo();
  writeFileSync(join(dir, "plan.md"), "the secret plan: ship on friday\n");
  git(dir, "add", "plan.md");
  git(dir, "reset", "-q", "--hard");
  assert.equal(existsSync(join(dir, "plan.md")), false);
  assert.ok((await findings(dir)).some((x) => x.id === "lost-staged-files"));

  const lost = cli(dir, "lost");
  assert.match(lost.out, /Files you staged and never committed \(1/);
  assert.match(lost.out, /the secret plan/);
  const found = cli(dir, "find", "ship on friday");
  assert.equal(found.code, 0);
  const id = found.out.match(/\b([0-9a-f]{8})\b/)?.[1];
  assert.ok(id, found.out);
  assert.equal(cli(dir, "restore", id, join(dir, "plan.md")).code, 0);
  assert.equal(readFileSync(join(dir, "plan.md"), "utf8"), "the secret plan: ship on friday\n");
  const again = cli(dir, "restore", id, join(dir, "plan.md"));
  assert.equal(again.code, 2);
  assert.match(again.err, /already exists/);
  assert.equal(cli(dir, "find", "not anywhere").code, 1);
});

test("a merge stopped by a conflict, abandoned", async () => {
  const dir = repo();
  git(dir, "checkout", "-q", "-b", "other");
  commit(dir, "README.md", "theirs\n", "theirs");
  git(dir, "checkout", "-q", "main");
  const mine = commit(dir, "README.md", "mine\n", "mine");
  try {
    git(dir, "merge", "-q", "other");
  } catch {
    // the conflict is the point
  }
  const f = (await findings(dir)).find((x) => x.id === "merge-in-progress");
  assert.ok(f);
  assert.match(f.detail, /README\.md/);
  assert.equal(cli(dir, "fix", "1a", "--yes").code, 0);
  assert.equal(existsSync(join(dir, ".git", "MERGE_HEAD")), false);
  assert.equal(git(dir, "rev-parse", "HEAD"), mine);
});

test("a rebase stopped by a conflict, abandoned", async () => {
  const dir = repo();
  git(dir, "checkout", "-q", "-b", "topic");
  const topic = commit(dir, "README.md", "topic\n", "topic");
  git(dir, "checkout", "-q", "main");
  commit(dir, "README.md", "main\n", "main");
  git(dir, "checkout", "-q", "topic");
  try {
    git(dir, "rebase", "-q", "main");
  } catch {
    // stopped on the conflict
  }
  const f = (await findings(dir)).find((x) => x.id === "rebase-in-progress");
  assert.ok(f, JSON.stringify(await findings(dir)));
  assert.match(f.title, /rebase of topic stopped halfway/);
  assert.equal(cli(dir, "fix", "1a", "--yes").code, 0);
  assert.equal(git(dir, "rev-parse", "HEAD"), topic);
  assert.equal(git(dir, "symbolic-ref", "--short", "HEAD"), "topic");
});

test("a stale index.lock", async () => {
  const dir = repo();
  const lock = join(dir, ".git", "index.lock");
  writeFileSync(lock, "");
  const old = (Date.now() - 10 * 60 * 1000) / 1000;
  utimesSync(lock, old, old);
  const f = (await findings(dir)).find((x) => x.id === "index-lock");
  assert.ok(f);
  assert.equal(f.level, "problem");
  assert.equal(cli(dir, "fix", "1", "--yes").code, 0);
  assert.equal(existsSync(lock), false);
});

test("an upstream rewritten by someone's force push", async () => {
  const remote = folder("remote");
  git(remote, "init", "-q", "--bare");
  const a = repo();
  git(a, "remote", "add", "origin", remote);
  commit(a, "x.txt", "shared\n", "shared");
  git(a, "push", "-q", "-u", "origin", "main");
  const b = folder("clone");
  git(b, "clone", "-q", "-b", "main", remote, "."); // a bare repository's HEAD may name another branch
  git(b, "reset", "-q", "--hard", "HEAD~1");
  commit(b, "y.txt", "rewritten\n", "rewritten history");
  git(b, "push", "-q", "--force", "origin", "main");
  commit(a, "z.txt", "my work\n", "my own work");
  git(a, "fetch", "-q");
  const f = (await findings(a)).find((x) => x.id === "upstream-rewritten");
  assert.ok(f);
  assert.match(f.detail, /1 commit of them are your own work/);
  assert.deepEqual(f.options[0].steps[0].slice(0, 2), ["rebase", "--onto"]);
});

test("an amend of the message is nothing; an amend that changed the content is information", async () => {
  const dir = repo();
  commit(dir, "a.txt", "a\n", "typo");
  git(dir, "commit", "-q", "--amend", "-m", "fixed message");
  assert.deepEqual(ids(await findings(dir)), [], "the same patch: nothing lost");
  writeFileSync(join(dir, "a.txt"), "a, changed in the amend\n");
  git(dir, "commit", "-q", "-a", "--amend", "-m", "fixed message");
  const f = await findings(dir);
  assert.deepEqual(ids(f), ["dropped-by-amend"]);
  assert.equal(f[0].level, "info");
});
