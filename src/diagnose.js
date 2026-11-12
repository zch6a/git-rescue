// @ts-check
/**
 * What is wrong with this repository, and the ways back.
 *
 * Only the repository's state is read: files git leaves while an operation is under way (MERGE_HEAD,
 * rebase-merge/ ...), the reflogs, and the objects no ref reaches. No guessing from timing ("you committed a
 * minute ago, maybe by mistake"): each finding is something that is the case, with the commits it is about.
 *
 * Each finding has options: a title, how risky it is, and the exact git commands (as argument lists, shown
 * to the user before anything runs). "safe" changes nothing that cannot be undone with a plain git command;
 * "careful" moves a branch or the working tree (git-rescue backs everything up first); "manual" is a step
 * the user does (resolving a conflict).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { branches, commitInfo, git, gitRun, refs, reflog, resolve, short, unreachableFromRefs, unreachableObjects } from "./git.js";

/**
 * @typedef {{title: string, risk: "safe" | "careful" | "manual", steps: string[][], note?: string}} Option
 * @typedef {{id: string, level: "problem" | "warning" | "info", title: string, detail: string, options: Option[], commits?: string[]}} Finding
 */

/**
 * Steps are git's arguments ("branch", "x", sha), with two exceptions: a step of one string with spaces in it
 * is something the user does (shown, never run), and REMOVE_LOCK is done by git-rescue itself.
 */
export const REMOVE_LOCK = ":remove-index-lock";
/** @param {string[]} step */
export const isInstruction = (step) => step.length === 1 && step[0].includes(" ");

const RECENT = 60; // reflog entries looked at, per reflog
const DAY = 24 * 3600 * 1000;

/**
 * The state around the user: where HEAD is, what is under way, what is changed.
 * @param {string} cwd
 * @param {{top: string, gitDir: string, commonDir: string}} repo
 */
export function state(cwd, repo) {
  const head = git(cwd, ["symbolic-ref", "--quiet", "HEAD"], { allowFail: true }).trim();
  const headSha = resolve(cwd, "HEAD");
  const g = (/** @type {string} */ name) => join(repo.gitDir, name);
  let operation = null;
  if (existsSync(g("rebase-merge")) || existsSync(g("rebase-apply"))) {
    operation = existsSync(g("rebase-apply/applying")) ? "am" : "rebase";
  } else if (existsSync(g("MERGE_HEAD"))) operation = "merge";
  else if (existsSync(g("CHERRY_PICK_HEAD"))) operation = "cherry-pick";
  else if (existsSync(g("REVERT_HEAD"))) operation = "revert";
  else if (existsSync(g("BISECT_LOG"))) operation = "bisect";
  const status = git(cwd, ["status", "--porcelain"], { allowFail: true });
  const lines = status.split("\n").filter(Boolean);
  const conflicted = lines.filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l)).map((l) => l.slice(3));
  const lock = join(repo.gitDir, "index.lock");
  return {
    branch: head.startsWith("refs/heads/") ? head.slice("refs/heads/".length) : null,
    headSha,
    unborn: !headSha,
    operation,
    conflicted,
    changed: lines.filter((l) => !l.startsWith("??")).length,
    untracked: lines.filter((l) => l.startsWith("??")).length,
    lockAge: existsSync(lock) ? Date.now() - statSync(lock).mtimeMs : null,
  };
}

/**
 * All findings, most serious first.
 * @param {string} cwd
 * @param {{top: string, gitDir: string, commonDir: string}} repo
 * @returns {{state: ReturnType<typeof state>, findings: Finding[]}}
 */
