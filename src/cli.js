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

import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { backup, backups, recordAfter, undoSteps } from "./backup.js";
import { diagnose } from "./diagnose.js";
import { REMOVE_LOCK, isInstruction } from "./state.js";
import { ago } from "./words.js";
import { GitError, git, gitRun, repoAt, short, version } from "./git.js";
import { find, inventory, restore } from "./lost.js";
import { line, timeline } from "./timeline.js";

const VERSION = "1.0.0";
/** The shape of --json output; it goes up only when a field is removed or changes meaning (see README). */
const JSON_FORMAT = 1;
const HELP = `git-rescue ${VERSION}: what just happened to my repository, and how do I get my work back?

  git-rescue                  what is wrong here, and the ways back (asks before doing anything)
  git-rescue timeline [-n N]  what happened recently, in words
  git-rescue lost             everything git can still give back: commits no branch has, dropped
                              stashes, files you staged and never committed
  git-rescue find TEXT [-i]   search lost work for TEXT (-i: ignore case)
  git-rescue restore ID FILE  save a lost file (or a lost commit's diff) to a new FILE
  git-rescue undo [--list]    undo what git-rescue last did (or list its backups); undo again redoes it
  git-rescue undo STAMP       undo an earlier fix, by the stamp undo --list shows

  git-rescue fix N[a]         apply option a of problem N without the menu (with --yes: without asking)
  git-rescue fix KEY[/a]      the same by the finding's key from --json, which does not change after a fix

Options: -C PATH (the repository; default: here), --dry-run (show, change nothing), --json (for
scripts; the format is described in the README), --yes (do not ask), -h, --version.

Exit status: 0 nothing wrong, or done; 1 something to look at (report: a problem or a warning; find: no
match; fix: you said no, or it is your turn); 2 could not run. lost and timeline exit 0 when they ran.

It changes nothing without asking. Before any change it saves every branch, HEAD and your uncommitted
changes under refs/rescue/, so that \`git-rescue undo\` can put them back.`;

const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (/** @type {string} */ code, /** @type {string} */ s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const LEVEL = { problem: c("1;31", "✗"), warning: c("1;33", "!"), info: c("2", "·") };
const RISK = { safe: c("32", "safe"), careful: c("33", "careful"), manual: c("36", "you do it") };

/**
 * Text wrapped to the terminal (at most 100 columns, for reading), each line indented by `pad`; lines that start
 * with spaces (lists of commits or files) are kept as they are.
 * @param {string} text @param {string} pad
 */
function block(text, pad) {
  const width = Math.max(60, Math.min(process.stdout.columns || 100, 100)) - pad.length;
  const out = [];
  for (const para of text.split("\n")) {
    if (/^\s/.test(para) || para.length <= width) { out.push(pad + para); continue; }
    let lineText = "";
    for (const word of para.split(" ")) {
      if (lineText && lineText.length + 1 + word.length > width) { out.push(pad + lineText); lineText = word; }
      else lineText = lineText ? `${lineText} ${word}` : word;
    }
    if (lineText) out.push(pad + lineText);
  }
  return out.join("\n");
}

/**
 * @typedef {{ask: (prompt: string) => Promise<string | null>, close: () => void}} Asker
 */

/**
 * Questions to the person at the terminal. Lines typed before a question is asked wait for it (with readline's
 * own question(), "1a", Enter, "y", Enter typed quickly lost the "y" and git-rescue waited forever); the end of
 * the input is no answer (null), which is never a yes.
 * @returns {Asker}
 */
function asker() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  /** @type {string[]} */
  const lines = [];
  /** @type {((line: string | null) => void) | null} */
  let waiting = null;
  let closed = false;
  rl.on("line", (l) => {
    if (waiting) { const w = waiting; waiting = null; w(l); } else lines.push(l);
  });
  rl.on("close", () => {
    closed = true;
    if (waiting) { const w = waiting; waiting = null; w(null); }
  });
  return {
    ask(prompt) {
      process.stdout.write(prompt);
      if (lines.length) return Promise.resolve(/** @type {string} */ (lines.shift()));
      if (closed) return Promise.resolve(null);
      return new Promise((r) => { waiting = r; });
    },
    close: () => rl.close(),
  };
}

