// @ts-check
/**
 * git-rescue: what just happened to my repository, and how do I get my work back?
 *
 *   git-rescue                 what is wrong here, and the ways back (asks before doing anything)
 *   git-rescue timeline        what happened, in words
 *   git-rescue lost            everything git can still give back
 *   git-rescue find "text"     search lost work for some text
 *   git-rescue restore ID FILE save a lost file (or commit) to a new file
 *   git-rescue undo            undo what git-rescue last did
 */

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { backup, backups, undoSteps } from "./backup.js";
import { REMOVE_LOCK, ago, diagnose, isInstruction } from "./diagnose.js";
import { GitError, gitRun, repoAt, short, version } from "./git.js";
import { find, inventory, restore } from "./lost.js";
import { line, timeline } from "./timeline.js";

const VERSION = "0.1.0";
const HELP = `git-rescue ${VERSION}: what just happened to my repository, and how do I get my work back?

  git-rescue                  what is wrong here, and the ways back (asks before doing anything)
  git-rescue timeline [-n N]  what happened recently, in words
  git-rescue lost             everything git can still give back: commits no branch has, dropped
                              stashes, files you staged and never committed
  git-rescue find TEXT [-i]   search lost work for TEXT (-i: ignore case)
  git-rescue restore ID FILE  save a lost file (or a lost commit's diff) to a new FILE
  git-rescue undo [--list]    undo what git-rescue last did (or list its backups)

Options: -C PATH (the repository; default: here), --dry-run (show, change nothing), --json, --yes
(do not ask; only with fix), fix N[a] (apply option a of problem N without the menu).

It changes nothing without asking. Before any change it saves every branch, HEAD and your uncommitted
changes under refs/rescue/, so that \`git-rescue undo\` can put them back.`;

