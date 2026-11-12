# Changelog

## 1.1.0 — 2026-11-12

- An Agent Skill and a Claude Code plugin: `/plugin marketplace add zch6a/git-rescue`, then
  `/plugin install git-rescue@git-rescue`. The skill has the assistant diagnose first (and not run `gc`, `prune`
  or `reset` before), explain what is at stake, and apply a fix only after the user agrees, by the finding's key.
  A test runs every command the skill gives on a staged accident.
- README: an animated demo made from real output, and a first screen that says why.

## 1.0.0 — 2026-11-12

- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md): what 1.x keeps stable (commands, exit codes per command,
  `--json` format 1, finding ids and keys, backups, git 2.17+ and Node 18+), and what it does not promise.
  Tests hold the list of finding ids and the exit codes to it.
- Backups made by 0.1 (no worktree in the record) are listed and undoable again; the stricter check of the
  record in 0.4 had left them out.
- Abandoning an operation with no file in conflict says the uncommitted changes go into the backup's snapshot
  (they are copied to `.git/rescue-files/` only when in conflict, as before).
- The code of the findings is split by subject (`src/findings/`); nothing else changed in behaviour.
- The package includes `docs/`.

## 0.4.0 — 2026-11-12

A second independent review found 22 problems; all are fixed, each with a test.

- No false alarm for squash and fixup rebases, a rebase followed by switching branch, the middle of a rebase,
  a squash merge, a pull request squash-merged on the server and pruned, or an old rebase of another branch:
  lost commits whose changes are all in a branch (local or remote-tracking) or HEAD are not reported.
- Now found: a dropped `stash -u` holding only new files; files staged in a repository with no commits yet;
  an upstream force-pushed twice; commits left on a branch that was deleted and made again (said as such,
  not as a detached HEAD).
- `fix KEY[/a]`: findings have a `key` in `--json` that does not change after a fix; a stale key is refused.
- `undo STAMP` undoes an earlier fix; `undo --list --json`. Undo after abandoning a rebase or merge leaves
  HEAD where it is instead of on a commit from the middle of it.
- Backups: stamps to the millisecond and never reused (two in one second lost the first); a submodule with
  changes no longer stops the backup; a hand-edited `rescue.log` line is ignored, not handed to git.
- A branch checked out in another worktree is not offered a `checkout` that cannot work.
- `git am` with a patch that does not apply: "finish it" says to apply it by hand (`git apply --reject`).
- Exit codes: an option that starts with you exits 1; documented per command. Run from a subfolder, the
  report says the commands are for the top folder, and fixes run there.
- The backup message names a locked index instead of conflicts when that is the cause; a stray quote in the
  no-reflog finding's text.
- CI also runs on git 2.17.0, built from source.

## 0.3.0 — 2026-11-12

- New finding: commits that nothing points to, not even the reflog (an expired reflog; a bare repository after
  a force push, since bare repositories keep no reflog). Commits whose changes are already on HEAD are left out.
- New finding: `git gc` running (a recent `gc.pid`), a warning when there is something to rescue.
- An answer typed ahead in the menu is kept (before, "1a", Enter, "y", Enter typed quickly lost the "y" and
  git-rescue waited forever); the end of the input is a no, said as such, instead of a silent exit 0.
- On a detached HEAD, "Go back to ..." could offer `git checkout "(HEAD detached at ...)"`: git 2.19's
  `branch --contains` lists that line among the branches.
- `restore` of a commit followed the user's config (colour codes in the file with `color.ui=always`, one line
  with `format.pretty=oneline`, an external diff tool); now git's own full format.
- `restore ID FILE` writes FILE relative to where you are, also with `-C`.
- A branch moved by `checkout -B` is said as "`branch -f` or `checkout -B`": git writes the same reflog message
  for both.

## 0.2.0 — 2026-11-12

- The report names what is at stake: the commits that fell off (id and subject), the files a dropped stash
  changed, a preview of the newest lost staged files. Long lines wrap to the terminal.
- `--json` output carries `format` (1) and `version`, and every command returns an object; the format is
  described in the README and kept stable.
- Submodules: a submodule's detached HEAD at the commit its parent records is not a problem; the parent
  repository names its submodules, each checked on its own.
- `timeline` knows more of git's reflog messages, old and new, and explains a reset to HEAD (what `git stash`
  and `reset --hard` leave). Passwords and tokens in URLs (`clone: from https://user:token@...`) are hidden.
- A popped stash was reported as dropped when git-rescue ran in a subfolder.
- Command-line mistakes are named: a missing folder after `-C`, an unknown option, a bad `-n`; `--` ends the
  options.
- Faster on big repositories: answers git gives once are kept for the command, a stash is checked in three
  git calls instead of three per file, and lost contents are read once.

## 0.1.0 — 2026-11-12

First version: the report and its fixes, backups and `undo`, `timeline`, `lost`, `find`, `restore`.
Polishing round 1 fixed what an independent review found (see POLISH_LOG.md).
