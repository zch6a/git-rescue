// @ts-check
/**
 * What is wrong with this repository, and the ways back.
 *
 * Only the repository's state is read: files git leaves while an operation is under way (MERGE_HEAD,
 * rebase-merge/ ...), the reflogs, and the objects no ref reaches. No guessing from timing ("you committed a
 * minute ago, maybe by mistake"): each finding is something that is the case, with the commits it is about.
 *
 * A commit counts as lost when no ref keeps it (branches, tags, remotes, notes, every stash on the list, the
 * HEADs of other worktrees) and its changes are not already on the branch in another form: a rebase or an
 * amend that kept the patch is what the user meant, not a loss (`git cherry` compares patches, not ids).
 *
 * Each finding has options: a title, how risky it is, and the exact git commands (as argument lists, shown
 * to the user before anything runs). "safe" changes nothing that cannot be undone with a plain git command;
 * "careful" moves a branch or the working tree (git-rescue backs everything up first); "manual" is a step
 * the user does (resolving a conflict).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { branches, commitInfo, git, gitRun, keepers, readObjects, refs, reflog, resolve, short, unreachableFromRefs, unreachableObjects, worktrees } from "./git.js";
import { describe } from "./timeline.js";

/**
 * @typedef {{title: string, risk: "safe" | "careful" | "manual", steps: string[][], note?: string}} Option
 * @typedef {{id: string, level: "problem" | "warning" | "info", title: string, detail: string, options: Option[], commits?: string[]}} Finding
 * @typedef {{gitDir: string, commonDir: string, top: string, bare?: boolean}} Repo
 */

/**
 * Steps are git's arguments ("branch", "x", sha), with two exceptions: a step of one string with spaces in it
 * is something the user does (shown, never run), and REMOVE_LOCK is done by git-rescue itself.
 */
export const REMOVE_LOCK = ":remove-index-lock";
/** @param {string[]} step */
export const isInstruction = (step) => step.length === 1 && step[0].includes(" ");

const RECENT = 100; // reflog entries looked at, per reflog
const DAY = 24 * 3600 * 1000;

/**
 * The state around the user: where HEAD is, what is under way, what is changed.
 * @param {string} cwd
 * @param {Repo} repo
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
  const files = repo.bare ? [] : statusEntries(cwd);
  const lock = join(repo.gitDir, "index.lock");
  return {
    branch: head.startsWith("refs/heads/") ? head.slice("refs/heads/".length) : null,
    headSha,
    unborn: !headSha,
    bare: Boolean(repo.bare),
    operation,
    conflicted: files.filter((f) => /^(UU|AA|DD|AU|UA|DU|UD)$/.test(f.xy)).map((f) => f.path),
    changed: files.filter((f) => f.xy !== "??").length,
    untracked: files.filter((f) => f.xy === "??").length,
    lockAge: existsSync(lock) ? Date.now() - statSync(lock).mtimeMs : null,
  };
}

/**
 * `git status --porcelain -z`: each path as it is (without -z, git quotes names with non-ASCII characters,
 * quotes or backslashes, and a `git add` of the quoted name fails).
 * @param {string} cwd
 * @returns {{xy: string, path: string}[]}
 */
export function statusEntries(cwd) {
  const out = git(cwd, ["status", "--porcelain", "-z"], { allowFail: true });
  const parts = out.split("\0");
  const list = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    list.push({ xy, path: p.slice(3) });
    if (xy[0] === "R" || xy[0] === "C") i++; // a rename is followed by the old name
  }
  return list;
}

/**
 * All findings, most serious first.
 * @param {string} cwd
 * @param {Repo} repo
 * @returns {{state: ReturnType<typeof state>, findings: Finding[]}}
 */
