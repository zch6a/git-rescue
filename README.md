<div align="center">

# git-rescue

### Messed up git? Get your work back.

One command reads your repository and says what went wrong, in plain words, with the exact commands that fix
it. It backs up everything before it changes anything, and `git-rescue undo` puts back what a fix changed. It finds
what the reflog cannot: files you staged and lost to `reset --hard`, and stashes you dropped.

<a href="https://github.com/zch6a/git-rescue/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/zch6a/git-rescue/actions/workflows/ci.yml/badge.svg"></a>
<img alt="Node 18+" src="https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white">
<img alt="git 2.17+" src="https://img.shields.io/badge/git-2.17%2B-f05032?logo=git&logoColor=white">
<img alt="No dependencies" src="https://img.shields.io/badge/dependencies-none-2ea44f">
<a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>

**English** · [简体中文](README.zh-CN.md)

<br>

<img src="docs/demo.svg" width="860" alt="git-rescue after a reset --hard: it finds the two lost commits and a lost staged file, keeps the commits on a branch with one command, and finds the file by its text">

</div>

```bash
npx github:zch6a/git-rescue        # run it in the repository that is in trouble; it changes nothing until you say yes
```

## Why git-rescue

- **It reads what happened, not guesses.** Each finding is a fact about your repository (a reflog entry, a file
  git left mid-rebase, an object nothing points to), with the commits it concerns and their subjects.
- **It finds what the reflog cannot.** `git add` saved a copy of every file you staged; after `reset --hard` or
  `checkout .`, git still has them for about two weeks. Dropped stashes too. `git-rescue find "some text"` searches
  all of it.
- **It is safe to try.** Nothing changes until you pick an option and say yes; every branch, HEAD and your
  uncommitted work are backed up first; `git-rescue undo` puts back exactly what the fix changed. Tested by
  running every option of every finding and undoing it, on git 2.17 to today's, on Windows, macOS and Linux.
- **It is quiet on ordinary days.** A rebase, a squash, a `stash pop`, a squash merge: none of these is a loss,
  and none is reported as one. Two independent reviews hunted for false alarms.

## Let your AI coding assistant do it

git-rescue comes with an Agent Skill. In Claude Code:

```text
/plugin marketplace add zch6a/git-rescue
/plugin install git-rescue@git-rescue
```

Then say what happened ("I ran reset --hard by mistake", "my rebase is stuck", "where did my stash go"). The
assistant runs git-rescue, tells you what it found and what is at stake, and applies a fix only after you agree to
that option, by the finding's stable key, with git-rescue's backup and `undo`. The skill also tells it not to run
`gc`, `prune` or `reset` before the diagnosis, so the evidence survives. Assistants that read Agent Skills from a
folder: copy [`plugin/skills/git-rescue`](plugin/skills/git-rescue/SKILL.md) into theirs (for Claude Code,
`~/.claude/skills/`).

## What it finds

It reads the repository's state, not timing guesses: each finding is something that is the case, with the
commits it concerns.

- **An operation stopped halfway**: a rebase, `am`, merge, cherry-pick or revert waiting on conflicts (which
  files), a bisect left running. Options: abandon it (back to before; an abort resets your files, so your
  edits so far are saved first, copied to `.git/rescue-files/` when they are in conflict), or finish it.
- **A stale `.git/index.lock`** that makes git refuse everything.
- **Commits on no branch**: a detached HEAD with commits, or commits left behind when you switched away from
  one or reset while on it, or that were on a branch when you left it and are on none now.
- **Commits that fell off a branch**, whatever moved it: a `reset`, a `branch -f` or `checkout -B`, a forced
  pull, a rebase that dropped a commit, an amend that changed the content (as information). A rebase,
  squash, fixup or amend that kept the changes is not a loss: commits are compared by their changes, not
  their ids, and lost commits whose changes are all in a branch (local or remote) are left out.
- **A deleted branch** whose commits no other branch has (merged branches, squash merges included, are not
  reported).
- **A dropped stash** (`stash drop`, `stash clear`; with `stash -u`, its new files too) whose changes are not
  in your files or commits: back onto the stash list. (A `stash pop` drops the stash too, after applying it:
  that is not reported.)
- **Files you staged and never committed**, lost to `reset --hard` or `checkout .`: the reflog cannot see
  these; git still has their contents until `git gc` prunes them (about two weeks). Shown as information,
  since adding a file, editing it and adding it again leaves the first version behind too.
- **Commits that nothing points to, not even the reflog**: the reflog entries expired, or the repository
  keeps no reflog, as a bare repository on a server does (a force push leaves the old commits like this).
  Commits whose changes are already on the branch (an old rebase) are left out.
- **`git gc` at work**: it deletes what nothing points to once it is two weeks old; git-rescue says to let it
  finish before saving anything.
- **An upstream someone force-pushed**: your branch still has the old history, and pulling would merge it
  back in; the option replays only your own commits onto the new one.

Each finding names what is at stake: the commits (id and subject), the files a stash changed, the first line
of a lost file. In a submodule, a HEAD detached at the commit the parent repository records is how git leaves
it, not a problem; a parent repository names its submodules, which are checked on their own (`-C lib`).

## Use

```bash
git-rescue                  # what is wrong here; pick a fix (it asks before changing anything)
git-rescue timeline         # what happened recently, in words, with where things were before each step
git-rescue lost             # everything git can still give back
git-rescue find "some text" # search lost work: staged files, the files of lost commits, their messages
git-rescue restore ID FILE  # save a lost file (or a lost commit's diff) to a new file; never overwrites
git-rescue undo             # undo what git-rescue last did (undo again redoes it)
git-rescue undo STAMP       # undo an earlier fix (git-rescue undo --list shows them)
git-rescue fix 1a --yes     # apply option a of problem 1 without the menu
git-rescue fix KEY/a --yes  # the same by the finding's key from --json: for scripts, see below
git-rescue --dry-run        # show, change nothing;  --json for scripts;  -C path for another folder
```

