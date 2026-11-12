// @ts-check
/** An upstream someone force-pushed while your branch still has the old history. */

import { git, gitOk, reflog, resolve } from "../git.js";
import { DAY, ago, plural, rescueName } from "../words.js";

/**
 * @typedef {import("../state.js").Finding} Finding
 * @typedef {import("../state.js").Option} Option
 * @typedef {import("../state.js").Repo} Repo
 * @typedef {import("../state.js").State} State
 */

/** @param {string} cwd @param {Repo} repo @param {State} st @param {(f: Finding) => void} add */
export function upstreamRewritten(cwd, repo, st, add) {
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