export function diagnose(cwd, repo) {
  const st = state(cwd, repo);
  /** @type {Finding[]} */
  const findings = [];
  const keep = keepers(cwd);
  const ctx = {
    cwd,
    repo,
    keep,
    reported: new Set(), // commits already offered back, so one loss is said once
    add: (/** @type {Finding} */ f) => findings.push(f),
    lost: lostTips(cwd, repo, keep),
  };

  inProgress(cwd, repo, st, ctx.add);
  if (st.lockAge !== null) staleLock(st.lockAge, ctx.add);
  if (!st.branch && st.headSha && !st.operation) detached(ctx, st.headSha);
  deletedBranches(ctx);
  rewound(ctx);
  movedAwayOnHead(ctx, st);
  const objs = lostObjects(cwd, keep);
  droppedStashes(cwd, objs, ctx.add, st);
  lostStaged(cwd, objs, ctx.add);
  upstreamRewritten(cwd, repo, st, ctx.add);

  const order = { problem: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return { state: st, findings };
}

/**
 * Which recent reflog positions (HEAD's and every branch's) have commits no ref keeps: one batch of git calls,
 * not three per entry.
 * @param {string} cwd @param {Repo} repo @param {string[]} keep
 */
function lostTips(cwd, repo, keep) {
  const olds = [];
  for (const ref of ["HEAD", ...branches(cwd).map((b) => `refs/heads/${b}`)]) {
    for (const e of reflog(repo, ref).slice(0, RECENT)) olds.push(e.old, e.new);
  }
  return new Set(unreachableFromRefs(cwd, olds, keep));
}

/**
 * The commits lost from `tip`, less those whose patch is already in `against` (a rebase, an amend of the message).
 * @param {{cwd: string, keep: string[], reported: Set<string>}} ctx @param {string} tip @param {string | null} against
 */
function lostFrom(ctx, tip, against) {
  let lost = unreachableFromRefs(ctx.cwd, [tip], ctx.keep).filter((c) => !ctx.reported.has(c));
  if (lost.length && against) {
    const same = new Set(git(ctx.cwd, ["cherry", against, tip], { allowFail: true }).split("\n")
      .filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()));
    lost = lost.filter((c) => !same.has(c));
  }
  return lost;
}

// ---------------------------------------------------------------- an operation left half done