/** A yes to "Go ahead? [y/N]". @param {string | null} answer */
const isYes = (answer) => /^(y|yes)$/i.test((answer ?? "").trim());

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
  /** An option's value; given twice, the last one counts. @param {string} f @returns {string | null} */
  const value = (f) => {
    let v = null;
    for (let i = args.indexOf(f); i >= 0; i = args.indexOf(f)) {
      v = args[i + 1] ?? "";
      args.splice(i, 2);
    }
    return v;
  };
  if (flag("--help") || flag("-h")) return say(HELP), 0;
  if (flag("--version")) return say(`git-rescue ${VERSION}`), 0;
  const hasC = args.includes("-C");
  const cwd = value("-C") ?? process.cwd();
  if (hasC && (!cwd || cwd.startsWith("-"))) return err("-C needs a folder: git-rescue -C path/to/repository"), 2;
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return err(`there is no folder ${cwd}`), 2;
  const json = flag("--json");
  const dry = flag("--dry-run");
  const yes = flag("--yes");
  const ignoreCase = flag("-i");
  const n = value("-n");
  const limit = n === null ? 30 : Number(n);
  if (!Number.isInteger(limit) || limit < 1) return err(`-n takes a number of events, like -n 50`), 2;
  const list = flag("--list");
  // After --, nothing is an option: git-rescue find -- "-x" searches for "-x".
  const dashes = args.indexOf("--");
  const unknown = args.slice(0, dashes < 0 ? undefined : dashes).find((a) => /^-./.test(a));
  if (unknown) return err(`unknown option ${unknown} (see git-rescue --help)`), 2;
  if (dashes >= 0) args.splice(dashes, 1);
  const [cmd = "", ...rest] = args;

  try {
    const repo = repoAt(cwd);
    if (!repo) return err(`${cwd} is not inside a git repository`), 2;
    const [major, minor] = version(cwd);
    if (major < 2 || (major === 2 && minor < 17)) err(`git ${major}.${minor} is old; git-rescue is tested with 2.17 and later`);

    if (cmd === "timeline") {
      const events = timeline(repo, limit);
      if (json) return say(JSON.stringify({ format: JSON_FORMAT, version: VERSION, events }, null, 2)), 0;
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
      if (json) return say(JSON.stringify({ format: JSON_FORMAT, version: VERSION, text, matches }, null, 2)), matches.length ? 0 : 1;
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
    if (cmd === "undo") return await undoCommand(cwd, repo, { list, dry, yes, json, stamp: rest[0] ?? null });
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
  if (o.json) return say(JSON.stringify({ format: JSON_FORMAT, version: VERSION, state, findings }, null, 2)), findings.some((f) => f.level !== "info") ? 1 : 0;
  const where = state.bare ? "a bare repository (no working tree)" : state.unborn ? "no commits yet" : state.branch ? `on ${state.branch}` : `HEAD detached at ${short(state.headSha ?? "")}`;
  const changes = state.bare ? "" : state.changed || state.untracked ? `, ${state.changed} changed and ${state.untracked} untracked files` : ", nothing uncommitted";
  say(`${repo.top}: ${where}${changes}`);
  if (state.superproject) say(c("2", `(a submodule of ${state.superproject}; that repository is checked separately)`));
  if (state.submodules.length) {
    const [first] = state.submodules;
    say(c("2", state.submodules.length === 1
      ? `(${first} is a submodule, a repository of its own: git-rescue -C ${first} checks it)`
      : `(${state.submodules.length} submodules, each a repository of its own, such as ${state.submodules.slice(0, 3).join(", ")}: git-rescue -C ${first} checks one)`));
  }
  const prefix = state.bare ? "" : git(cwd, ["rev-parse", "--show-prefix"], { allowFail: true }).trim();
  if (prefix && findings.some((f) => f.options.length)) say(c("2", `(you are in ${prefix}: run the commands from the top folder, ${repo.top})`));
  say("");
  if (!findings.length) {
    say("Nothing looks wrong. (`git-rescue timeline` shows what happened; `git-rescue lost` what git can still give back.)");
    return 0;
  }
  findings.forEach((f, i) => {
    say(`${LEVEL[f.level]} ${c("1", `${i + 1}.`)} ${f.title}`);
    if (f.detail) say(block(f.detail, "     "));
    f.options.forEach((opt, k) => {
      say(`     ${String.fromCharCode(97 + k)}) ${opt.title}  [${RISK[opt.risk]}]`);
      for (const s of opt.steps) say(`          ${shown(s)}`);
      if (opt.note) say(c("2", block(opt.note, "          ")));
    });
    say("");
  });
  const fixable = findings.some((f) => f.options.length);
  if (!fixable || o.dry || !process.stdin.isTTY) {
    if (fixable) say("To apply one: git-rescue fix N[a]  (for example fix 1a); nothing has been changed.");
    return findings.some((f) => f.level !== "info") ? 1 : 0;
  }
  const rl = asker();
  try {
    const answer = ((await rl.ask("Fix one? Type its number and letter (like 1a), or press Enter to leave everything as it is: ")) ?? "").trim();
    if (!answer) return say("\nNothing changed."), 1;
    return await apply(cwd, repo, findings, answer, { dry: false, yes: false, rl });
  } finally {
    rl.close();
  }
}

/** @param {string} cwd @param {{top: string, gitDir: string, commonDir: string}} repo @param {string} pick @param {{dry: boolean, yes: boolean}} o */
async function fixCommand(cwd, repo, pick, o) {
  if (!pick) return err("fix what? git-rescue fix N[a] (the numbers git-rescue shows), or fix KEY[/a] (the key from --json)"), 2;
  const { findings } = diagnose(cwd, repo);
  if (o.yes || o.dry || !process.stdin.isTTY) return apply(cwd, repo, findings, pick, { ...o, rl: null });
  const rl = asker();
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
 * @param {{dry: boolean, yes: boolean, rl: Asker | null}} o
 */
async function apply(cwd, repo, findings, pick, o) {
  // By number (as shown; numbers change after each fix) or by key (from --json; it names the same finding or none).
  const byNumber = pick.match(/^(\d+)([a-z]?)$/i);
  const byKey = byNumber ? null : pick.match(/^([a-z][a-z-]*(?::[0-9a-f]{8})?(?:-\d+)?)(?:\/([a-z]))?$/i);
  let f;
  if (byNumber) {
    f = findings[Number(byNumber[1]) - 1];
    if (!f) return err(`"${pick}" is not one of the problems listed (1 to ${findings.length})`), 2;
  } else if (byKey) {
    f = findings.find((x) => x.key === byKey[1]);
    if (!f) return err(`${byKey[1]} is no longer there: it may have been fixed, or the repository changed. Run git-rescue again.`), 2;
  } else return err(`"${pick}" is neither a number like 1a nor a key from --json like dropped-by-reset:1a2b3c4d/a`), 2;
  const letter = (byNumber ?? byKey)?.[2];
  const opt = f.options[letter ? letter.toLowerCase().charCodeAt(0) - 97 : 0];
  if (!opt) return err(f.options.length ? `that problem has options a to ${String.fromCharCode(96 + f.options.length)}` : "that one has nothing to run"), 2;
  say(`\n${f.title}\n→ ${opt.title}\n`);
  for (const s of opt.steps) say(`   ${shown(s)}`);
  if (o.dry) return say("\n(dry run: nothing changed)"), 0;
  if (isInstruction(opt.steps[0])) {
    // It starts with something only you can do: nothing to run or back up yet.
    say(`\nThis one starts with you: ${opt.steps[0][0]}. Then run the commands after it yourself.`);
    return 1;
  }
  if (!o.yes) {
    if (!o.rl) return err("not run: add --yes to apply without being asked, or run it in a terminal"), 2;
    const ok = await o.rl.ask(`\nA backup of every branch and your uncommitted changes is made first. Go ahead? [y/N] `);
    if (!isYes(ok)) return say(ok === null ? "\nNo answer: nothing changed." : "Nothing changed."), 1;
  }
  const b = backup(cwd, repo, opt.title);
  say(c("2", `   (backup: refs/rescue/${b.stamp}; \`git-rescue undo\` puts back what this changes)`));
  if (b.files) {
    const why = existsSync(join(repo.gitDir, "index.lock")) ? "git cannot snapshot your changes while .git/index.lock is there" : "git cannot snapshot files in conflict";
    say(c("33", `   (${why}: your changed files are copied as they are to ${b.files})`));
  }
  if (b.notCopied) say(c("33", `   (not copied: ${b.notCopied.join(", ")})`));
  try {
    const code = runSteps(cwd, repo, opt.steps);
    if (code === 0 && findings.length > 1) say(c("2", "The numbers of the other problems may have changed: run git-rescue again before the next fix."));
    return code;
  } finally {
    recordAfter(cwd, repo, b.stamp);
  }
}

/**
 * Runs the steps from the top folder (paths in them are relative to it), stopping at the first that fails.
 * @param {string} cwd @param {{gitDir: string, top: string, bare?: boolean}} repo @param {string[][]} steps
 */
function runSteps(cwd, repo, steps) {
  const at = repo.bare || !repo.top ? cwd : repo.top;
  for (const s of steps) {
    if (isInstruction(s)) {
      say(`\nNow it is your turn: ${s[0]}. Then run the remaining steps:`);
      for (const r of steps.slice(steps.indexOf(s) + 1)) say(`   ${shown(r)}`);
      return 1;
    }
    if (s[0] === REMOVE_LOCK) {
      unlinkSync(join(repo.gitDir, "index.lock"));
      say(`   ✓ ${shown(s)}`);
      continue;
    }
    const r = gitRun(at, s);
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
  if (json) return say(JSON.stringify({ format: JSON_FORMAT, version: VERSION, ...inv }, null, 2)), 0;
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

/**
 * Undoes the last fix (an undo is a fix too: undo twice redoes), or the one with this stamp.
 * @param {string} cwd @param {{top: string, gitDir: string, commonDir: string}} repo
 * @param {{list: boolean, dry: boolean, yes: boolean, json: boolean, stamp: string | null}} o
 */
async function undoCommand(cwd, repo, o) {
  const all = backups(repo);
  if (o.list) {
    if (o.json) return say(JSON.stringify({ format: JSON_FORMAT, version: VERSION, backups: all }, null, 2)), 0;
    if (!all.length) return say("git-rescue has made no backups here."), 0;
    for (const b of all) say(`  ${b.stamp}  before: ${b.label}${b.worktree ? " (with uncommitted changes)" : ""}`);
    say(c("2", "git-rescue undo STAMP undoes one of them; the newest is what undo alone undoes."));
    return 0;
  }
  const b = o.stamp ? all.find((x) => x.stamp === o.stamp) : all[0];
  if (o.stamp && !b) return err(`no backup ${o.stamp} (git-rescue undo --list shows them)`), 2;
  if (!b) return say("git-rescue has changed nothing here, so there is nothing to undo."), 0;
  const norm = (/** @type {string} */ p) => p.replace(/\\/g, "/").toLowerCase();
  if (b.top && norm(b.top) !== norm(repo.top)) {
    return err(`the last fix was made in ${b.top}; run git-rescue undo there (this is another worktree of the same repository)`), 2;
  }
  const plan = undoSteps(cwd, b);
  say(`Undo "${b.label}" (${b.stamp}):`);
  if (!plan.steps.length) say("   nothing to put back: the fix changed no branch or HEAD, or they moved since.");
  for (const s of plan.steps) say(`   ${shown(s)}`);
  if (plan.skipped.length) say(c("33", `   Left as they are: ${plan.skipped.join("; ")}.`));
  if (plan.restoreWorktree) say(c("2", `   Your uncommitted changes from before the fix are saved too: ${shown(plan.restoreWorktree[0])} brings them back.`));
  if (plan.files) say(c("2", `   Your changed files from before the fix are copied in ${plan.files}.`));
  if (o.dry || !plan.steps.length) return 0;
  if (!o.yes) {
    if (!process.stdin.isTTY) return err("not run: add --yes, or run it in a terminal"), 2;
    const rl = asker();
    const ok = await rl.ask("Go ahead? [y/N] ");
    rl.close();
    if (!isYes(ok)) return say(ok === null ? "\nNo answer: nothing changed." : "Nothing changed."), 1;
  }
  const mine = backup(cwd, repo, `undo of ${b.stamp}`);
  try {
    return runSteps(cwd, repo, plan.steps);
  } finally {
    recordAfter(cwd, repo, mine.stamp);
  }
}

/** @param {string} s */
function say(s) {
  process.stdout.write(s + "\n");
}

/** @param {string} s */
function err(s) {
  process.stderr.write(`git-rescue: ${s}\n`);
}
