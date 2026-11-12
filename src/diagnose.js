// @ts-check
/**
 * What is wrong with this repository, and the ways back: every finding, most serious first.
 *
 * Only the repository's state is read: files git leaves while an operation is under way (MERGE_HEAD,
 * rebase-merge/ ...), the reflogs, and the objects no ref reaches. No guessing from timing ("you committed a
 * minute ago, maybe by mistake"): each finding is something that is the case, with the commits it is about.
 *
 * The findings live by subject in findings/: operations.js (an operation left half done, a stale lock, gc),
 * commits.js (commits that may be lost), stashes.js (dropped stashes, lost staged files), upstream.js.
 */

import { keepers, short } from "./git.js";
import { detached, deletedBranches, lostTips, movedAwayOnHead, rewound, unreachableCommits } from "./findings/commits.js";
import { gcRunning, inProgress, staleLock } from "./findings/operations.js";
import { droppedStashes, lostObjects, lostStaged } from "./findings/stashes.js";
import { upstreamRewritten } from "./findings/upstream.js";
import { state } from "./state.js";

/** @typedef {import("./state.js").Finding} Finding */
/** @typedef {import("./state.js").Option} Option */
/** @typedef {import("./state.js").Repo} Repo */

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

export { REMOVE_LOCK, isInstruction, operationIn, state, statusEntries } from "./state.js";
export { hideStashParts, lostObjects } from "./findings/stashes.js";
export { ago, plural, rescueName } from "./words.js";
