// @ts-check
/**
 * The state around the user, and the shapes every finding shares.
 *
 * Each finding has options: a title, how risky it is, and the exact git commands (as argument lists, shown
 * to the user before anything runs). "safe" changes nothing that cannot be undone with a plain git command;
 * "careful" moves a branch or the working tree (git-rescue backs everything up first); "manual" is a step
 * the user does (resolving a conflict).
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { git, resolve, toplevel } from "./git.js";

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

/** @typedef {ReturnType<typeof state>} State */
