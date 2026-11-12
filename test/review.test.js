// @ts-check
/** Regression tests for the first independent review (POLISH_LOG, round 1). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { at, cli, commit, folder, git, repo } from "./helpers.js";
import { diagnose } from "../src/diagnose.js";

/** @param {string} dir */
async function findings(dir) {
  return diagnose(dir, await at(dir)).findings;
}
const ids = (/** @type {{id: string}[]} */ fs) => fs.map((f) => f.id);

/** A rebase of topic onto main stopped on a conflict in a.txt. */
function stoppedRebase() {
  const dir = repo();
  commit(dir, "a.txt", "base\n", "base");
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, "a.txt", "topic\n", "topic");
  git(dir, "checkout", "-q", "main");
  commit(dir, "a.txt", "main\n", "main");
  git(dir, "checkout", "-q", "topic");
  try {
    git(dir, "rebase", "-q", "main");
  } catch {
    // the conflict
  }
  return dir;
}

test("abandoning a rebase keeps a copy of the conflict work it resets", async () => {
  const dir = stoppedRebase();
  writeFileSync(join(dir, "a.txt"), "MY CAREFUL RESOLUTION\n");
  const f = (await findings(dir)).find((x) => x.id === "rebase-in-progress");
  assert.equal(f?.options[0].risk, "careful", "not 'safe': it resets files");
  const r = cli(dir, "fix", "1a", "--yes");
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /copied as they are to/);
  const copies = join(dir, ".git", "rescue-files");
  const stamp = readdirSync(copies)[0];
  assert.equal(readFileSync(join(copies, stamp, "a.txt"), "utf8"), "MY CAREFUL RESOLUTION\n");
});

test("undo puts back only what the fix changed, and leaves later work alone", async () => {
  const dir = repo();
  git(dir, "branch", "feature"); // before the commit that gets lost, so feature does not keep it
  commit(dir, "a.txt", "a\n", "second");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  const fix = cli(dir, "fix", "1a", "--yes"); // makes a rescued/ branch only
  assert.equal(fix.code, 0, fix.out + fix.err);
  const mainNow = commit(dir, "m.txt", "later on main\n", "later on main");
  git(dir, "checkout", "-q", "feature");
  const featureNow = commit(dir, "f.txt", "later on feature\n", "later on feature");
  git(dir, "checkout", "-q", "main");
  const u = cli(dir, "undo", "--yes");
  assert.equal(u.code, 0, u.out + u.err);
  assert.equal(git(dir, "rev-parse", "main"), mainNow, "main keeps its later commit");
  assert.equal(git(dir, "rev-parse", "feature"), featureNow, "feature keeps its later commit");
  assert.equal(git(dir, "branch", "--list", "rescued/*"), "", "the branch the fix made is gone again");
});

test("undo of a fix that moved HEAD from detached to a new branch", async () => {
  const dir = repo();
  git(dir, "checkout", "-q", "--detach");
  const lost = commit(dir, "d.txt", "d\n", "detached work");
  assert.equal(cli(dir, "fix", "1a", "--yes").code, 0);
  assert.match(git(dir, "symbolic-ref", "--short", "HEAD"), /^rescued\//);
  assert.equal(cli(dir, "undo", "--yes").code, 0);
  assert.equal(git(dir, "rev-parse", "HEAD"), lost);
  assert.equal(spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: dir }).status, 1, "detached again");
});

test("hundreds of reflog entries and lost commits do not overflow the command line", async () => {
  const dir = repo();
  const n = 900;
  let stream = "";
  for (let i = 1; i <= n; i++) {
    const msg = `commit ${i}`;
    stream += `commit refs/heads/many\nmark :${i}\ncommitter T <t@x> ${1700000000 + i} +0000\ndata ${msg.length}\n${msg}\n`;
    if (i === 1) stream += "from refs/heads/main\n";
    stream += `M 644 inline f.txt\ndata ${String(i).length}\n${i}\n\n`;
  }
  const r = spawnSync("git", ["fast-import", "--quiet"], { cwd: dir, input: stream });
  assert.equal(r.status, 0, String(r.stderr));
  const shas = git(dir, "rev-list", "--reverse", "many").split("\n");
  const log = join(dir, ".git", "logs", "refs", "heads", "many");
  writeFileSync(log, "");
  let old = "0".repeat(40);
  for (const s of shas) {
    appendFileSync(log, `${old} ${s} T <t@x> 1700000000 +0000\tcommit: x\n`);
    old = s;
  }
  git(dir, "branch", "-q", "-D", "many"); // all 900 now only in... nothing: the deleted branch's reflog goes too
  git(dir, "update-ref", "refs/heads/keep", shas[0]);
  for (const cmd of [[], ["lost"], ["find", "commit 450"]]) {
    const out = cli(dir, ...cmd);
    assert.notEqual(out.code, 2, `${cmd.join(" ") || "report"}: ${out.err.slice(0, 300)}`);
  }
});