/** @param {string} cwd @param {Repo} repo @param {ReturnType<typeof state>} st @param {(f: Finding) => void} add */
function inProgress(cwd, repo, st, add) {
  const op = st.operation;
  if (!op) return;
  const files = st.conflicted.length ? `Files with conflicts: ${st.conflicted.join(", ")}.` : "No files are in conflict.";
  const resolveStep = st.conflicted.length
    ? [["edit the files with conflicts, keep what you want, and remove the <<<<<<< ======= >>>>>>> lines"], ["add", "--", ...st.conflicted]]
    : [];
  // git cannot snapshot files in conflict; git-rescue copies them (and every changed file) before an abort.
  const copied = "Your edits so far (the files in conflict and any other changed file) are copied to .git/rescue-files/ first: an abort resets them.";
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
        { title: `Abandon it: put ${branch || "the branch"} back as it was before`, risk: "careful", steps: [[cmd, "--abort"]], note: copied },
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
        { title: "Abandon the merge: back to before it started", risk: "careful", steps: [["merge", "--abort"]], note: copied },
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
        { title: `Abandon the ${op}`, risk: "careful", steps: [[op, "--abort"]], note: copied },
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

/** @typedef {{cwd: string, repo: Repo, keep: string[], reported: Set<string>, add: (f: Finding) => void, lost: Set<string>}} Ctx */

/** @param {Ctx} ctx @param {string} headSha */
function detached(ctx, headSha) {
  const orphan = ctx.lost.has(headSha) || unreachableFromRefs(ctx.cwd, [headSha], ctx.keep).length ? lostFrom(ctx, headSha, null) : [];
  if (orphan.length) {
    orphan.forEach((c) => ctx.reported.add(c));
    const name = rescueName("detached", headSha);
    ctx.add({
      id: "detached-with-commits",
      level: "problem",
      title: `HEAD is detached, with ${orphan.length} commit${orphan.length > 1 ? "s" : ""} on no branch`,
      detail: `Switching to a branch now would leave ${plural(orphan.length, "commit")} behind (findable only through the reflog, and gone when it expires).`,
      commits: orphan,
      options: [{ title: `Put them on a new branch "${name}" and switch to it`, risk: "safe", steps: [["branch", name, headSha], ["checkout", name]] }],
    });
  } else {
    const on = git(ctx.cwd, ["branch", "--contains", headSha, "--format=%(refname:short)"], { allowFail: true }).split("\n").filter(Boolean);
    ctx.add({
      id: "detached",
      level: "info",
      title: `HEAD is detached at ${short(headSha)}`,
      detail: on.length ? `This commit is on ${on.slice(0, 3).join(", ")}${on.length > 3 ? " ..." : ""}. Nothing is at risk.` : "Nothing is at risk.",
      options: on.length ? [{ title: `Go back to ${on[0]}`, risk: "safe", steps: [["checkout", on[0]]] }] : [],
    });
  }
}

/**
 * Branches deleted with commits no other branch has: "checkout: moving from feature to main" in HEAD's
 * reflog, and no feature branch now.
 * @param {Ctx} ctx
 */
function deletedBranches(ctx) {
  const now = new Set(branches(ctx.cwd));
  const seen = new Set();
  for (const e of reflog(ctx.repo, "HEAD").slice(0, RECENT * 2)) {
    const m = e.message.match(/^checkout: moving from (\S+) to /);
    if (!m || /^[0-9a-f]{40}$/.test(m[1]) || now.has(m[1]) || seen.has(m[1])) continue;
    seen.add(m[1]);
    const tip = e.old; // where HEAD was when it left the branch: its last commit then
    if (!ctx.lost.has(tip) && !unreachableFromRefs(ctx.cwd, [tip], ctx.keep).length) continue;
    const lost = lostFrom(ctx, tip, ctx.repo.bare ? null : resolve(ctx.cwd, "HEAD"));
    if (!lost.length) continue;
    lost.forEach((c) => ctx.reported.add(c));
    ctx.add({
      id: "deleted-branch",
      level: "warning",
      title: `Branch "${m[1]}" was deleted with ${plural(lost.length, "commit")} no other branch has`,
      detail: `Its last commit seen was ${short(tip)}, when you left it ${ago(e.time)}. (A branch can also gain commits without being checked out here, from another worktree or a \`branch -f\`; those show in \`git-rescue lost\`.)`,
      commits: lost,
      options: [{ title: `Bring "${m[1]}" back`, risk: "safe", steps: [["branch", m[1], tip]] }],
    });
  }
}

/**
 * A branch moved so that commits fell off it, whatever moved it: a reset, a rebase that dropped a commit, an
 * amend that changed the content, a forced pull, `branch -f`, `checkout -B`.
 * @param {Ctx} ctx
 */
function rewound(ctx) {
  for (const branch of branches(ctx.cwd)) {
    const tipNow = resolve(ctx.cwd, `refs/heads/${branch}`);
    for (const e of reflog(ctx.repo, `refs/heads/${branch}`).slice(0, RECENT)) {
      if (e.old === e.new || /^0+$/.test(e.old) || ctx.reported.has(e.old) || !ctx.lost.has(e.old)) continue;
      // An amend is judged against the commit that replaced it (a message-only amend changed nothing, even if a
      // later amend changed the content); anything else against where the branch is now.
      const lost = lostFrom(ctx, e.old, e.message.startsWith("commit (amend)") ? e.new : tipNow);
      if (!lost.length) continue;
      lost.forEach((c) => ctx.reported.add(c));
      const kind = e.message.startsWith("reset:") ? "reset" : e.message.startsWith("rebase") ? "rebase"
        : e.message.startsWith("commit (amend)") ? "amend" : e.message.startsWith("pull") || e.message.startsWith("merge") ? "pull"
        : e.message.startsWith("branch:") ? "branch" : e.message.startsWith("checkout:") ? "checkout" : "move";
      const what = { reset: `a reset (${e.message.replace(/^reset: /, "")})`, rebase: "a rebase", amend: "`commit --amend`", pull: "a pull",
        branch: "`branch -f`", checkout: "`checkout -B`", move: `"${describe(e.message)}"` }[kind];
      const name = rescueName(`${branch}-before-${kind}`, e.old);
      const amendOnly = kind === "amend" && lost.length === 1;
      ctx.add({
        id: `dropped-by-${kind}`,
        level: amendOnly ? "info" : "warning",
        title: amendOnly
          ? `The commit replaced by \`commit --amend\` on ${branch} ${ago(e.time)} had other changes`
          : `${plural(lost.length, "commit")} fell off ${branch} with ${what} ${ago(e.time)}`,
        detail: amendOnly
          ? "The amended commit differs from it in more than the message; it is here in case the amend lost something."
          : `${branch} was at ${short(e.old)} before; no branch has those commits now.`,
        commits: lost,
        options: [
          { title: `Keep them on a new branch "${name}" (${branch} stays as it is)`, risk: "safe", steps: [["branch", name, e.old]] },
          ...(amendOnly ? [] : [{
            title: `Put ${branch} back where it was (${short(e.old)})`,
            risk: /** @type {const} */ ("careful"),
            steps: [["checkout", branch], ["reset", "--keep", e.old]],
            note: "--keep refuses to run if it would overwrite changes you have not committed; git-rescue backs them up first anyway.",
          }]),
        ],
      });
    }
  }
}

/**
 * Commits HEAD left behind when it was not on a branch: "checkout: moving from <sha> to main", or a reset or
 * rebase made while detached (those are in HEAD's reflog only).
 * @param {Ctx} ctx @param {ReturnType<typeof state>} st
 */
function movedAwayOnHead(ctx, st) {
  // A move made while on a branch is in that branch's reflog too (same ids, time and message): rewound() has
  // judged it. Only the moves made while detached are left here.
  const onBranch = new Set();
  for (const b of branches(ctx.cwd)) for (const e of reflog(ctx.repo, `refs/heads/${b}`).slice(0, RECENT * 2)) onBranch.add(`${e.old} ${e.new} ${e.time}`);
  for (const e of reflog(ctx.repo, "HEAD").slice(0, RECENT)) {
    if (onBranch.has(`${e.old} ${e.new} ${e.time}`)) continue;
    if (e.old === e.new || /^0+$/.test(e.old) || ctx.reported.has(e.old) || !ctx.lost.has(e.old)) continue;
    const lost = lostFrom(ctx, e.old, st.headSha);
    if (!lost.length) continue;
    lost.forEach((c) => ctx.reported.add(c));
    const name = rescueName("detached", e.old);
    const leaving = /^checkout: moving from [0-9a-f]{40} to /.test(e.message);
    ctx.add({
      id: "left-on-detached-head",
      level: "problem",
      title: leaving
        ? `${plural(lost.length, "commit")} left behind on a detached HEAD ${ago(e.time)}`
        : `${plural(lost.length, "commit")} dropped while HEAD was detached (${describe(e.message)}) ${ago(e.time)}`,
      detail: `They were made without a branch, then HEAD moved away. No branch has them.`,
      commits: lost,
      options: [{ title: `Put them on a new branch "${name}"`, risk: "safe", steps: [["branch", name, e.old]] }],
    });
  }
}

// ---------------------------------------------------------------- what no ref and no reflog reaches

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
  const here = git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true }).trim();
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

