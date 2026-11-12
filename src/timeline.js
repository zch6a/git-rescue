// @ts-check
/**
 * What happened, in words: HEAD's reflog (every commit, switch, reset, rebase, merge, pull), the stash's, and
 * forced updates of remote-tracking branches, newest first, each with where things were before it.
 */

import { ago } from "./diagnose.js";
import { reflog, reflogNames, short } from "./git.js";

/**
 * @typedef {{time: number, what: string, before: string, after: string, ref: string, raw: string}} Event
 */

/**
 * @param {{gitDir: string, commonDir: string}} repo
 * @param {number} [limit]
 * @returns {Event[]}
 */
export function timeline(repo, limit = 30) {
  /** @type {Event[]} */
  const events = [];
  for (const e of reflog(repo, "HEAD")) events.push({ time: e.time, what: describe(e.message), before: e.old, after: e.new, ref: "HEAD", raw: e.message });
  for (const e of reflog(repo, "refs/stash")) events.push({ time: e.time, what: `stashed: ${e.message.replace(/^(WIP on|On) /, "")}`, before: e.old, after: e.new, ref: "stash", raw: e.message });
  for (const name of reflogNames(repo).filter((n) => n.startsWith("refs/remotes/"))) {
    for (const e of reflog(repo, name)) {
      if (/forced-update/.test(e.message)) {
        events.push({ time: e.time, what: `${name.slice("refs/remotes/".length)} was force-pushed by someone (you fetched the rewritten history)`, before: e.old, after: e.new, ref: name, raw: e.message });
      }
    }
  }
  return events.sort((a, b) => b.time - a.time).slice(0, limit);
}

/** A reflog message in plain words. @param {string} m */
export function describe(m) {
  let r;
  if ((r = m.match(/^commit \(initial\): (.*)/))) return `first commit: "${r[1]}"`;
  if ((r = m.match(/^commit \(amend\): (.*)/))) return `amended the last commit: "${r[1]}"`;
  if ((r = m.match(/^commit \(merge\): (.*)/))) return `committed a merge: "${r[1]}"`;
  if ((r = m.match(/^commit: (.*)/))) return `committed "${r[1]}"`;
  if ((r = m.match(/^checkout: moving from (\S+) to (\S+)/))) return `switched from ${name(r[1])} to ${name(r[2])}`;
  if ((r = m.match(/^reset: moving to (.*)/))) return `reset to ${name(r[1])}`;
  if ((r = m.match(/^rebase(?: -i)? \((start|finish|abort|pick|squash|fixup|reword|edit|continue)\): ?(.*)/))) {
    /** @type {Record<string, string>} */
    const steps = { start: "started a rebase", finish: "finished a rebase", abort: "abandoned a rebase", pick: "rebase: replayed", squash: "rebase: squashed", fixup: "rebase: fixed up", reword: "rebase: reworded", edit: "rebase: stopped to edit", continue: "rebase: continued" };
    const step = steps[r[1]] ?? `rebase (${r[1]})`;
    return r[2] ? `${step} ${r[2].replace(/^returning to refs\/heads\//, "back on ")}` : step;
  }
  if ((r = m.match(/^merge (\S+): (.*)/))) return `merged ${r[1]} (${r[2]})`;
  if ((r = m.match(/^pull(?: --rebase)?: (.*)/))) return `pulled (${r[1]})`;
  if ((r = m.match(/^cherry-pick: (.*)/))) return `cherry-picked "${r[1]}"`;
  if ((r = m.match(/^revert: (.*)/))) return `reverted: "${r[1]}"`;
  if ((r = m.match(/^branch: (.*)/))) return `branch: ${r[1]}`;
  return m;
}

/** @param {string} ref */
function name(ref) {
  return /^[0-9a-f]{40}$/.test(ref) ? `${short(ref)} (no branch)` : ref;
}

/** @param {Event} e */
export function line(e) {
  return `${ago(e.time).padEnd(16)} ${e.what}${e.before !== e.after && !/^0+$/.test(e.before) ? `   [before: ${short(e.before)}]` : ""}`;
}
