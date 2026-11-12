// @ts-check
/**
 * What no ref and no reflog reaches: dropped stashes, contents staged and never committed, and the list of such
 * objects that `lost` and the report share.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { commitInfo, git, keepers, objectSizes, objectTime, readObjects, samePath, short, toplevel, unreachableFromRefs, unreachableObjects, worktrees } from "../git.js";
import { ago, plural } from "../words.js";

/**
 * @typedef {import("../state.js").Finding} Finding
 * @typedef {import("../state.js").Option} Option
 * @typedef {import("../state.js").Repo} Repo
 * @typedef {import("../state.js").State} State
 */

/**
 * A stash is three commits: the work ("WIP on main: ..."), the index ("index on main: ...") and, with -u, the
 * untracked files. Only the first means something to the user; the others are left out when it is listed.
 * @template {{sha: string, subject: string, parents: string[]}} C
 * @param {C[]} commits
 * @returns {C[]}
 */
export function hideStashParts(commits) {
  const parts = new Set(commits.filter((c) => STASH.test(c.subject)).flatMap((c) => c.parents.slice(1)));
  return commits.filter((c) => !(parts.has(c.sha) && /^(index on|untracked files on) [^:]+:/.test(c.subject)));
}

/**
 * Objects nothing reaches, less what other worktrees keep (git 2.19's fsck ignores their HEADs and indexes):
 * commits (with their facts), and blobs that are not part of a lost commit's tree (staged, never committed).
 * @param {string} cwd
 * @param {string[]} [keep]
 */
export function lostObjects(cwd, keep = keepers(cwd)) {
  const objs = unreachableObjects(cwd);
  const fsckCommits = objs.filter((o) => o.type === "commit").map((o) => o.sha);
  const commits = fsckCommits.length ? unreachableFromRefs(cwd, fsckCommits, keep).filter((c) => fsckCommits.includes(c)) : [];
  const elsewhere = stagedInOtherWorktrees(cwd);
  const blobs = objs.filter((o) => o.type === "blob" && !elsewhere.has(o.sha)).map((o) => o.sha);
  let inCommits = new Set();
  if (fsckCommits.length && blobs.length) {
    const listed = git(cwd, ["rev-list", "--objects", "--no-walk", "--stdin"], { allowFail: true, input: fsckCommits.join("\n") + "\n" });
    inCommits = new Set(listed.split("\n").map((l) => l.slice(0, 40)));
  }
  const info = commitInfo(cwd, commits);
  return {
    commits: commits.map((sha) => ({ sha, ...(info.get(sha) ?? { subject: "", time: 0, parents: [] }) })).sort((a, b) => b.time - a.time),
    stagedBlobs: blobs.filter((b) => !inCommits.has(b)),
  };
}

/** Blobs staged in the indexes of this repository's other worktrees. @param {string} cwd */
function stagedInOtherWorktrees(cwd) {
  const here = toplevel(cwd);
  const out = new Set();
  for (const w of worktrees(cwd)) {
    if (!w.path || samePath(w.path, here) || !existsSync(w.path)) continue;
    for (const line of git(w.path, ["ls-files", "-s"], { allowFail: true }).split("\n")) {
      const m = line.match(/^\d+ ([0-9a-f]{40}) /);
      if (m) out.add(m[1]);
    }
  }
  return out;
}

/** A stash is a commit "WIP on main: ..." or "On main: ..." with the index as second parent. */
export const STASH = /^(WIP on|On) [^:]+:/;

/**
 * Dropped stashes that were not applied: a `stash pop` drops the stash after applying it, and that is no loss.
 * Applied means every file the stash changed is, in that version, in HEAD, the index or the working tree.
 * @param {string} cwd @param {ReturnType<typeof lostObjects>} lost @param {(f: Finding) => void} add @param {State} st
 */
export function droppedStashes(cwd, lost, add, st) {
  const stashes = lost.commits.filter((c) => STASH.test(c.subject) && c.parents.length >= 2).slice(0, 10);
  // The same work stashed twice (a pop, then a stash of it again) is one loss: same files, same untracked files.
  const trees = git(cwd, ["cat-file", "--batch-check=%(objectname)"], { allowFail: true,
    input: stashes.flatMap((s) => [`${s.sha}^{tree}`, s.parents[2] ? `${s.parents[2]}^{tree}` : "-"]).join("\n") + "\n" }).split("\n");
  const seen = new Set();
  for (const [i, s] of stashes.entries()) {
    const same = `${trees[2 * i]} ${trees[2 * i + 1]}`;
    if (seen.has(same)) continue;
    seen.add(same);
    const entries = stashFiles(cwd, s);
    if (!st.bare && stashApplied(cwd, entries)) continue;
    const files = entries.map((e) => e.path);
    const shown = files.slice(0, 5).join(", ") + (files.length > 5 ? ` and ${files.length - 5} more` : "");
    add({
      id: "dropped-stash",
      level: "warning",
      title: `A dropped stash: "${s.subject}"${s.time ? ` (${ago(s.time)})` : ""}`,
      detail: `It changed ${shown || "no files"}. It is off the stash list (\`stash drop\`, \`stash clear\`, or a \`stash pop\` after which you kept editing) and its version of those files is not in your files or commits; git still has it.`,
      commits: [s.sha],
      options: [{ title: "Put it back on the stash list", risk: "safe", steps: [["stash", "store", "-m", `rescued: ${s.subject}`, s.sha]] }],
    });
  }
}