/** @param {string} a @param {string} b */
const samePath = (a, b) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

/** A stash is a commit "WIP on main: ..." or "On main: ..." with the index as second parent. */
const STASH = /^(WIP on|On) [^:]+:/;

/**
 * Dropped stashes that were not applied: a `stash pop` drops the stash after applying it, and that is no loss.
 * Applied means every file the stash changed is, in that version, in HEAD, the index or the working tree.
 * @param {string} cwd @param {ReturnType<typeof lostObjects>} lost @param {(f: Finding) => void} add @param {ReturnType<typeof state>} st
 */
function droppedStashes(cwd, lost, add, st) {
  const stashes = lost.commits.filter((c) => STASH.test(c.subject) && c.parents.length >= 2);
  for (const s of stashes.slice(0, 10)) {
    if (!st.bare && stashApplied(cwd, s.sha, s.parents[0])) continue;
    add({
      id: "dropped-stash",
      level: "warning",
      title: `A dropped stash: "${s.subject}"${s.time ? ` (${ago(s.time)})` : ""}`,
      detail: "It was removed from the stash list (`stash drop`, `stash clear`) without its changes being in your files or commits, but git still has it.",
      commits: [s.sha],
      options: [{ title: "Put it back on the stash list", risk: "safe", steps: [["stash", "store", "-m", `rescued: ${s.subject}`, s.sha]] }],
    });
  }
}

