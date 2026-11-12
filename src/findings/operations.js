// @ts-check
/** An operation left half done, a stale lock, and `git gc` at work. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { REMOVE_LOCK } from "../state.js";

/**
 * @typedef {import("../state.js").Finding} Finding
 * @typedef {import("../state.js").Option} Option
 * @typedef {import("../state.js").Repo} Repo
 * @typedef {import("../state.js").State} State
 */

/** @param {string} cwd @param {Repo} repo @param {State} st @param {(f: Finding) => void} add */
export function inProgress(cwd, repo, st, add) {
  const op = st.operation;
  if (!op) return;
  const files = st.conflicted.length ? `Files with conflicts: ${st.conflicted.join(", ")}.` : "No files are in conflict.";
  const resolveStep = st.conflicted.length
    ? [["edit the files with conflicts, keep what you want, and remove the <<<<<<< ======= >>>>>>> lines"], ["add", "--", ...st.conflicted]]
    : [];
  // An abort resets the files. git cannot snapshot files in conflict, so then git-rescue copies every changed file
  // before it; otherwise the backup's snapshot of uncommitted changes holds them.
  const copied = st.conflicted.length
    ? "Your edits so far (the files in conflict and any other changed file) are copied to .git/rescue-files/ first: an abort resets them."
    : "Your uncommitted changes are saved in the backup first (`git-rescue undo` offers them again): an abort resets them.";
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
export function staleLock(age, add) {
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

/**
 * `git gc` running now (or stopped in the middle): it deletes the objects nothing points to once they are two
 * weeks old, which is what git-rescue finds. git treats a gc.pid older than 12 hours as left over.
 * @param {Repo} repo @param {Finding[]} findings @param {(f: Finding) => void} add
 */
export function gcRunning(repo, findings, add) {
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
