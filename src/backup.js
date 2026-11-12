// @ts-check
/**
 * Before git-rescue changes anything, it saves where every branch and HEAD were, and the changes you have not
 * committed, under refs/rescue/<time>/ (refs, so `git gc` keeps them and plain git can read them), and notes it
 * in .git/rescue.log; after the fix it notes where they are then. `git-rescue undo` uses both: it puts back only
 * what the fix changed, and leaves alone what moved since.
 *
 * The uncommitted changes are saved as `git stash create` saves them (a commit, without touching your files).
 * git cannot do that while files are in conflict; then the changed files are copied as they are to
 * .git/rescue-files/<time>/. Untracked files are not saved; git-rescue's fixes never touch them.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { statusEntries } from "./diagnose.js";
import { forget, git, refs, resolve, samePath, worktrees } from "./git.js";

/**
 * @typedef {{head: string, branches: Record<string, string>}} RefState
 * @typedef {{stamp: string, label: string, top: string, head: string, branch: string | null, branches: Record<string, string>,
 *   worktree: string | null, files: string | null, after?: RefState}} Backup
 */

/** Where HEAD and every branch are now. @param {string} cwd @returns {RefState} */
export function refState(cwd) {
  forget(); // where things are now, not where they were when git-rescue started
  const symbolic = git(cwd, ["symbolic-ref", "--quiet", "HEAD"], { allowFail: true }).trim();
  /** @type {Record<string, string>} */
  const branches = {};
  for (const [name, sha] of refs(cwd)) if (name.startsWith("refs/heads/")) branches[name.slice(11)] = sha;
  return { head: symbolic || resolve(cwd, "HEAD") || "", branches };
}

/**
 * @param {string} cwd
 * @param {{gitDir: string, commonDir: string, top: string}} repo
 * @param {string} label  what is about to be done
 * @returns {Backup}
 */
export function backup(cwd, repo, label) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const base = `refs/rescue/${stamp}`;
  const now = refState(cwd);
  const headSha = resolve(cwd, "HEAD");
  for (const [name, sha] of Object.entries(now.branches)) git(cwd, ["update-ref", `${base}/heads/${name}`, sha]);
  if (headSha) git(cwd, ["update-ref", `${base}/HEAD`, headSha]);
  // A commit of the index and the working tree, as `git stash` would make, without touching either. git
  // cannot make one while files are in conflict (it says "needs merge" instead of an id): then copies.
  const made = headSha ? git(cwd, ["stash", "create", `git-rescue backup before: ${label}`], { allowFail: true }).trim() : "";
  const worktree = /^[0-9a-f]{40}$/.test(made) ? made : null;
  if (worktree) git(cwd, ["update-ref", `${base}/worktree`, worktree]);
  let files = null;
  if (!worktree) {
    const changed = statusEntries(cwd).filter((e) => e.xy !== "??" && existsSync(join(repo.top, e.path)));
    if (changed.length) {
      files = join(repo.commonDir, "rescue-files", stamp);
      for (const e of changed) {
        const to = join(files, e.path);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(join(repo.top, e.path), to);
      }
    }
  }
  /** @type {Backup} */
  const b = { stamp, label, top: repo.top, head: now.head, branch: now.head.startsWith("refs/heads/") ? now.head.slice(11) : null, branches: now.branches, worktree, files };
  appendFileSync(join(repo.commonDir, "rescue.log"), JSON.stringify(b) + "\n");
  return b;
}

/** Notes where things are after a fix (run even when a step failed). @param {string} cwd @param {{commonDir: string}} repo @param {string} stamp */
export function recordAfter(cwd, repo, stamp) {
  appendFileSync(join(repo.commonDir, "rescue.log"), JSON.stringify({ stamp, after: refState(cwd) }) + "\n");
}

/** All backups, newest first, each with where things were after its fix. @param {{commonDir: string}} repo @returns {Backup[]} */
export function backups(repo) {
  const file = join(repo.commonDir, "rescue.log");
  if (!existsSync(file)) return [];
  /** @type {Map<string, Backup>} */
  const byStamp = new Map();
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l) continue;
    try {
      const o = JSON.parse(l);
      if (o.after && byStamp.has(o.stamp)) /** @type {Backup} */ (byStamp.get(o.stamp)).after = o.after;
      else if (o.label) byStamp.set(o.stamp, o);
    } catch {
      // a damaged line: skip it
    }
  }
  return [...byStamp.values()].reverse();
}

/**
 * The steps that undo a fix: each branch the fix moved, created or deleted goes back, if it is still where the
 * fix left it (a branch that moved since is left alone and named); HEAD goes back if the fix moved it. The
 * checked-out branch moves with `reset --keep`, which refuses to overwrite uncommitted changes.
 * @param {string} cwd
 * @param {Backup} b
 * @returns {{steps: string[][], skipped: string[], restoreWorktree: string[][] | null, files: string | null}}
 */
export function undoSteps(cwd, b) {
  const now = refState(cwd);
  const after = b.after;
  /** @type {string[]} */
  const skipped = [];
  if (!after) return { steps: [], skipped: ["git-rescue did not get to note where things were after this fix, so it cannot tell what the fix changed"], restoreWorktree: null, files: b.files };
  const elsewhere = new Set(worktrees(cwd).filter((w) => w.branch && !samePath(w.path, b.top)).map((w) => w.branch));
  const steps = [];
  // HEAD first: the branch ops below then act on the branch that will be checked out.
  let current = now.head.startsWith("refs/heads/") ? now.head.slice(11) : null;
  if (after.head !== b.head) {
    if (now.head !== after.head) skipped.push(`HEAD (moved since the fix)`);
    else if (b.branch) {
      steps.push(b.branches[b.branch] && !now.branches[b.branch] ? ["checkout", "-b", b.branch, b.branches[b.branch]] : ["checkout", b.branch]);
      current = b.branch;
    } else if (/^[0-9a-f]{40}$/.test(b.head)) {
      steps.push(["checkout", "--detach", b.head]);
      current = null;
    }
  }
  const names = new Set([...Object.keys(b.branches), ...Object.keys(after.branches)]);
  for (const name of names) {
    const before = b.branches[name], afterSha = after.branches[name], nowSha = now.branches[name];
    if (before === afterSha) continue; // the fix did not touch it
    if (nowSha !== afterSha) { skipped.push(`${name} (moved since the fix)`); continue; }
    if (elsewhere.has(name)) { skipped.push(`${name} (checked out in another worktree)`); continue; }
    if (steps.some((s) => s[0] === "checkout" && s[1] === "-b" && s[2] === name)) continue;
    if (!before) steps.push(["branch", "-D", name]); // made by the fix: its commits stay in the reflog and the backup
    else if (name === current) steps.push(["reset", "--keep", before]);
    else steps.push(["branch", "-f", name, before]); // also brings back a branch the fix deleted
  }
  return { steps, skipped, restoreWorktree: b.worktree ? [["stash", "apply", b.worktree]] : null, files: b.files };
}