/** @param {string} cwd @param {string} stash @param {string} base */
function stashApplied(cwd, stash, base) {
  const files = git(cwd, ["diff", "--name-only", "-z", base, stash], { allowFail: true }).split("\0").filter(Boolean).slice(0, 50);
  if (!files.length) return true;
  for (const f of files) {
    const wanted = git(cwd, ["rev-parse", "--verify", "--quiet", `${stash}:${f}`], { allowFail: true }).trim();
    if (!wanted) continue; // the stash deleted it; nothing to look for
    const candidates = [
      git(cwd, ["rev-parse", "--verify", "--quiet", `HEAD:${f}`], { allowFail: true }).trim(),
      git(cwd, ["rev-parse", "--verify", "--quiet", `:${f}`], { allowFail: true }).trim(),
      existsSync(join(git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true }).trim(), f)) ? git(cwd, ["hash-object", "--", f], { allowFail: true }).trim() : "",
    ];
    if (!candidates.includes(wanted)) return false;
  }
  return true;
}

/**
 * Contents staged and never committed. Not those with conflict markers (git writes the marked-up file of a
 * conflicted merge to the object store); and only information, since `git add` of a file you then edited and
 * added again leaves the first version behind too.
 * @param {string} cwd @param {ReturnType<typeof lostObjects>} lost @param {(f: Finding) => void} add
 */
function lostStaged(cwd, lost, add) {
  const contents = readObjects(cwd, lost.stagedBlobs, 256 * 1024);
  const real = lost.stagedBlobs.filter((b) => {
    const text = contents.get(b)?.toString("utf8") ?? "";
    return !(/^<<<<<<< /m.test(text) && /^>>>>>>> /m.test(text));
  });
  if (!real.length) return;
  add({
    id: "lost-staged-files",
    level: "info",
    title: `${plural(real.length, "file version")} that you added (staged) but never committed`,
    detail: "What `git add` saved before a `reset --hard`, `checkout .` or `stash`, or an earlier version of a file you added again. git has no names for them, only the contents.",
    options: [
      { title: "Look at them and save the ones you want", risk: "manual", steps: [["run git-rescue lost to list them"]], note: "`git-rescue find \"some text\"` searches them; `git-rescue restore <id> <file>` saves one." },
    ],
  });
}

// ---------------------------------------------------------------- someone else's force push

/** @param {string} cwd @param {Repo} repo @param {ReturnType<typeof state>} st @param {(f: Finding) => void} add */
function upstreamRewritten(cwd, repo, st, add) {
  if (!st.branch) return;
  const up = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFail: true }).trim();
  if (!up || up.startsWith("@{u}")) return;
  const forced = reflog(repo, `refs/remotes/${up}`).find((e) => /forced-update/.test(e.message) && Date.now() - e.time < 30 * DAY);
  if (!forced) return;
  // Only while the branch still has the old history and the new upstream does not: after a rebase onto the
  // new one, or a reset to it, there is nothing left to do.
  const isAncestor = (/** @type {string} */ a, /** @type {string} */ b) => gitRun(cwd, ["merge-base", "--is-ancestor", a, b]).code === 0;
  if (!isAncestor(forced.old, st.branch) || isAncestor(forced.old, up)) return;
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
      { title: `Keep a copy of ${st.branch} as it is, on a new branch`, risk: "safe", steps: [["branch", rescueName(`${st.branch}-old-history`, resolve(cwd, st.branch) ?? ""), st.branch]] },
    ],
  });
}

// ---------------------------------------------------------------- small helpers

/** A branch name for rescued commits: what, and the commit, so two findings never propose the same name. @param {string} what @param {string} sha */
export function rescueName(what, sha) {
  return `rescued/${what.replace(/[^\w.-]+/g, "-")}-${short(sha)}`;
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

export { refs, gitRun, commitInfo };
