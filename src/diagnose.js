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

import { branches, commitInfo, git, gitOk, gitRun, keepers, objectSizes, objectTime, readObjects, refs, reflog, remember, resolve, samePath, scratchIndex, short, toplevel, unreachableFromRefs, unreachableObjects, worktrees } from "./git.js";
import { describe } from "./timeline.js";

/**
 * @typedef {{title: string, risk: "safe" | "careful" | "manual", steps: string[][], note?: string}} Option
 * @typedef {{id: string, level: "problem" | "warning" | "info", title: string, detail: string, options: Option[], commits?: string[], key?: string}} Finding
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
 * The operation under way, from the files git leaves while it runs: "rebase", "am", "merge", "cherry-pick",
 * "revert", "bisect", or null.
 * @param {string} gitDir
 */
export function operationIn(gitDir) {
  const g = (/** @type {string} */ name) => existsSync(join(gitDir, name));
  if (g("rebase-merge") || g("rebase-apply")) return g("rebase-apply/applying") ? "am" : "rebase";
  if (g("MERGE_HEAD")) return "merge";
  if (g("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (g("REVERT_HEAD")) return "revert";
  if (g("BISECT_LOG")) return "bisect";
  return null;
}

/**
 * The state around the user: where HEAD is, what is under way, what is changed.
 * @param {string} cwd
 * @param {Repo} repo
 */
export function state(cwd, repo) {
  const head = git(cwd, ["symbolic-ref", "--quiet", "HEAD"], { allowFail: true }).trim();
  const headSha = resolve(cwd, "HEAD");
  const operation = operationIn(repo.gitDir);
  const files = repo.bare ? [] : statusEntries(cwd);
  const lock = join(repo.gitDir, "index.lock");
  // A submodule: the repository it is part of (git 2.13+), and the submodules this one has.
  const superproject = repo.bare ? "" : git(cwd, ["rev-parse", "--show-superproject-working-tree"], { allowFail: true }).trim();
  const top = repo.bare ? "" : toplevel(cwd);
  const submodules = top && existsSync(join(top, ".gitmodules"))
    ? git(top, ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"], { allowFail: true }).split("\n").map((l) => l.replace(/^\S+ /, "")).filter(Boolean)
    : [];
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
    superproject: superproject || null,
    submodules,
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
  // While an operation is under way, what it has done so far is on HEAD (a rebase's new commits, on a detached
  // HEAD): that is work in progress, not lost.
  const keep = st.operation && st.headSha ? [...keepers(cwd), st.headSha] : keepers(cwd);
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
  if (!st.branch && st.headSha && !st.operation) detached(ctx, st.headSha, st.superproject);
  deletedBranches(ctx);
  rewound(ctx);
  movedAwayOnHead(ctx, st);
  const objs = lostObjects(cwd, keep);
  droppedStashes(cwd, objs, ctx.add, st);
  unreachableCommits(ctx, objs);
  lostStaged(cwd, repo, objs, ctx.add);
  upstreamRewritten(cwd, repo, st, ctx.add);
  gcRunning(repo, findings, ctx.add);

  const order = { problem: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  // A key that names the finding whatever its number: the kind and its first commit. Numbers change after a fix;
  // `fix KEY/a` from a script either finds the same finding or refuses.
  const seen = new Map();
  for (const f of findings) {
    const base = f.commits?.length ? `${f.id}:${short(f.commits[0])}` : f.id;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    f.key = n === 1 ? base : `${base}-${n}`;
  }
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
 * The commits lost from `tip`, less those whose patch is already in `against` (a rebase, an amend of the message);
 * none when all their changes together are already in a branch (a squash or fixup rebase, a squash merge, a
 * rebase of another branch, a pull request squash-merged on the server).
 * @param {{cwd: string, keep: string[], reported: Set<string>}} ctx @param {string} tip @param {string | null} against
 */
function lostFrom(ctx, tip, against) {
  const all = unreachableFromRefs(ctx.cwd, [tip], ctx.keep);
  let lost = all.filter((c) => !ctx.reported.has(c));
  if (lost.length && against) {
    const same = new Set(git(ctx.cwd, ["cherry", against, tip], { allowFail: true }).split("\n")
      .filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()));
    lost = lost.filter((c) => !same.has(c));
  }
  if (lost.length && contained(ctx.cwd, tip, all)) return [];
  return lost;
}

/**
 * Whether everything the commits `all` (ending at `tip`) changed is already in a branch, a remote-tracking branch
 * or HEAD: their changes, from just before the first of them to `tip`, taken back out of that commit's files
 * (`git apply --cached --check -R`, in an index outside the repository). One patch at a time (`git cherry`) misses
 * a squash; this does not. When the run of commits has more than one starting point (a merge of other lost
 * history), no answer: the commits are judged one by one.
 * @param {string} cwd @param {string} tip @param {string[]} all
 */
function contained(cwd, tip, all) {
  const set = new Set(all);
  const info = commitInfo(cwd, all);
  const bases = new Set();
  for (const c of all) {
    const parents = info.get(c)?.parents ?? [];
    for (const p of parents) if (!set.has(p)) bases.add(p);
    if (!parents.length) bases.add(EMPTY_TREE);
  }
  if (bases.size !== 1) return false;
  const [base] = bases;
  const patch = git(cwd, ["diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv", base, tip], { allowFail: true, raw: true });
  if (!patch.length) return true; // nothing changed in the end
  const tipTree = git(cwd, ["rev-parse", `${tip}^{tree}`], { allowFail: true }).trim();
  for (const t of targets(cwd)) {
    // HEAD is a place the changes may be kept, unless HEAD has these very commits (a detached HEAD with commits
    // is exactly what is being judged then).
    if (t.head && gitOk(cwd, ["merge-base", "--is-ancestor", tip, t.sha])) continue;
    if (t.tree === tipTree) return true;
    const index = scratchIndex(cwd, t.sha);
    if (index && gitOk(cwd, ["apply", "--cached", "--check", "-R", "-"], { input: patch, env: { GIT_INDEX_FILE: index } })) return true;
  }
  return false;
}

/** git's empty tree, the "parent" of a first commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Where lost changes may already be: HEAD, then the most recently changed branches and remote-tracking branches
 * (30 at most), each with its tree.
 * @param {string} cwd @returns {{sha: string, tree: string, head: boolean}[]}
 */
function targets(cwd) {
  return remember(`targets ${cwd}`, () => {
    const out = git(cwd, ["for-each-ref", "--sort=-committerdate", "--count=30", "--format=%(objectname) %(tree)", "refs/heads", "refs/remotes"], { allowFail: true });
    const head = git(cwd, ["log", "-1", "--no-show-signature", "--format=%H %T", "HEAD"], { allowFail: true }).trim();
    /** @type {Map<string, {sha: string, tree: string, head: boolean}>} */
    const m = new Map();
    for (const [i, line] of [head, ...out.split("\n")].entries()) {
      const [sha, tree] = line.trim().split(" ");
      if (/^[0-9a-f]{40}$/.test(sha ?? "") && tree && !m.has(sha)) m.set(sha, { sha, tree, head: i === 0 });
    }
    return [...m.values()];
  });
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
    // A patch that does not apply at all stops `git am` with no file in conflict: there is nothing to resolve,
    // and `am --continue` would only say "No changes". The patch has to be applied by hand first.
    const unapplied = op === "am" && !st.conflicted.length && existsSync(join(repo.gitDir, dir, "patch"));
    const finish = unapplied
      ? [[`apply the patch by hand: git apply --reject ${dir === "rebase-apply" ? ".git/rebase-apply/patch" : "the patch"} applies what fits and leaves .rej files for the rest; edit those parts in`], ["add", "--all"], ["am", "--continue"]]
      : [...resolveStep, [cmd, "--continue"]];
    add({
      id: `${op}-in-progress`,
      level: "problem",
      title: op === "am" ? "A `git am` (applying patches) stopped halfway" : `A rebase${branch ? ` of ${branch}` : ""} stopped halfway${done && total ? ` (at commit ${done} of ${total})` : ""}`,
      detail: unapplied
        ? `The patch "${read("final-commit") || read("msg").split("\n")[0] || "being applied"}" does not apply to these files (git am does not merge). Until it is finished or abandoned, the branch is not where you think it is.`
        : `${files} Until it is finished or abandoned, the branch is not where you think it is.`,
      options: [
        { title: `Abandon it: put ${branch || "the branch"} back as it was before`, risk: "careful", steps: [[cmd, "--abort"]], note: copied },
        { title: unapplied ? "Finish it: apply the patch by hand, then go on" : "Finish it: resolve the conflicts, then go on", risk: "manual", steps: finish },
        op === "am"
          ? { title: "Leave this patch out and go on with the rest", risk: "careful", steps: [[cmd, "--skip"]], note: "The patch is not applied; the file it came from still has it." }
          : { title: "Leave this commit out and go on with the rest", risk: "careful", steps: [[cmd, "--skip"]], note: "The commit's changes are dropped from the result (it stays findable with `git-rescue timeline`)." },
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

/** @param {Ctx} ctx @param {string} headSha @param {string | null} superproject */
function detached(ctx, headSha, superproject) {
  const orphan = ctx.lost.has(headSha) || unreachableFromRefs(ctx.cwd, [headSha], ctx.keep).length ? lostFrom(ctx, headSha, null) : [];
  if (orphan.length) {
    orphan.forEach((c) => ctx.reported.add(c));
    const name = rescueName("detached", headSha);
    ctx.add({
      id: "detached-with-commits",
      level: "problem",
      title: `HEAD is detached, with ${orphan.length} commit${orphan.length > 1 ? "s" : ""} on no branch`,
      detail: `Switching to a branch now would leave ${orphan.length > 1 ? "them" : "it"} behind (findable only through the reflog, and gone when it expires):\n${listCommits(ctx.cwd, orphan)}`,
      commits: orphan,
      options: [{ title: `Put them on a new branch "${name}" and switch to it`, risk: "safe", steps: [["branch", name, headSha], ["checkout", name]] }],
    });
  } else if (superproject && recordedInSuperproject(ctx.cwd, superproject) === headSha) {
    // git keeps a submodule's HEAD detached at the commit its parent repository records: that is how it is meant to be.
    ctx.add({
      id: "detached",
      level: "info",
      title: `HEAD is detached at ${short(headSha)}, the commit ${superproject.replace(/^.*[\\/]/, "")} records for this submodule`,
      detail: "That is how git leaves a submodule after `git submodule update`. Nothing is at risk; to work on it, switch to a branch first.",
      options: [],
    });
  } else {
    // for-each-ref, not `branch --contains`: git 2.19 lists "(HEAD detached at ...)" there as if it were a branch.
    const on = git(ctx.cwd, ["for-each-ref", "--contains", headSha, "--format=%(refname:short)", "refs/heads"], { allowFail: true }).split("\n").filter(Boolean);
    ctx.add({
      id: "detached",
      level: "info",
      title: `HEAD is detached at ${short(headSha)}`,
      detail: on.length ? `This commit is on ${on.slice(0, 3).join(", ")}${on.length > 3 ? " ..." : ""}. Nothing is at risk.` : "Nothing is at risk.",
      options: on.length ? [{ title: `Go back to ${on[0]}`, risk: "safe", steps: [["checkout", on[0]]] }] : [],
    });
  }
}

/** The commit the parent repository records for this submodule. @param {string} cwd @param {string} superproject */
function recordedInSuperproject(cwd, superproject) {
  const path = toplevel(cwd).slice(superproject.length).replace(/^[\\/]+/, "");
  const line = git(superproject, ["ls-tree", "HEAD", "--", path], { allowFail: true }).trim();
  return line.match(/^160000 commit ([0-9a-f]{40})\t/)?.[1] ?? null;
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
      detail: `Its last commit seen was ${short(tip)}, when you left it ${ago(e.time)}:\n${listCommits(ctx.cwd, lost)}\n(Commits it got from another worktree or a \`branch -f\` are not in this list; \`git-rescue lost\` shows them.)`,
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
  const here = toplevel(ctx.cwd);
  /** @type {Map<string, string>} */
  const elsewhere = new Map(worktrees(ctx.cwd).filter((w) => w.branch && !samePath(w.path, here)).map((w) => [/** @type {string} */ (w.branch), w.path]));
  for (const branch of branches(ctx.cwd)) {
    const tipNow = resolve(ctx.cwd, `refs/heads/${branch}`);
    for (const e of reflog(ctx.repo, `refs/heads/${branch}`).slice(0, RECENT)) {
      if (e.old === e.new || /^0+$/.test(e.old) || ctx.reported.has(e.old) || !ctx.lost.has(e.old) || forward(ctx, e)) continue;
      // An amend is judged against the commit that replaced it (a message-only amend changed nothing, even if a
      // later amend changed the content); anything else against where the branch is now.
      const lost = lostFrom(ctx, e.old, e.message.startsWith("commit (amend)") ? e.new : tipNow);
      if (!lost.length) continue;
      lost.forEach((c) => ctx.reported.add(c));
      const kind = e.message.startsWith("reset:") ? "reset" : e.message.startsWith("rebase") ? "rebase"
        : e.message.startsWith("commit (amend)") ? "amend" : e.message.startsWith("pull") || e.message.startsWith("merge") ? "pull"
        : e.message.startsWith("branch:") ? "branch" : e.message.startsWith("checkout:") ? "checkout" : "move";
      const what = { reset: `a reset (${e.message.replace(/^reset: /, "")})`, rebase: "a rebase", amend: "`commit --amend`", pull: "a pull",
        branch: "`branch -f` or `checkout -B`", checkout: "`checkout -B`", move: `"${describe(e.message)}"` }[kind];
      const name = rescueName(`${branch}-before-${kind}`, e.old);
      const amendOnly = kind === "amend" && lost.length === 1;
      ctx.add({
        id: `dropped-by-${kind}`,
        level: amendOnly ? "info" : "warning",
        title: amendOnly
          ? `The commit replaced by \`commit --amend\` on ${branch} ${ago(e.time)} had other changes`
          : `${plural(lost.length, "commit")} fell off ${branch} with ${what} ${ago(e.time)}`,
        detail: amendOnly
          ? `The amended commit differs from it in more than the message; it is here in case the amend lost something:\n${listCommits(ctx.cwd, lost)}`
          : `${branch} was at ${short(e.old)} before; no branch has ${lost.length > 1 ? "these commits" : "this commit"} now:\n${listCommits(ctx.cwd, lost)}`,
        commits: lost,
        options: [
          { title: `Keep them on a new branch "${name}" (${branch} stays as it is)`, risk: "safe", steps: [["branch", name, e.old]],
            ...(elsewhere.has(branch) ? { note: `${branch} is checked out in ${elsewhere.get(branch)}; to put it back there instead: git reset --keep ${e.old}` } : {}) },
          ...(amendOnly || elsewhere.has(branch) ? [] : [{
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
  // The steps inside a rebase (pick, squash, fixup ... finish) replace commits on the way: a squash folds in the
  // pick before it, a fixup rewrites the original. A rebase is judged whole: from where it started (the "start"
  // entry, kept here) to where the branch ended (its own reflog, in rewound()).
  const REBASE_STEP = /^(?:pull --rebase|rebase(?: -i| -m)?) \((?!start)\w+\)|^rebase(?: finished)?: /;
  for (const e of reflog(ctx.repo, "HEAD").slice(0, RECENT)) {
    if (onBranch.has(`${e.old} ${e.new} ${e.time}`) || REBASE_STEP.test(e.message)) continue;
    if (e.old === e.new || /^0+$/.test(e.old) || ctx.reported.has(e.old) || !ctx.lost.has(e.old) || forward(ctx, e)) continue;
    const lost = lostFrom(ctx, e.old, st.headSha);
    if (!lost.length) continue;
    lost.forEach((c) => ctx.reported.add(c));
    const from = e.message.match(/^checkout: moving from (\S+) to /)?.[1];
    if (from && !/^[0-9a-f]{40}$/.test(from)) {
      // HEAD left a branch that was deleted or moved since (a branch of that name may exist again, without them).
      const again = branches(ctx.cwd).includes(from);
      const rescue = rescueName(`${from}-before`, e.old);
      ctx.add({
        id: "left-behind-on-branch",
        level: "warning",
        title: `${plural(lost.length, "commit")} that were on "${from}" when you left it ${ago(e.time)} are on no branch now`,
        detail: `"${from}" was deleted or moved since${again ? ` (a branch called "${from}" exists again, without them)` : ""}:\n${listCommits(ctx.cwd, lost)}`,
        commits: lost,
        options: [{ title: `Keep them on a new branch "${rescue}"`, risk: "safe", steps: [["branch", rescue, e.old]] }],
      });
      continue;
    }
    const name = rescueName("detached", e.old);
    const leaving = /^checkout: moving from [0-9a-f]{40} to /.test(e.message);
    ctx.add({
      id: "left-on-detached-head",
      level: "problem",
      title: leaving
        ? `${plural(lost.length, "commit")} left behind on a detached HEAD ${ago(e.time)}`
        : `${plural(lost.length, "commit")} dropped while HEAD was detached (${describe(e.message)}) ${ago(e.time)}`,
      detail: `They were made without a branch, then HEAD moved away. No branch has them:\n${listCommits(ctx.cwd, lost)}`,
      commits: lost,
      options: [{ title: `Put them on a new branch "${name}"`, risk: "safe", steps: [["branch", name, e.old]] }],
    });
  }
}

/**
 * A move that only went forward (a commit, a fast-forward): what was there before is still under the new
 * position, so the move dropped nothing; if the new position is lost, a later move says so.
 * @param {Ctx} ctx @param {{old: string, new: string}} e
 */
function forward(ctx, e) {
  return gitOk(ctx.cwd, ["merge-base", "--is-ancestor", e.old, e.new]);
}

// ---------------------------------------------------------------- what no ref and no reflog reaches

/**
 * Commits nothing reaches, not even a reflog: the reflog entries expired, or the repository keeps no reflog (a
 * bare repository on a server does not, so a force push leaves the old commits like this). Stashes are judged by
 * droppedStashes; commits whose changes are already on HEAD (an old rebase) are left out. One option per line of
 * history, for the newest three.
 * @param {Ctx} ctx @param {ReturnType<typeof lostObjects>} objs
 */
function unreachableCommits(ctx, objs) {
  const stashLike = new Set(objs.commits.filter((c) => STASH.test(c.subject)).flatMap((c) => [c.sha, ...c.parents]));
  const candidates = hideStashParts(objs.commits).filter((c) => !stashLike.has(c.sha) && !ctx.reported.has(c.sha));
  if (!candidates.length) return;
  const parents = new Set(candidates.flatMap((c) => c.parents));
  const head = resolve(ctx.cwd, "HEAD"); // and, in lostFrom, every recent branch and remote-tracking branch
  /** @type {{tip: typeof candidates[number], lost: string[]}[]} */
  const lines = [];
  for (const tip of candidates.filter((c) => !parents.has(c.sha))) { // newest first already
    const lost = lostFrom(ctx, tip.sha, head);
    if (!lost.length) continue;
    lost.forEach((c) => ctx.reported.add(c));
    lines.push({ tip, lost });
  }
  if (!lines.length) return;
  const all = lines.flatMap((l) => l.lost);
  const recent = lines.some((l) => Date.now() - l.tip.time < 30 * DAY);
  ctx.add({
    id: "unreachable-commits",
    level: recent ? "warning" : "info",
    title: `${plural(all.length, "commit")} that nothing points to, not even the reflog`,
    detail: `No branch, tag or reflog entry has ${all.length > 1 ? "them" : "it"}: the reflog entries expired, a remote branch ` +
      "was removed by `fetch --prune`, or this repository keeps no reflog (a bare repository on a server does not, so a " +
      "force push leaves the old commits like this). " +
      `\`git gc\` deletes them once they are about two weeks old:\n${listCommits(ctx.cwd, all)}`,
    commits: all,
    options: lines.slice(0, 3).map(({ tip, lost }) => {
      const name = rescueName("lost", tip.sha);
      return { title: `Keep "${tip.subject.slice(0, 60)}"${lost.length > 1 ? ` and the ${plural(lost.length - 1, "commit")} before it` : ""} on a new branch "${name}"`, risk: /** @type {const} */ ("safe"), steps: [["branch", name, tip.sha]] };
    }),
  });
}

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
 * `git gc` running now (or stopped in the middle): it deletes the objects nothing points to once they are two
 * weeks old, which is what git-rescue finds. git treats a gc.pid older than 12 hours as left over.
 * @param {Repo} repo @param {Finding[]} findings @param {(f: Finding) => void} add
 */
function gcRunning(repo, findings, add) {
  const pid = join(repo.commonDir, "gc.pid");
  if (!existsSync(pid) || Date.now() - statSync(pid).mtimeMs > 12 * 3600 * 1000) return;
  const atStake = findings.some((f) => f.commits?.length || f.id === "lost-staged-files");
  add({
    id: "gc-running",
    level: atStake ? "warning" : "info",
    title: "`git gc` is running, or was stopped in the middle",
    detail: `It deletes what nothing points to once it is about two weeks old${atStake ? ", which may include what is listed here" : ""}. ` +
      "Let it finish and run git-rescue again before saving anything. If no git program is running, .git/gc.pid is left over and harmless.",
    options: [],
  });
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
const STASH = /^(WIP on|On) [^:]+:/;

/**
 * Dropped stashes that were not applied: a `stash pop` drops the stash after applying it, and that is no loss.
 * Applied means every file the stash changed is, in that version, in HEAD, the index or the working tree.
 * @param {string} cwd @param {ReturnType<typeof lostObjects>} lost @param {(f: Finding) => void} add @param {ReturnType<typeof state>} st
 */
function droppedStashes(cwd, lost, add, st) {
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
function lostStaged(cwd, repo, lost, add) {
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

// ---------------------------------------------------------------- someone else's force push

/** @param {string} cwd @param {Repo} repo @param {ReturnType<typeof state>} st @param {(f: Finding) => void} add */
function upstreamRewritten(cwd, repo, st, add) {
  if (!st.branch) return;
  const up = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFail: true }).trim();
  if (!up || up.startsWith("@{u}")) return;
  // Every forced update of the last 30 days, newest first: the one that matters is the one whose old history the
  // branch still has and the new upstream does not (after a rebase onto the new one, or a reset to it, none).
  // Rewritten twice, the newest one's "old" is the first rewrite, which the branch never had.
  const isAncestor = (/** @type {string} */ a, /** @type {string} */ b) => gitOk(cwd, ["merge-base", "--is-ancestor", a, b]);
  const branch = /** @type {string} */ (st.branch);
  const forced = reflog(repo, `refs/remotes/${up}`)
    .filter((e) => /forced-update/.test(e.message) && Date.now() - e.time < 30 * DAY)
    .find((e) => isAncestor(e.old, branch) && !isAncestor(e.old, up));
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
      { title: `Keep a copy of ${st.branch} as it is, on a new branch`, risk: "safe", steps: [["branch", rescueName(`${st.branch}-old-history`, resolve(cwd, st.branch) ?? ""), st.branch]] },
    ],
  });
}

// ---------------------------------------------------------------- small helpers

/** A branch name for rescued commits: what, and the commit, so two findings never propose the same name. @param {string} what @param {string} sha */
export function rescueName(what, sha) {
  return `rescued/${what.replace(/[^\w.-]+/g, "-")}-${short(sha)}`;
}

/**
 * The commits, one per line with id and subject (the newest 5, then how many more), for a finding's detail.
 * @param {string} cwd @param {string[]} shas
 */
function listCommits(cwd, shas) {
  const info = commitInfo(cwd, shas.slice(0, 5));
  const lines = shas.slice(0, 5).map((s) => `  ${short(s)}  ${info.get(s)?.subject ?? ""}`);
  if (shas.length > 5) lines.push(`  ... and ${shas.length - 5} more`);
  return lines.join("\n");
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
