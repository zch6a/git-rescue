# Changelog

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