test("a routine rebase or pull --rebase is not a loss", async () => {
  const dir = repo();
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, "t.txt", "t\n", "topic work");
  git(dir, "checkout", "-q", "main");
  commit(dir, "m.txt", "m\n", "main work");
  git(dir, "checkout", "-q", "topic");
  git(dir, "rebase", "-q", "main");
  assert.deepEqual(ids(await findings(dir)), []);
});

test("a stash that was popped is not a dropped stash", async () => {
  const dir = repo();
  writeFileSync(join(dir, "README.md"), "work in progress\n");
  git(dir, "stash", "-q");
  git(dir, "stash", "pop", "-q");
  git(dir, "commit", "-q", "-am", "commit the stashed work");
  assert.deepEqual(ids(await findings(dir)), []);
});

test("re-adding a file and resolving a merge are not losses", async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.txt"), "first draft\n");
  git(dir, "add", "a.txt");
  writeFileSync(join(dir, "a.txt"), "second draft\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "a");
  const f = await findings(dir);
  assert.ok(f.every((x) => x.level === "info"), "at most information");
  const m = repo();
  git(m, "checkout", "-q", "-b", "other");
  commit(m, "README.md", "theirs\n", "theirs");
  git(m, "checkout", "-q", "main");
  commit(m, "README.md", "mine\n", "mine");
  try {
    git(m, "merge", "-q", "other");
  } catch {
    // conflict
  }
  writeFileSync(join(m, "README.md"), "both\n");
  git(m, "add", "README.md");
  git(m, "commit", "-q", "--no-edit");
  assert.deepEqual(ids(await findings(m)), [], "the conflict-marker version git wrote is not a lost file");
});

test("an upstream force-push that has been dealt with is not reported again", async () => {
  const remote = folder("remote");
  git(remote, "init", "-q", "--bare");
  const a = repo();
  git(a, "remote", "add", "origin", remote);
  commit(a, "x.txt", "shared\n", "shared");
  git(a, "push", "-q", "-u", "origin", "main");
  const b = folder("clone");
  git(b, "clone", "-q", "-b", "main", remote, ".");
  git(b, "reset", "-q", "--hard", "HEAD~1");
  commit(b, "y.txt", "rewritten\n", "rewritten");
  git(b, "push", "-q", "--force", "origin", "main");
  git(a, "fetch", "-q");
  git(a, "reset", "-q", "--hard", "origin/main");
  commit(a, "z.txt", "new work\n", "new work");
  assert.ok(!ids(await findings(a)).includes("upstream-rewritten"));
});

test("conflicted files with non-ASCII names get a git add that works", async () => {
  const dir = repo();
  commit(dir, "笔记.txt", "base\n", "base");
  git(dir, "checkout", "-q", "-b", "other");
  commit(dir, "笔记.txt", "theirs\n", "theirs");
  git(dir, "checkout", "-q", "main");
  commit(dir, "笔记.txt", "mine\n", "mine");
  try {
    git(dir, "merge", "-q", "other");
  } catch {
    // conflict
  }
  const f = (await findings(dir)).find((x) => x.id === "merge-in-progress");
  const add = f?.options[1].steps.find((s) => s[0] === "add");
  assert.deepEqual(add, ["add", "--", "笔记.txt"]);
});

