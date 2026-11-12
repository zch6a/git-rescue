// @ts-check
/** Small helpers for the words of a finding: names, lists, counts, times. */

import { commitInfo, short } from "./git.js";

export const DAY = 24 * 3600 * 1000;

/** A branch name for rescued commits: what, and the commit, so two findings never propose the same name. @param {string} what @param {string} sha */
export function rescueName(what, sha) {
  return `rescued/${what.replace(/[^\w.-]+/g, "-")}-${short(sha)}`;
}

/**
 * The commits, one per line with id and subject (the newest 5, then how many more), for a finding's detail.
 * @param {string} cwd @param {string[]} shas
 */
export function listCommits(cwd, shas) {
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