export function diagnose(cwd, repo) {
  const st = state(cwd, repo);
  /** @type {Finding[]} */
  const findings = [];
  const add = (/** @type {Finding} */ f) => findings.push(f);
  const reported = new Set(); // commits already offered back, so one loss is said once

  inProgress(cwd, repo, st, add);
  if (st.lockAge !== null) staleLock(st.lockAge, add);
  if (!st.branch && st.headSha && !st.operation) detached(cwd, st.headSha, add, reported);
  leftBehind(cwd, repo, add, reported);
  rewound(cwd, repo, add, reported);
  deletedBranches(cwd, repo, add, reported);
  const lost = lostObjects(cwd);
  droppedStashes(lost, add);
  lostStaged(lost, add);
  upstreamRewritten(cwd, repo, st, add);

  const order = { problem: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return { state: st, findings };
}

// ---------------------------------------------------------------- an operation left half done

/** @param {string} cwd @param {{gitDir: string}} repo @param {ReturnType<typeof state>} st @param {(f: Finding) => void} add */
function inProgress(cwd, repo, st, add) {
  const op = st.operation;
  if (!op) return;
  const files = st.conflicted.length ? `Files with conflicts: ${st.conflicted.join(", ")}.` : "No files are in conflict.";
  const resolveStep = st.conflicted.length
    ? [["edit the files with conflicts, keep what you want, and remove the <<<<<<< ======= >>>>>>> lines"], ["add", "--", ...st.conflicted]]
    : [];
  if (op === "rebase" || op === "am") {
    const dir = existsSync(join(repo.gitDir, "rebase-merge")) ? "rebase-merge" : "rebase-apply";
    const read = (/** @type {string} */ f) => {
      try {
        return readFileSync(join(repo.gitDir, dir, f), "utf8").trim();
      } catch {
        return "";
      }
    };
    const done = read("msgnum") || read("next");
    const total = read("end") || read("last");
    const branch = read("head-name").replace(/^refs\/heads\//, "");
    const cmd = op === "am" ? "am" : "rebase";
    add({
      id: `${op}-in-progress`,
      level: "problem",
      title: op === "am" ? "A `git am` (applying patches) stopped halfway" : `A rebase${branch ? ` of ${branch}` : ""} stopped halfway${done && total ? ` (at commit ${done} of ${total})` : ""}`,
      detail: `${files} Until it is finished or abandoned, the branch is not where you think it is.`,
      options: [
        { title: `Abandon it: put ${branch || "the branch"} back exactly as it was before`, risk: "safe", steps: [[cmd, "--abort"]] },
        { title: "Finish it: resolve the conflicts, then go on", risk: "manual", steps: [...resolveStep, [cmd, "--continue"]] },
        { title: "Leave this commit out and go on with the rest", risk: "careful", steps: [[cmd, "--skip"]], note: "The commit's changes are dropped from the result (it stays findable with `git-rescue timeline`)." },
      ],
    });
  } else if (op === "merge") {
    add({
      id: "merge-in-progress",
      level: "problem",
      title: "A merge is waiting to be finished",
      detail: `${files}`,
      options: [
        { title: "Abandon the merge: back to before it started", risk: "careful", steps: [["merge", "--abort"]], note: "Changes you had not committed before the merge may be lost, and git cannot back them up while files are in conflict: commit or copy them first if you had any." },
        { title: "Finish it: resolve the conflicts, then commit", risk: "manual", steps: [...resolveStep, ["commit", "--no-edit"]] },
      ],
    });
  } else if (op === "cherry-pick" || op === "revert") {
    add({
      id: `${op}-in-progress`,
      level: "problem",
      title: `A ${op} is waiting to be finished`,
      detail: files,
      options: [
        { title: `Abandon the ${op}`, risk: "safe", steps: [[op, "--abort"]] },
        { title: "Finish it: resolve the conflicts, then go on", risk: "manual", steps: [...resolveStep, [op, "--continue"]] },
      ],
    });
  } else if (op === "bisect") {
    add({
      id: "bisect-in-progress",
      level: "warning",
      title: "A bisect is under way",
      detail: "HEAD is on a commit bisect picked, not on your branch.",
      options: [{ title: "End the bisect and go back to where you started", risk: "safe", steps: [["bisect", "reset"]] }],
    });
  }
}

/** @param {number} age @param {(f: Finding) => void} add */
function staleLock(age, add) {
  const minutes = Math.round(age / 60000);
  add({
    id: "index-lock",
    level: minutes >= 2 ? "problem" : "info",
    title: `.git/index.lock is there${minutes >= 1 ? ` (for ${minutes} min)` : ""}: git refuses to change anything`,
    detail: "git leaves this file when a git program (or an editor's git integration) was stopped in the middle. If none is running now, it is stale.",
    options: [
      { title: "Remove the lock (only if no git program is running)", risk: "careful", steps: [[REMOVE_LOCK]], note: "If a git command is still running, wait for it instead." },
    ],
  });
}

// ---------------------------------------------------------------- commits only the reflog still has

/** @param {string} cwd @param {string} headSha @param {(f: Finding) => void} add @param {Set<string>} reported */
function detached(cwd, headSha, add, reported) {
  const orphan = unreachableFromRefs(cwd, [headSha]);
  const name = rescueName("detached");
  if (orphan.length) {
    orphan.forEach((c) => reported.add(c));
    add({
      id: "detached-with-commits",
      level: "problem",
      title: `HEAD is detached, with ${orphan.length} commit${orphan.length > 1 ? "s" : ""} on no branch`,
      detail: `Switching to a branch now would leave ${plural(orphan.length, "commit")} behind (findable only through the reflog, and gone when it expires).`,
      commits: orphan,
      options: [
        { title: `Put them on a new branch "${name}" and switch to it`, risk: "safe", steps: [["branch", name, headSha], ["checkout", name]] },
      ],
    });
  } else {
    const on = git(cwd, ["branch", "--contains", headSha, "--format=%(refname:short)"], { allowFail: true }).split("\n").filter(Boolean);
    add({
      id: "detached",
      level: "info",
      title: `HEAD is detached at ${short(headSha)}`,
      detail: on.length ? `This commit is on ${on.slice(0, 3).join(", ")}${on.length > 3 ? " ..." : ""}. Nothing is at risk.` : "Nothing is at risk.",
      options: on.length ? [{ title: `Go back to ${on[0]}`, risk: "safe", steps: [["checkout", on[0]]] }] : [],
    });
  }
}

/**
 * Leaving a detached HEAD that had commits: "checkout: moving from <sha> to main".
 * @param {string} cwd @param {{gitDir: string, commonDir: string}} repo @param {(f: Finding) => void} add @param {Set<string>} reported
 */
function leftBehind(cwd, repo, add, reported) {
  for (const e of reflog(repo, "HEAD").slice(0, RECENT)) {
    const m = e.message.match(/^checkout: moving from ([0-9a-f]{40}) to /);
    if (!m || reported.has(m[1])) continue;
    const lost = unreachableFromRefs(cwd, [m[1]]).filter((c) => !reported.has(c));
    if (!lost.length) continue;
    lost.forEach((c) => reported.add(c));
    const name = rescueName("detached");
    add({
      id: "left-on-detached-head",
      level: "problem",
      title: `${plural(lost.length, "commit")} left behind on a detached HEAD ${ago(e.time)}`,
      detail: `They were made without a branch, then HEAD moved away (${e.message}). No branch has them.`,
      commits: lost,
      options: [{ title: `Put them on a new branch "${name}"`, risk: "safe", steps: [["branch", name, m[1]]] }],
    });
  }
}

/**
 * A branch moved so that commits fell off it: `reset`, `rebase`, `commit --amend`, a forced pull.
 * @param {string} cwd @param {{gitDir: string, commonDir: string}} repo @param {(f: Finding) => void} add @param {Set<string>} reported
 */
function rewound(cwd, repo, add, reported) {
  for (const branch of branches(cwd)) {
    for (const e of reflog(repo, `refs/heads/${branch}`).slice(0, RECENT)) {
      if (e.old === e.new || /^0+$/.test(e.old) || reported.has(e.old)) continue;
      const kind = e.message.startsWith("reset:") ? "reset" : e.message.startsWith("rebase") ? "rebase"
        : e.message.startsWith("commit (amend)") ? "amend" : e.message.startsWith("pull") || e.message.startsWith("merge") ? "pull" : null;
      if (!kind) continue;
      const lost = unreachableFromRefs(cwd, [e.old]).filter((c) => !reported.has(c));
      if (!lost.length) continue;
      lost.forEach((c) => reported.add(c));
      const name = rescueName(`${branch}-before-${kind}`);
      const what = { reset: `a reset (${e.message.replace(/^reset: /, "")})`, rebase: "a rebase", amend: "`commit --amend`", pull: "a pull" }[kind];
      const amendOnly = kind === "amend" && lost.length === 1;
      add({
        id: `dropped-by-${kind}`,
        level: amendOnly ? "info" : "warning",
        title: amendOnly
          ? `The commit replaced by \`commit --amend\` on ${branch} ${ago(e.time)} is still there`
          : `${plural(lost.length, "commit")} fell off ${branch} with ${what} ${ago(e.time)}`,
        detail: amendOnly
          ? "Usually what you wanted; it is here in case the amend lost something."
          : `${branch} was at ${short(e.old)} before; no branch has those commits now.`,
        commits: lost,
        options: [
          { title: `Keep them on a new branch "${name}" (${branch} stays as it is)`, risk: "safe", steps: [["branch", name, e.old]] },
          ...(amendOnly ? [] : [{
            title: `Put ${branch} back where it was (${short(e.old)})`,
            risk: /** @type {const} */ ("careful"),
            steps: [["checkout", branch], ["reset", "--keep", e.old]],
            note: `--keep refuses to run if it would overwrite changes you have not committed; git-rescue saves them first anyway.`,
          }]),
        ],
      });
    }
  }
}

/**
 * Branches deleted with commits no other branch has: "checkout: moving from feature to main" in HEAD's
 * reflog, and no feature branch now.
 * @param {string} cwd @param {{gitDir: string, commonDir: string}} repo @param {(f: Finding) => void} add @param {Set<string>} reported
 */
function deletedBranches(cwd, repo, add, reported) {
  const now = new Set(branches(cwd));
  const seen = new Set();
  for (const e of reflog(repo, "HEAD").slice(0, RECENT * 2)) {
    const m = e.message.match(/^checkout: moving from (\S+) to /);
    if (!m || /^[0-9a-f]{40}$/.test(m[1]) || now.has(m[1]) || seen.has(m[1])) continue;
    seen.add(m[1]);
    const tip = e.old; // where HEAD was when it left the branch: its last commit then
    const lost = unreachableFromRefs(cwd, [tip]).filter((c) => !reported.has(c));
    if (!lost.length) continue;
    lost.forEach((c) => reported.add(c));
    add({
      id: "deleted-branch",
      level: "warning",
      title: `Branch "${m[1]}" was deleted with ${plural(lost.length, "commit")} no other branch has`,
      detail: `Its last commit seen was ${short(tip)}, when you left it ${ago(e.time)}. (Commits made on it after you last left it are not in this reflog: check \`git-rescue lost\`.)`,
      commits: lost,
      options: [{ title: `Bring "${m[1]}" back`, risk: "safe", steps: [["branch", m[1], tip]] }],
    });
  }
}

// ---------------------------------------------------------------- what no ref and no reflog reaches

/** @param {string} cwd */
export function lostObjects(cwd) {
  const objs = unreachableObjects(cwd);
  const commits = objs.filter((o) => o.type === "commit").map((o) => o.sha);
  const blobs = objs.filter((o) => o.type === "blob").map((o) => o.sha);
  // Blobs that belong to a lost commit's tree are that commit's files; the rest were added (staged) and
  // never committed: what `reset --hard` or `checkout .` took.
  let inCommits = new Set();
  if (commits.length && blobs.length) {
    const listed = git(cwd, ["rev-list", "--objects", "--no-walk", ...commits], { allowFail: true });
    inCommits = new Set(listed.split("\n").map((l) => l.slice(0, 40)));
  }
  const info = commitInfo(cwd, commits);
  return {
    commits: commits.map((sha) => ({ sha, ...(info.get(sha) ?? { subject: "", time: 0, parents: [] }) })).sort((a, b) => b.time - a.time),
    stagedBlobs: blobs.filter((b) => !inCommits.has(b)),
  };
}

/** A stash is a commit "WIP on main: ..." or "On main: ..." with the index as second parent. */
const STASH = /^(WIP on|On) [^:]+:/;

/** @param {ReturnType<typeof lostObjects>} lost @param {(f: Finding) => void} add */
function droppedStashes(lost, add) {
  const stashes = lost.commits.filter((c) => STASH.test(c.subject) && c.parents.length >= 2);
  for (const s of stashes.slice(0, 10)) {
    add({
      id: "dropped-stash",
      level: "warning",
      title: `A dropped stash: "${s.subject}"${s.time ? ` (${ago(s.time)})` : ""}`,
      detail: "It was removed from the stash list (`stash drop`, `stash clear`, or a `stash pop` that you undid), but git still has it.",
      commits: [s.sha],
      options: [{ title: "Put it back on the stash list", risk: "safe", steps: [["stash", "store", "-m", `rescued: ${s.subject}`, s.sha]] }],
    });
  }
}

/** @param {ReturnType<typeof lostObjects>} lost @param {(f: Finding) => void} add */
function lostStaged(lost, add) {
  if (!lost.stagedBlobs.length) return;
  const n = lost.stagedBlobs.length;
  add({
    id: "lost-staged-files",
    level: "warning",
    title: `${plural(n, "file version")} that you added (staged) but never committed`,
    detail: "What `git add` saved before a `reset --hard`, `checkout .` or `stash` without a later commit. git has no names for them, only the contents.",
    options: [
      { title: "Look at them and save the ones you want", risk: "manual", steps: [["run git-rescue lost to list them"]], note: "`git-rescue find \"some text\"` searches them; `git-rescue restore <id> <file>` saves one." },
    ],
  });
}

// ---------------------------------------------------------------- someone else's force push

/** @param {string} cwd @param {{gitDir: string, commonDir: string}} repo @param {ReturnType<typeof state>} st @param {(f: Finding) => void} add */
function upstreamRewritten(cwd, repo, st, add) {
  if (!st.branch) return;
  const up = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFail: true }).trim();
  if (!up || up.startsWith("@{u}")) return;
  const forced = reflog(repo, `refs/remotes/${up}`).find((e) => /forced-update/.test(e.message) && Date.now() - e.time < 30 * DAY);
  if (!forced) return;
  const mine = git(cwd, ["rev-list", `${up}..${st.branch}`], { allowFail: true }).split("\n").filter(Boolean);
  const ownSinceOld = git(cwd, ["rev-list", `${forced.old}..${st.branch}`], { allowFail: true }).split("\n").filter(Boolean);
  if (!mine.length) return;
  add({
    id: "upstream-rewritten",
    level: "warning",
    title: `${up} was rewritten (force-pushed) ${ago(forced.time)}; ${st.branch} still has the old history`,
    detail: `${plural(mine.length, "commit")} on ${st.branch} are not on ${up}; ${plural(ownSinceOld.length, "commit")} of them are your own work since the old ${up}. Pulling now would merge the old history back in.`,
    commits: mine,
    options: [
      { title: `Move your own commits onto the new ${up}`, risk: "careful", steps: [["rebase", "--onto", up, forced.old, st.branch]], note: "Only the commits made after the old upstream are replayed." },
      { title: `Keep a copy of ${st.branch} as it is, on a new branch`, risk: "safe", steps: [["branch", rescueName(`${st.branch}-old-history`), st.branch]] },
    ],
  });
}

// ---------------------------------------------------------------- small helpers

/** @param {string} what */
export function rescueName(what) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return `rescued/${what.replace(/[^\w.-]+/g, "-")}-${stamp}`;
}

/** @param {number} n @param {string} word */
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** @param {number} time */
export function ago(time) {
  const s = Math.max(0, (Date.now() - time) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export { refs, gitRun };
