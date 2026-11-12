// @ts-check
/**
 * Commits that may be lost: on a detached HEAD, on a deleted branch, fallen off a branch, left behind by HEAD,
 * or reached by nothing at all.
 *
 * A commit counts as lost when no ref keeps it (branches, tags, remotes, notes, every stash on the list, the
 * HEADs of other worktrees) and its changes are not already kept in another form: a rebase, squash or amend
 * that kept the changes is what the user meant, not a loss. First patch by patch (`git cherry`), then the
 * commits' changes taken together against every recent branch (`contained`).
 */

import { branches, commitInfo, git, gitOk, reflog, remember, resolve, samePath, scratchIndex, short, toplevel, unreachableFromRefs, worktrees } from "../git.js";
import { describe } from "../timeline.js";
import { DAY, ago, listCommits, plural, rescueName } from "../words.js";
import { STASH, hideStashParts, lostObjects } from "./stashes.js";

/**
 * @typedef {import("../state.js").Finding} Finding
 * @typedef {import("../state.js").Option} Option
 * @typedef {import("../state.js").Repo} Repo
 * @typedef {import("../state.js").State} State
 */

const RECENT = 100; // reflog entries looked at, per reflog

/**
 * Which recent reflog positions (HEAD's and every branch's) have commits no ref keeps: one batch of git calls,
 * not three per entry.
 * @param {string} cwd @param {Repo} repo @param {string[]} keep
 */
export function lostTips(cwd, repo, keep) {
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

/** @typedef {{cwd: string, repo: Repo, keep: string[], reported: Set<string>, add: (f: Finding) => void, lost: Set<string>}} Ctx */

/** @param {Ctx} ctx @param {string} headSha @param {string | null} superproject */
export function detached(ctx, headSha, superproject) {
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
export function deletedBranches(ctx) {
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
export function rewound(ctx) {
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
 * @param {Ctx} ctx @param {State} st
 */
export function movedAwayOnHead(ctx, st) {
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

/**
 * Commits nothing reaches, not even a reflog: the reflog entries expired, or the repository keeps no reflog (a
 * bare repository on a server does not, so a force push leaves the old commits like this). Stashes are judged by
 * droppedStashes; commits whose changes are already on HEAD (an old rebase) are left out. One option per line of
 * history, for the newest three.
 * @param {Ctx} ctx @param {ReturnType<typeof lostObjects>} objs
 */
export function unreachableCommits(ctx, objs) {
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
