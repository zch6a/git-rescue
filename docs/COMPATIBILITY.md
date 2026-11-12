# What 1.x keeps stable

git-rescue follows semantic versioning from 1.0.0. Within 1.x, what is listed here keeps working as described,
so scripts and people can rely on it. Anything that changes it goes into 2.0, with a note in the
[changelog](../CHANGELOG.md).

## Stable

**Commands and options.** `git-rescue` (the report), `timeline [-n N]`, `lost`, `find TEXT [-i]`,
`restore ID FILE`, `undo [--list] [STAMP]`, `fix N[a]` and `fix KEY[/a]`; `-C PATH`, `--json`, `--dry-run`,
`--yes`, `--`, `-h`/`--help`, `--version`. New commands and options may be added.

**Exit status.**

| Command | 0 | 1 | 2 |
|---|---|---|---|
| report | nothing, or only information | a problem or a warning | could not run |
| `fix` | done, or a dry run | you said no, a step failed, or the next step is yours | could not run, no such finding, no answer allowed (`--yes` missing without a terminal) |
| `undo` | done, nothing to undo, or a dry run | you said no, or a step failed | could not run, no such backup, another worktree, no answer allowed |
| `find` | found | no match | could not run |
| `lost`, `timeline`, `restore` | ran | | could not run |

**`--json`.** Every command prints one object with `format` (1) and `version`. Within format 1, fields are not
removed and do not change meaning; new fields may appear, so read the ones you know and ignore the rest.

- Report: `{format, version, state, findings}`. `state` has `branch`, `headSha`, `unborn`, `bare`, `operation`,
  `conflicted`, `changed`, `untracked`, `lockAge`, `superproject`, `submodules`. Each finding has `id`, `key`,
  `level` (`problem`, `warning`, `info`), `title`, `detail`, `options`, and `commits` when it is about commits.
  Each option has `title`, `risk` (`safe`, `careful`, `manual`), `steps`, and `note` when there is one.
- A step is git's arguments as a list; a step of one string with a space in it is something the person does;
  `[":remove-index-lock"]` is done by git-rescue.
- `timeline`: `{format, version, events}`; `lost`: `{format, version, reflogOnly, unreachable, staged}`;
  `find`: `{format, version, text, matches}`; `undo --list`: `{format, version, backups}`.

**Finding ids.** `rebase-in-progress`, `am-in-progress`, `merge-in-progress`, `cherry-pick-in-progress`,
`revert-in-progress`, `bisect-in-progress`, `index-lock`, `detached`, `detached-with-commits`,
`left-on-detached-head`, `left-behind-on-branch`, `deleted-branch`, `dropped-by-reset`, `dropped-by-rebase`,
`dropped-by-amend`, `dropped-by-pull`, `dropped-by-branch`, `dropped-by-checkout`, `dropped-by-move`,
`dropped-stash`, `lost-staged-files`, `unreachable-commits`, `gc-running`, `upstream-rewritten`. New ids may be
added. A key is the id, then `:` and the first commit's 8-character id when the finding is about commits, then
`-2`, `-3` ... if the same key comes up more than once.

**Backups.** Refs under `refs/rescue/<stamp>/` (`heads/<branch>`, `HEAD`, `worktree`), the record in
`.git/rescue.log` (one JSON object per line), and copies under `.git/rescue-files/<stamp>/`. `undo` in any 1.x
reads the backups any earlier 1.x made (0.x backups too).

**Requirements.** git 2.17 or later (CI runs 2.17.0 and current git), Node 18 or later, on Windows, macOS and
Linux. No runtime dependencies. Raising the oldest supported git or Node is a 2.0 change.

**Promises about what it does.** It changes nothing without a yes (or `--yes`); it backs up before every change;
it never pushes, never fetches, and never sends anything anywhere; `restore` never overwrites a file.

## Not promised

- The wording of the report, the order of findings within a level, titles and details: they are for people and
  get better. Scripts should read `--json`.
- The exact commands an option proposes, and the names of rescue branches (`rescued/...`): what they achieve is
  described by the option's title.
- What counts as lost at the edges: when git-rescue learns that something reported was not a loss (or the
  reverse), it changes in a 1.x release, with a test and a changelog entry.