const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (/** @type {string} */ code, /** @type {string} */ s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const LEVEL = { problem: c("1;31", "✗"), warning: c("1;33", "!"), info: c("2", "·") };
const RISK = { safe: c("32", "safe"), careful: c("33", "careful"), manual: c("36", "you do it") };

/** How a step is shown. @param {string[]} step */
function shown(step) {
  if (step[0] === REMOVE_LOCK) return "delete .git/index.lock";
  if (isInstruction(step)) return `(${step[0]})`;
  return "git " + step.map((a) => (/^[\w@./:=^~-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`)).join(" ");
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} 0 nothing wrong (or done), 1 problems found, 2 could not run
 */
export async function main(argv) {
  const args = [...argv];
  const flag = (/** @type {string} */ f) => {
    const i = args.indexOf(f);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  };
  const value = (/** @type {string} */ f) => {
    const i = args.indexOf(f);
    if (i < 0) return null;
    const v = args[i + 1];
    args.splice(i, 2);
    return v ?? null;
  };
  if (flag("--help") || flag("-h")) return say(HELP), 0;
  if (flag("--version")) return say(`git-rescue ${VERSION}`), 0;
  const cwd = value("-C") ?? process.cwd();
  const json = flag("--json");
  const dry = flag("--dry-run");
  const yes = flag("--yes");
  const ignoreCase = flag("-i");
  const limit = Number(value("-n") ?? 30);
  const [cmd = "", ...rest] = args;

  try {
    const repo = repoAt(cwd);
    if (!repo) return err(`${cwd} is not inside a git repository`), 2;
    const [major, minor] = version(cwd);
    if (major < 2 || (major === 2 && minor < 17)) say(c("33", `(git ${major}.${minor} is old; git-rescue is tested with 2.17 and later)`));

    if (cmd === "timeline") {
      const events = timeline(repo, limit);
      if (json) return say(JSON.stringify(events, null, 2)), 0;
      if (!events.length) return say("Nothing in the reflog yet."), 0;
      say(`What happened in ${repo.top} (newest first):\n`);
      for (const e of events) say("  " + line(e));
      say(`\nEach [before: ...] is where things were before that step; \`git branch rescued/name <id>\` keeps it.`);
      return 0;
    }
    if (cmd === "lost") return lostCommand(cwd, repo, json);
    if (cmd === "find") {
      const text = rest.join(" ");
      if (!text) return err("find what? git-rescue find \"some text\""), 2;
      const matches = find(cwd, repo, text, { ignoreCase });
      if (json) return say(JSON.stringify(matches, null, 2)), 0;
      if (!matches.length) return say(`"${text}" is not in any lost work git still has.`), 1;
      say(`"${text}" in lost work:\n`);
      for (const m of matches) say(`  ${c("1", short(m.sha))}  ${m.where}${m.line ? `, line ${m.line}` : ""}\n      ${m.text}`);
      say(`\nSave one with: git-rescue restore <id> <new-file-name>`);
      return 0;
    }
    if (cmd === "restore") {
      const [id, file] = rest;
      if (!id || !file) return err("git-rescue restore ID FILE (the ID from git-rescue lost or find)"), 2;
      if (dry) return say(`would write the contents of ${id} to ${file}`), 0;
      const r = restore(cwd, id, file);
      say(`Saved ${r.type === "blob" ? "the file" : "the commit and its diff"} (${r.bytes} bytes) to ${file}.`);
      return 0;
    }
    if (cmd === "undo") return await undoCommand(cwd, repo, { list: flag("--list"), dry, yes });
    if (cmd === "fix") return await fixCommand(cwd, repo, rest[0] ?? "", { dry, yes });
    if (cmd) return err(`unknown command "${cmd}" (see git-rescue --help)`), 2;
    return await checkCommand(cwd, repo, { json, dry });
  } catch (e) {
    if (e instanceof GitError) return err(`git ${e.args.join(" ")}: ${e.message}`), 2;
    if (e instanceof Error) return err(e.message), 2;
    throw e;
  }
}

/** @param {string} cwd @param {{top: string, gitDir: string, commonDir: string}} repo @param {{json: boolean, dry: boolean}} o */
async function checkCommand(cwd, repo, o) {
  const { state, findings } = diagnose(cwd, repo);
  if (o.json) return say(JSON.stringify({ state, findings }, null, 2)), findings.some((f) => f.level !== "info") ? 1 : 0;
  const where = state.unborn ? "no commits yet" : state.branch ? `on ${state.branch}` : `HEAD detached at ${short(state.headSha ?? "")}`;
  const changes = state.changed || state.untracked ? `, ${state.changed} changed and ${state.untracked} untracked files` : ", nothing uncommitted";
  say(`${repo.top}: ${where}${changes}\n`);
  if (!findings.length) {
    say("Nothing looks wrong. (`git-rescue timeline` shows what happened; `git-rescue lost` what git can still give back.)");
    return 0;
  }
  findings.forEach((f, i) => {
    say(`${LEVEL[f.level]} ${c("1", `${i + 1}.`)} ${f.title}`);
    if (f.detail) say(`     ${f.detail}`);
    f.options.forEach((opt, k) => {
      say(`     ${String.fromCharCode(97 + k)}) ${opt.title}  [${RISK[opt.risk]}]`);
      for (const s of opt.steps) say(`          ${shown(s)}`);
      if (opt.note) say(`          ${c("2", opt.note)}`);
    });
    say("");
  });
  const fixable = findings.some((f) => f.options.length);
  if (!fixable || o.dry || !process.stdin.isTTY) {
    if (fixable) say("To apply one: git-rescue fix N[a]  (for example fix 1a); nothing has been changed.");
    return findings.some((f) => f.level !== "info") ? 1 : 0;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Fix one? Type its number and letter (like 1a), or press Enter to leave everything as it is: ")).trim();
    if (!answer) return say("Nothing changed."), 1;
    return await apply(cwd, repo, findings, answer, { dry: false, yes: false, rl });
  } finally {
    rl.close();
  }
}

/** @param {string} cwd @param {{top: string, gitDir: string, commonDir: string}} repo @param {string} pick @param {{dry: boolean, yes: boolean}} o */
async function fixCommand(cwd, repo, pick, o) {
  if (!pick) return err("fix what? git-rescue fix N[a] (the numbers git-rescue shows)"), 2;
  const { findings } = diagnose(cwd, repo);
  if (o.yes || o.dry || !process.stdin.isTTY) return apply(cwd, repo, findings, pick, { ...o, rl: null });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await apply(cwd, repo, findings, pick, { ...o, rl });
  } finally {
    rl.close();
  }
}

/**
 * Shows the steps, asks, backs up, runs them; stops at the first that fails or that the user has to do.
 * @param {string} cwd
 * @param {{top: string, gitDir: string, commonDir: string}} repo
 * @param {import("./diagnose.js").Finding[]} findings
 * @param {string} pick
 * @param {{dry: boolean, yes: boolean, rl: import("node:readline/promises").Interface | null}} o
 */