/**
 * A few git calls per stash, whatever the number of files: the files it holds, then the stash's, HEAD's and the
 * index's version of each in one `cat-file --batch-check` (it takes `rev:path` names), then the working tree's in
 * one `hash-object` (with the same filters as `git add`).
 * @param {string} cwd @param {{path: string, spec: string}[]} entries
 */
function stashApplied(cwd, entries) {
  const list = entries.filter((e) => !/[\n\r]/.test(e.path)).slice(0, 200);
  const names = list.map((e) => e.path);
  if (!names.length) return true;
  const lines = git(cwd, ["cat-file", "--batch-check=%(objectname)"], { allowFail: true,
    input: list.flatMap((e) => [e.spec, `HEAD:${e.path}`, `:${e.path}`]).join("\n") + "\n" }).split("\n");
  const id = (/** @type {number} */ i) => (/^[0-9a-f]{40}$/.test(lines[i] ?? "") ? lines[i] : "");
  const top = toplevel(cwd);
  const onDisk = names.filter((f) => existsSync(join(top, f)));
  const hashed = onDisk.length ? git(top, ["hash-object", "--", ...onDisk], { allowFail: true }).split("\n") : [];
  const disk = new Map(onDisk.map((f, i) => [f, hashed[i]?.trim() ?? ""]));
  return names.every((f, i) => {
    const wanted = id(3 * i);
    if (!wanted) return true; // the stash deleted it; nothing to look for
    return wanted === id(3 * i + 1) || wanted === id(3 * i + 2) || wanted === disk.get(f);
  });
}

/**
 * The files a stash holds, each with the name of its stashed version: the tracked files it changed, and with
 * `stash -u` the untracked ones (in its third parent).
 * @param {string} cwd @param {{sha: string, parents: string[]}} s
 * @returns {{path: string, spec: string}[]}
 */
function stashFiles(cwd, s) {
  const tracked = git(cwd, ["diff", "--no-ext-diff", "--no-color", "--name-only", "-z", s.parents[0], s.sha], { allowFail: true }).split("\0").filter(Boolean);
  const out = tracked.map((path) => ({ path, spec: `${s.sha}:${path}` }));
  if (s.parents[2]) {
    for (const path of git(cwd, ["ls-tree", "-r", "-z", "--name-only", s.parents[2]], { allowFail: true }).split("\0").filter(Boolean)) {
      out.push({ path, spec: `${s.parents[2]}:${path}` });
    }
  }
  return out;
}

/**
 * Contents staged and never committed. Not those with conflict markers (git writes the marked-up file of a
 * conflicted merge to the object store); and only information, since `git add` of a file you then edited and
 * added again leaves the first version behind too. Only the newest READ are opened (each is a file to open, slow
 * on Windows when there are thousands); older ones are counted as they are.
 * @param {string} cwd @param {{commonDir: string}} repo @param {ReturnType<typeof lostObjects>} lost @param {(f: Finding) => void} add
 */
export function lostStaged(cwd, repo, lost, add) {
  const READ = 300;
  const byAge = lost.stagedBlobs.map((sha) => ({ sha, time: objectTime(repo, sha) ?? 0 })).sort((a, b) => b.time - a.time);
  const newest = byAge.slice(0, READ).map((b) => b.sha);
  const sizes = objectSizes(cwd, newest);
  const contents = readObjects(cwd, newest, 256 * 1024, sizes);
  const marked = (/** @type {string} */ b) => {
    const text = contents.get(b)?.toString("utf8") ?? "";
    return /^<<<<<<< /m.test(text) && /^>>>>>>> /m.test(text);
  };
  const real = byAge.filter((b, i) => i >= READ || !marked(b.sha));
  if (!real.length) return;
  const lines = real.slice(0, 5).map((b) => {
    const buf = contents.get(b.sha);
    const first = !buf ? "" : buf.subarray(0, 8000).includes(0) ? "(binary)" : (buf.toString("utf8").split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 70);
    return `  ${short(b.sha)}  ${(b.time ? ago(b.time) : "").padEnd(15)} ${first}`;
  });
  add({
    id: "lost-staged-files",
    level: "info",
    title: `${plural(real.length, "file version")} that you added (staged) but never committed`,
    detail: "What `git add` saved before a `reset --hard`, `checkout .` or `stash`, or an earlier version of a file you added again. git keeps the contents, not the names" +
      `${real.length > 5 ? " (the newest 5; `git-rescue lost` lists all)" : ""}:\n${lines.join("\n")}`,
    options: [
      { title: "Save one to a new file", risk: "manual", steps: [["git-rescue restore <id> <new-file-name>"]], note: "`git-rescue find \"some text\"` searches them all." },
    ],
  });
}