Install the command with `npm install -g github:zch6a/git-rescue`, or run it once with `npx` as above.
It needs Node 18+ and git 2.17 or later (tested with 2.17 and 2.19, from 2018, and the current one).

## For scripts: `--json`

Every command takes `--json` and prints one object. `format` is 1: it goes up only if a field is removed or
changes meaning; new fields can appear in a 1. [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) lists everything
1.x keeps stable.

Exit status: 0 nothing wrong, or done; 1 something to look at (the report: a problem or a warning; `find`:
no match; `fix` and `undo`: you said no, or the next step is yours); 2 could not run. `lost` and `timeline`
exit 0 when they ran.

Numbers change after each fix (fixing 1 makes 2 the new 1). A script should pick a finding by its `key`
instead: `git-rescue fix dropped-by-reset:39f66d49/a --yes` applies option a of that finding, or refuses
(exit 2) if it is no longer there.

```jsonc
// git-rescue --json
{
  "format": 1, "version": "1.1.0",
  "state": { "branch": "main", "headSha": "…", "unborn": false, "bare": false, "operation": null,
             "conflicted": [], "changed": 0, "untracked": 0, "lockAge": null,
             "superproject": null, "submodules": [] },
  "findings": [{
    "id": "dropped-by-reset",            // what kind of finding; the ids are listed in src/diagnose.js
    "key": "dropped-by-reset:39f66d49",  // this finding: the kind and its first commit, for fix KEY/a
    "level": "warning",                   // "problem", "warning" or "info"
    "title": "2 commits fell off main with a reset (moving to HEAD~2) just now",
    "detail": "…",
    "commits": ["39f66d49…", "3b48736b…"],
    "options": [{ "title": "Keep them on a new branch …", "risk": "safe",   // "safe", "careful", "manual"
                  "steps": [["branch", "rescued/main-before-reset-39f66d49", "39f66d49…"]] }]
  }]
}
```

A step is git's arguments; a step of one string with spaces in it is something the user does, and
`[":remove-index-lock"]` is done by git-rescue. `timeline --json` prints `{format, version, events}`,
`lost --json` `{format, version, reflogOnly, unreachable, staged}`, `find --json` `{format, version, text,
matches}`, `undo --list --json` `{format, version, backups}`.

## Safe to run

- **It changes nothing without asking.** The report and `timeline`, `lost` and `find` only read. A fix
  shows its exact git commands first and runs them only after you say yes (or with `--yes`).
- **Before any fix it backs up** every branch, HEAD and your uncommitted changes (as `git stash` would,
  without touching your files) under `refs/rescue/<time>/`, plain refs that `git gc` keeps and plain git
  can read; while files are in conflict, when git cannot make that snapshot, it copies the changed files
  to `.git/rescue-files/<time>/` instead. `git-rescue undo` puts back what the fix changed (a branch it moved,
  made or deleted, and HEAD), leaves alone anything that moved since, and offers your saved changes
  again. After abandoning a rebase or merge, undo leaves HEAD where it is: the operation cannot be resumed,
  and your edits from it are in `.git/rescue-files/`. Untracked files are not saved; no fix touches them.
  The backup record is checked before undo uses it: a line that is not as git-rescue wrote it is ignored.
- **Options are rated**: *safe* (nothing that a plain git command cannot undo), *careful* (moves a branch
  or your files; backed up first), *you do it* (resolving a conflict).
- `restore` writes only to a new file name.
- Local only: no network, no telemetry, no dependencies.

## What it does not do

- It cannot bring back what git never had: changes you never added or committed, before a
  `checkout .` or `reset --hard`. (Your editor's local history may have them.)
- After `git gc` has pruned them (objects no reflog reaches: about two weeks; reflog entries: 30 to 90
  days), lost commits and files are gone for good.
- It never pushes. If a fix changes commits you had already pushed, pushing them again needs
  `git push --force-with-lease`, which is yours to decide.

## Status

1.0 ([changes](CHANGELOG.md), [what 1.x keeps stable](docs/COMPATIBILITY.md), [contributing](CONTRIBUTING.md)).
Tested only with throwaway repositories made in the system's temp folder, never a real one:

- every kind of finding is staged for real, every option git-rescue runs is applied through the command, and
  then checked: the finding is gone, an uncommitted edit elsewhere survived, and `undo` puts every branch and
  HEAD back;
- the menu as a person uses it: a pick, a yes or no, Enter, an answer typed ahead, the input ending;
- edge cases: an expired reflog, a bare repository after a force push, a shallow clone, sparse checkout,
  submodules, worktrees, branch names with `/`, `#` and Chinese characters, a path with spaces, git config that
  changes git's output (`color.ui=always`, `format.pretty`, `diff.external`), and a repository with 30,000
  commits and 3,000 lost file versions (the report takes about 3 s on Windows);
- what two independent reviews found (routine, squash and fixup rebases, `stash pop`s and squash merges that
  are not losses, a dropped `stash -u`, files staged before the first commit, 900 reflog entries, non-ASCII
  file names, line endings).

On git 2.19 here, and in CI on git 2.17.0 (built from source) and the git of GitHub's Windows, macOS and Linux
runners.

## Develop

```bash
npm install
npm test            # node --test
npm run check       # type-check the JavaScript (JSDoc types, tsc)
```

## License

[MIT](LICENSE)
