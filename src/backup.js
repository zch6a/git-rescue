// @ts-check
/**
 * Before git-rescue changes anything, it saves where every branch and HEAD were, and the changes you have
 * not committed, under refs/rescue/<time>/ (refs, so `git gc` keeps them and plain git can read them), and
 * notes it in .git/rescue.log. `git-rescue undo` uses the latest one.
 *
 * Not saved: untracked files (git's `stash create` does not take them); git-rescue's own actions never touch
 * them.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { git, refs, resolve } from "./git.js";

/**
 * @typedef {{stamp: string, label: string, head: string, branch: string | null, branches: Record<string, string>, worktree: string | null}} Backup
 */

/**
 * @param {string} cwd
 * @param {{gitDir: string, commonDir: string}} repo
 * @param {string} label  what is about to be done
 * @returns {Backup}
 */
export function backup(cwd, repo, label) {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const base = `refs/rescue/${stamp}`;
  const symbolic = git(cwd, ["symbolic-ref", "--quiet", "HEAD"], { allowFail: true }).trim();
  const headSha = resolve(cwd, "HEAD");
  /** @type {Record<string, string>} */
  const branches = {};
  for (const [name, sha] of refs(cwd)) {
    if (!name.startsWith("refs/heads/")) continue;
    branches[name.slice("refs/heads/".length)] = sha;
    git(cwd, ["update-ref", `${base}/${name.slice("refs/".length)}`, sha]);
  }
  if (headSha) git(cwd, ["update-ref", `${base}/HEAD`, headSha]);
  // A commit of the index and the working tree, as `git stash` would make, without touching either. git
  // cannot make one while files are in conflict (it says "needs merge" instead of an id): then there is none.
  const made = headSha ? git(cwd, ["stash", "create", `git-rescue backup before: ${label}`], { allowFail: true }).trim() : "";
  const worktree = /^[0-9a-f]{40}$/.test(made) ? made : null;
  if (worktree) git(cwd, ["update-ref", `${base}/worktree`, worktree]);
  /** @type {Backup} */
  const b = { stamp, label, head: symbolic || headSha || "", branch: symbolic.startsWith("refs/heads/") ? symbolic.slice(11) : null, branches, worktree };
  appendFileSync(join(repo.commonDir, "rescue.log"), JSON.stringify(b) + "\n");
  return b;
}

/** All backups, newest first. @param {{commonDir: string}} repo @returns {Backup[]} */
export function backups(repo) {
  const file = join(repo.commonDir, "rescue.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  }).reverse();
}

/**
 * The steps that put things back as they were at a backup: every branch that moved goes back (the one checked
 * out with `reset --keep`, which refuses to overwrite uncommitted changes), HEAD goes back to where it was,
 * and the uncommitted changes saved then can be applied again.
 * @param {string} cwd
 * @param {Backup} b
 * @returns {{steps: string[][], restoreWorktree: string[][] | null, created: string[]}}
 */
export function undoSteps(cwd, b) {
  const now = new Map([...refs(cwd)].filter(([n]) => n.startsWith("refs/heads/")).map(([n, s]) => [n.slice(11), s]));
  const current = git(cwd, ["symbolic-ref", "--quiet", "HEAD"], { allowFail: true }).trim().replace(/^refs\/heads\//, "");
  const steps = [];
  for (const [name, sha] of Object.entries(b.branches)) {
    if (now.get(name) === sha) continue;
    if (name === current) steps.push(["reset", "--keep", sha]);
    else steps.push(["branch", "-f", name, sha]); // also brings back a branch that was deleted
  }
  if (b.branch && b.branch !== current) steps.push(["checkout", b.branch]);
  else if (!b.branch && /^[0-9a-f]{40}$/.test(b.head) && resolve(cwd, "HEAD") !== b.head) steps.push(["checkout", "--detach", b.head]);
  const created = [...now.keys()].filter((n) => !(n in b.branches));
  return { steps, restoreWorktree: b.worktree ? [["stash", "apply", b.worktree]] : null, created };
}