test("losses from branch -f, checkout -B and a reset while detached are found", async () => {
  const a = repo();
  git(a, "checkout", "-q", "-b", "feat");
  commit(a, "f.txt", "f\n", "feature");
  git(a, "checkout", "-q", "main");
  git(a, "branch", "-f", "feat", "main");
  assert.ok(ids(await findings(a)).includes("dropped-by-branch"), "branch -f");
  const b = repo();
  commit(b, "b.txt", "b\n", "second");
  git(b, "checkout", "-q", "-B", "main", "HEAD~1");
  assert.ok((await findings(b)).some((x) => x.id.startsWith("dropped-by")), "checkout -B");
  const c = repo();
  git(c, "checkout", "-q", "--detach");
  commit(c, "d1.txt", "1\n", "d1");
  commit(c, "d2.txt", "2\n", "d2");
  git(c, "reset", "-q", "--hard", "HEAD~2");
  git(c, "checkout", "-q", "main");
  assert.ok(ids(await findings(c)).includes("left-on-detached-head"), "reset while detached");
});

test("two losses never propose the same rescue branch name", async () => {
  const dir = repo();
  commit(dir, "a.txt", "a\n", "a");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  commit(dir, "b.txt", "b\n", "b");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  const names = (await findings(dir)).map((f) => f.options[0].steps[0][1]);
  assert.equal(new Set(names).size, names.length);
  assert.equal(cli(dir, "fix", "1a", "--yes").code, 0);
  assert.equal(cli(dir, "fix", "1a", "--yes").code, 0, "the second one too");
});

test("finishing a cherry-pick does not wait for an editor", async () => {
  const dir = repo();
  git(dir, "checkout", "-q", "-b", "other");
  const pick = commit(dir, "README.md", "theirs\n", "theirs");
  git(dir, "checkout", "-q", "main");
  commit(dir, "README.md", "mine\n", "mine");
  try {
    git(dir, "cherry-pick", pick);
  } catch {
    // conflict
  }
  writeFileSync(join(dir, "README.md"), "resolved\n");
  git(dir, "add", "README.md");
  const env = { ...process.env, GIT_EDITOR: "node -e \"setTimeout(()=>{},60000)\"" }; // would hang for a minute
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/git-rescue.js", import.meta.url)), "-C", dir, "fix", "1b", "--yes"],
    { encoding: "utf8", env, timeout: 30000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}${r.error ?? ""}`);
  assert.equal(existsSync(join(dir, ".git", "CHERRY_PICK_HEAD")), false);
});

test("a bare repository, and stashes and notes that are not lost", async () => {
  const src = repo();
  commit(src, "a.txt", "a\n", "a");
  const bare = folder("bare");
  git(bare, "clone", "-q", "--bare", src, ".");
  const r = cli(bare);
  assert.notEqual(r.code, 2, r.err);
  assert.match(r.out, /bare repository/);
  const dir = repo();
  writeFileSync(join(dir, "README.md"), "one\n");
  git(dir, "stash", "-q");
  writeFileSync(join(dir, "README.md"), "two\n");
  git(dir, "stash", "-q");
  git(dir, "notes", "add", "-m", "a note");
  assert.match(cli(dir, "lost").out, /Nothing lost/);
});

test("worktrees: what another worktree has staged is not lost, and undo stays in its worktree", async () => {
  const dir = repo();
  const other = join(folder("wt"), "linked");
  git(dir, "worktree", "add", "-b", "side", other); // no -q: git 2.19 does not have it here
  writeFileSync(join(other, "staged-there.txt"), "staged in the other worktree\n");
  git(other, "add", "staged-there.txt");
  assert.ok(!ids(await findings(dir)).includes("lost-staged-files"), "it is in the other worktree's index");
  commit(other, "s.txt", "s\n", "side work");
  git(other, "reset", "-q", "--hard", "HEAD~1");
  assert.equal(cli(other, "fix", "1a", "--yes").code, 0, "a fix made in the linked worktree");
  const u = cli(dir, "undo", "--yes");
  assert.equal(u.code, 2);
  assert.match(u.err, /run git-rescue undo there/);
});

test("restore writes the line endings git would check out", () => {
  const dir = repo();
  git(dir, "config", "core.autocrlf", "true");
  writeFileSync(join(dir, "notes.txt"), "line one\nline two\n");
  git(dir, "add", "notes.txt");
  git(dir, "reset", "-q", "--hard");
  const id = cli(dir, "find", "line two").out.match(/\b([0-9a-f]{8})\b/)?.[1];
  assert.ok(id);
  assert.equal(cli(dir, "restore", id, join(dir, "notes.txt")).code, 0);
  assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "line one\r\nline two\r\n");
  assert.equal(cli(dir, "find", "nowhere", "--json").code, 1, "no match is exit 1 with --json too");
});