async function apply(cwd, repo, findings, pick, o) {
  const m = pick.match(/^(\d+)([a-z]?)$/i);
  const f = m ? findings[Number(m[1]) - 1] : undefined;
  if (!m || !f) return err(`"${pick}" is not one of the problems listed (1 to ${findings.length})`), 2;
  const opt = f.options[m[2] ? m[2].toLowerCase().charCodeAt(0) - 97 : 0];
  if (!opt) return err(`problem ${m[1]} has options a to ${String.fromCharCode(96 + f.options.length)}`), 2;
  say(`\n${f.title}\n→ ${opt.title}\n`);
  for (const s of opt.steps) say(`   ${shown(s)}`);
  if (o.dry) return say("\n(dry run: nothing changed)"), 0;
  if (!o.yes) {
    if (!o.rl) return err("not run: add --yes to apply without being asked, or run it in a terminal"), 2;
    const ok = (await o.rl.question(`\nA backup of every branch and your uncommitted changes is made first. Go ahead? [y/N] `)).trim().toLowerCase();
    if (ok !== "y" && ok !== "yes") return say("Nothing changed."), 1;
  }
  const b = backup(cwd, repo, opt.title);
  say(c("2", `   (backup: refs/rescue/${b.stamp}; \`git-rescue undo\` puts things back)`));
  const uncommitted = gitRun(cwd, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim();
  if (!b.worktree && uncommitted) say(c("33", "   (your uncommitted changes could not be backed up: git cannot while files are in conflict)"));
  return runSteps(cwd, repo, opt.steps);
}

/** @param {string} cwd @param {{gitDir: string}} repo @param {string[][]} steps */
function runSteps(cwd, repo, steps) {
  for (const s of steps) {
    if (isInstruction(s)) {
      say(`\nNow it is your turn: ${s[0]}. Then run the remaining steps:`);
      for (const r of steps.slice(steps.indexOf(s) + 1)) say(`   ${shown(r)}`);
      return 0;
    }
    if (s[0] === REMOVE_LOCK) {
      unlinkSync(join(repo.gitDir, "index.lock"));
      say(`   ✓ ${shown(s)}`);
      continue;
    }
    const r = gitRun(cwd, s);
    if (r.code !== 0) {
      say(`   ✗ ${shown(s)}\n${(r.stderr || r.stdout).trim().replace(/^/gm, "     ")}`);
      say(`\nStopped there. Nothing after it was run; \`git-rescue undo\` puts things back as they were.`);
      return 1;
    }
    say(`   ✓ ${shown(s)}`);
  }
  say("\nDone. `git-rescue undo` puts things back as they were before.");
  return 0;
}

/** @param {string} cwd @param {{top: string, gitDir: string, commonDir: string}} repo @param {boolean} json */
function lostCommand(cwd, repo, json) {
  const inv = inventory(cwd, repo);
  if (json) return say(JSON.stringify(inv, null, 2)), 0;
  const total = inv.reflogOnly.length + inv.unreachable.length + inv.staged.length;
  if (!total) return say("Nothing lost: every commit is on a branch, a tag or the stash, and nothing staged went missing."), 0;
  if (inv.reflogOnly.length) {
    say(`Commits no branch has, that the reflog still remembers (${inv.reflogOnly.length}):`);
    for (const k of inv.reflogOnly.slice(0, 40)) say(`  ${c("1", short(k.sha))}  ${ago(k.time).padEnd(15)} ${k.subject}`);
    say("");
  }
  if (inv.unreachable.length) {
    say(`Commits nothing points to any more (${inv.unreachable.length}; stashes look like "WIP on ..."):`);
    for (const k of inv.unreachable.slice(0, 40)) say(`  ${c("1", short(k.sha))}  ${ago(k.time).padEnd(15)} ${k.subject}`);
    say("");
  }
  if (inv.staged.length) {
    say(`Files you staged and never committed (${inv.staged.length}; git keeps the contents, not the names):`);
    for (const s of inv.staged.slice(0, 40)) say(`  ${c("1", short(s.sha))}  ${(s.time ? ago(s.time) : "").padEnd(15)} ${String(s.size).padStart(7)} B  ${s.preview}`);
    say("");
  }
  say("Keep a commit: git branch rescued/name <id>   Save a file: git-rescue restore <id> <new-file>   Search: git-rescue find \"text\"");
  say(c("2", "git deletes what nothing points to after about two weeks (`git gc`); rescue it before then."));
  return 0;
}

/** @param {string} cwd @param {{top: string, gitDir: string, commonDir: string}} repo @param {{list: boolean, dry: boolean, yes: boolean}} o */
async function undoCommand(cwd, repo, o) {
  const all = backups(repo);
  if (o.list) {
    if (!all.length) return say("git-rescue has made no backups here."), 0;
    for (const b of all) say(`  ${b.stamp}  before: ${b.label}${b.worktree ? " (with uncommitted changes)" : ""}`);
    return 0;
  }
  const b = all[0];
  if (!b) return say("git-rescue has changed nothing here, so there is nothing to undo."), 0;
  const plan = undoSteps(cwd, b);
  say(`Back to before "${b.label}" (${b.stamp}):`);
  if (!plan.steps.length) say("   every branch and HEAD are already where they were.");
  for (const s of plan.steps) say(`   ${shown(s)}`);
  if (plan.created.length) say(c("2", `   (left as they are: branches made since: ${plan.created.join(", ")}; delete them with git branch -d if you like)`));
  if (plan.restoreWorktree) say(c("2", `   Your uncommitted changes from then are saved too: ${shown(plan.restoreWorktree[0])} brings them back.`));
  if (o.dry || !plan.steps.length) return 0;
  if (!o.yes) {
    if (!process.stdin.isTTY) return err("not run: add --yes, or run it in a terminal"), 2;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = (await rl.question("Go ahead? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (ok !== "y" && ok !== "yes") return say("Nothing changed."), 1;
  }
  backup(cwd, repo, `undo of ${b.stamp}`);
  return runSteps(cwd, repo, plan.steps);
}

/** @param {string} s */
function say(s) {
  process.stdout.write(s + "\n");
}

/** @param {string} s */
function err(s) {
  process.stderr.write(`git-rescue: ${s}\n`);
}
